// Semester plugin backend (bundled to dist/backend.cjs). Runs inside LearnHarness's server.
//   - Ask chats (per class or across all classes) answered through LearnHarness plugin conversations on the
//     Claude Code connection, with the API key as a capped fallback.
//   - Course search tools for those chats and, additively, for LearnHarness's own lessons.
//   - File actions (show a page, open, reveal) limited to the semester folder.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { checkCitations, courseTools, extractTurn, GRADED_RULE, instructions, isLimitError, moodleTool, refsInToolOutput, suggestDateTool } from './ask.mjs';
import { API_MODELS, askViaApi, describeApiError, makeLedger } from './fallback.mjs';
import { CLASSES, loadIndex, makeSearcher } from './search.mjs';
import { makeStore } from './store.mjs';
import { classOfSession, classProgressTool, classUpdatesTool, inferMode, makeTutorStore, MODES, newDocs, readOrganization, seenUpTo, sessionProgress, tutorOpening } from './tutors.mjs';
import { berlinToIso, DATE_KINDS, examOf, keyDates, makeDateStore } from './dates.mjs';
import { readSecret } from './lib/keychain.mjs';

const execFileP = promisify(execFile);
const DEFAULTS = { root: path.join(os.homedir(), 'Documents/TU Darmstadt/WiSe26-27'), model: 'sonnet', apiCapUsd: 20, apiFallback: true, graphQuestions: false };
const PROVIDER = 'claude-code';

export function activate(ctx) {
  const dataDir = ctx.dataDirectory;
  const settingsFile = path.join(dataDir, 'settings.json');
  const readSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
  let settings = readSettings();
  const store = makeStore(dataDir);
  store.settleInterrupted();
  const ledger = () => makeLedger(dataDir, Number(settings.apiCapUsd) || 0);

  // ---------- the index ----------
  let searcher = null, indexStamp = '', rawIndex = null;
  const indexFile = () => path.join(settings.root, 'Dashboard/index/out-semester/index.json.gz');
  function getSearcher() {
    const f = indexFile();
    let st;
    try { st = fs.statSync(f); } catch { throw new Error(`The Semester index is missing (${f}). Run: node Dashboard/index/build.mjs --semester`); }
    const stamp = `${st.size}:${st.mtimeMs}`;
    if (!searcher || stamp !== indexStamp) { rawIndex = loadIndex(f); searcher = makeSearcher(rawIndex); indexStamp = stamp; }
    return searcher;
  }
  const getIndex = () => { getSearcher(); return rawIndex; };
  const getIndexSafe = () => { try { return getIndex(); } catch { return null; } };

  // ---------- class tutors (LearnHarness sessions in a class folder) ----------
  const tutors = makeTutorStore(dataDir);
  const learningDir = ctx.learning?.directory;
  const sessionClass = (chatId) => (learningDir ? classOfSession(readOrganization(learningDir), chatId) : null);
  const sessionsById = () => new Map((ctx.learning?.listSessions?.() || []).map((s) => [s.id, s]));
  const getRecord = (id) => { try { return ctx.learning?.getSession?.(id) || null; } catch { return null; } };
  const classSessions = (cls) => {
    const org = learningDir ? readOrganization(learningDir) : null;
    return (ctx.learning?.listSessions?.() || []).filter((s) => classOfSession(org, s.id) === cls);
  };
  // ---------- key dates: pinned in Semester + TUCaN's calendar export (<semester>/TUCaN/*.ics) ----------
  const dateStore = makeDateStore(dataDir);
  const allDates = (cls = null) => { try { return keyDates({ store: dateStore, tucanDir: path.join(settings.root, 'TUCaN'), cls }); } catch { return []; } };

  // ---------- lessons: course tools + the graded rule, added to LearnHarness's own agents ----------
  ctx.registerInstructions({
    agents: ['prober', 'teacher', 'practice'],
    text: `The learner is a TU Darmstadt master's student. Their course files (slides, sheets, books) can be searched with
search_course and read with read_pages (view_page shows a page as an image: use it for slides that are pictures, never
say you can't read a slide); cite pages as (document title, p. N) when you use them, never as raw ids, and
follow the class's own notation. Knowledge-graph sources named "Q · …" are questions looked up in Semester, not things taught.
If a class_updates tool is available, this session is a class tutor: its description says which class and what for.
${GRADED_RULE}`,
  });
  // Per turn: a session in a class folder gets that class's tools and class_updates; any other session searches all classes.
  ctx.registerTools({
    agents: ['prober', 'teacher', 'practice'],
    // Never throws: a failing factory makes LearnHarness drop this plugin's whole contribution for the turn,
    // the graded rule included.
    create: (context) => {
      try {
        const chatId = context?.chatId;
        const cls = chatId ? sessionClass(chatId) : null;
        if (!cls) return courseTools(getSearcher, 'all', renderPage);
        try {
          const s = sessionsById().get(chatId);
          const n = tutors.get(chatId);
          if (!n) tutors.ensure(chatId, s?.createdAt, inferMode(s?.title, s?.kind));
          else if (n.auto === true && s && inferMode(s.title, s.kind) !== n.mode) tutors.set(chatId, { mode: inferMode(s.title, s.kind) });
        } catch { /* notes are optional */ }
        return [
          ...courseTools(getSearcher, cls, renderPage),
          classUpdatesTool({ cls, chatId, store: tutors, getIndex, root: settings.root, getRecord }),
          classProgressTool({ cls, chatId, store: tutors, getIndex, sessions: () => classSessions(cls), getRecord, dates: () => allDates(cls) }),
          moodleTool(readFeed, cls, () => allDates(cls)),
        ];
      } catch {
        return courseTools(getSearcher, 'all', renderPage);
      }
    },
  });

  // ---------- Ask: course search + Moodle deadlines ----------
  const readFeed = () => { try { return JSON.parse(fs.readFileSync(path.join(settings.root, 'Dashboard/watcher/feed.json'), 'utf8')); } catch { return null; } };
  const askTools = (scope) => [...courseTools(getSearcher, scope, renderPage), moodleTool(readFeed, scope, () => allDates()), suggestDateTool];
  /** suggest_date calls → pin offers: valid class, title and time only. */
  const pinOffers = (list, scope) => (list || []).map((s) => {
    const cls = CLASSES.includes(s.class) ? s.class : (scope !== 'all' ? scope : null);
    const at = berlinToIso(s.when);
    return cls && at && String(s.title || '').trim() ? { cls, title: String(s.title).trim().slice(0, 80), at, kind: DATE_KINDS.includes(s.kind) ? s.kind : 'event' } : null;
  }).filter(Boolean).slice(0, 4);

  // ---------- Ask definitions: one per (scope, model), re-registered on every activation ----------
  const defs = new Set();
  function definitionFor(scope, model) {
    const id = `ask-${scope}-${model}`.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!defs.has(id)) {
      ctx.cleanup(ctx.agents.register({
        id, model: { provider: PROVIDER, id: model }, maxTurns: 12,
        instructions: instructions({ scope, today: 'given at the top of each message' }),
        tools: askTools(scope),
      }));
      defs.add(id);
    }
    return id;
  }
  // Chats created earlier need their definitions before their conversations are read.
  for (const c of store.list()) if (c.agentModel) definitionFor(c.scope, c.agentModel);

  const emit = (chatId) => { try { ctx.events.emit('chat', { id: chatId }); } catch { /* frontend gone */ } };
  const today = () => new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });

  function finish(chat, turn, fields) {
    Object.assign(turn, fields, { status: fields.status || 'done', doneAt: new Date().toISOString() });
    if (turn.status === 'done' && !String(turn.answer || '').trim()) {
      turn.status = 'error';
      turn.error = 'No answer came back (it may have stopped after too many search steps). Try a narrower question.';
    }
    chat.updatedAt = turn.doneAt;
    inflight.delete(chat.id);
    store.save();
    emit(chat.id);
  }

  /** Citations: verified if a tool returned the ref in this turn or an earlier turn of the same chat. */
  function cite(chat, turn, answer, toolTexts) {
    try {
      const seen = refsInToolOutput(toolTexts);
      turn.seenRefs = [...seen];
      for (const t of chat.turns) {
        for (const r of t.seenRefs || []) seen.add(r);
        for (const c of t.citations || []) if (c.verified) seen.add(c.ref); // chats from before seenRefs existed
      }
      return checkCitations(answer, seen, getSearcher());
    } catch { return []; }
  }

  const inflight = new Set(); // chat ids with a running turn (set synchronously, so two quick asks can't both start)
  const apiRuns = new Map(); // chat id -> AbortController of a running API answer
  const LIMIT_NOTE = 'Your Claude subscription hit its usage limit, so this answer used the API.';

  async function fallback(chat, turn, reason) {
    if (!settings.apiFallback) return finish(chat, turn, { status: 'error', error: `${reason} The API fallback is off in Semester settings.` });
    const s = ledger();
    if (s.left() <= 0) return finish(chat, turn, { status: 'error', error: `${reason} The API fallback already used this month's $${s.cap}; it starts again next month.` });
    turn.via = 'api'; turn.note = reason; store.save(); emit(chat.id);
    const ac = new AbortController();
    const onDisable = () => ac.abort();
    ctx.signal.addEventListener('abort', onDisable, { once: true });
    apiRuns.set(chat.id, ac);
    try {
      const history = chat.turns.filter((t) => t !== turn && t.status === 'done').slice(-6).map((t) => ({ q: t.q, answer: t.answer }));
      const r = await askViaApi({
        apiKey: process.env.WISE_ANTHROPIC_KEY || readSecret('wise-anthropic', 'api-key'),
        workspaceId: process.env.WISE_ANTHROPIC_WORKSPACE ?? readSecret('wise-anthropic', 'workspace-id'),
        baseURL: process.env.WISE_ANTHROPIC_URL || undefined,
        model: API_MODELS[chat.agentModel || settings.model] || API_MODELS.sonnet,
        system: instructions({ scope: chat.scope, today: today() }),
        history, question: turn.q, tools: askTools(chat.scope), ledger: s, signal: ac.signal,
      });
      if (ctx.signal.aborted) return;
      finish(chat, turn, { answer: r.answer + (r.cut ? '\n\n*(The answer was cut off.)*' : ''), citations: cite(chat, turn, r.answer, r.toolTexts), searches: r.searches, cost: r.cost, model: r.model });
    } catch (e) {
      if (ctx.signal.aborted) return;
      finish(chat, turn, { status: 'error', error: ac.signal.aborted ? 'Stopped.' : `${reason} API fallback failed: ${describeApiError(e)}.` });
    } finally {
      apiRuns.delete(chat.id);
      ctx.signal.removeEventListener('abort', onDisable);
    }
  }

  async function ask(chat, text) {
    if (inflight.has(chat.id) || chat.turns.some((t) => t.status === 'running')) throw new Error('This chat is still answering.');
    inflight.add(chat.id);
    let turn = null;
    try {
      const catalog = await ctx.inference.catalog();
      const model = chat.agentModel || settings.model;
      // The API is only a fallback for a used-up plan: a missing Claude Code connection is an error, never a paid answer.
      if (!catalog.models.some((m) => m.provider === PROVIDER && m.id === model)) {
        throw new Error(`Claude Code (${model}) isn't available in LearnHarness. Turn it on in Settings → Providers → External CLI → Claude Code.`);
      }
      turn = store.addTurn(chat, text);
      emit(chat.id);
      if (!chat.agentId) {
        chat.agentId = ctx.agents.create(definitionFor(chat.scope, model)).id;
        chat.agentModel = model;
      }
      // Turns answered through the API while the subscription was paused are not in the conversation: add them.
      const lastSub = chat.turns.map((t) => (t.via === 'subscription' && t.status === 'done' ? 'sub' : '')).lastIndexOf('sub');
      const missed = chat.turns.slice(lastSub + 1, -1).filter((t) => t.via === 'api' && t.status === 'done');
      const preface = missed.length ? `(Earlier in this chat, answered while you were unavailable:\n${missed.map((t) => `Q: ${t.q}\nA: ${t.answer}`).join('\n\n')})\n\n` : '';
      const from = ctx.agents.get(chat.agentId).messages.length;
      turn.model = `${PROVIDER}/${model}`;
      let settled = false, off = () => {};
      const onSnap = (snap) => {
        if (settled || snap.status === 'running') return;
        if (snap.messages.length <= from && snap.status !== 'error' && snap.status !== 'interrupted') return;
        settled = true;
        queueMicrotask(() => off());
        const t = extractTurn(snap.messages, from);
        // Only this run's failure counts: a stale error from an earlier run is ignored when the run itself succeeded.
        const err = snap.status === 'error' ? (snap.error || t.error || 'The answer failed.') : (t.stopReason === 'error' ? (t.error || 'The answer failed.') : '');
        if (err && isLimitError(err)) return void fallback(chat, turn, LIMIT_NOTE);
        if (err || snap.status === 'interrupted') return finish(chat, turn, { status: 'error', error: err || 'Stopped.', searches: t.searches });
        turn.via = 'subscription';
        finish(chat, turn, { answer: t.answer, citations: cite(chat, turn, t.answer, t.toolTexts), searches: t.searches, cost: 0, pins: pinOffers(t.suggestions, chat.scope) });
      };
      try {
        await ctx.agents.send(chat.agentId, `[Today: ${today()}]\n${preface}${text}`, { requestId: turn.id, purpose: 'user' });
      } catch (e) {
        const msg = e?.message || String(e);
        if (isLimitError(msg)) { void fallback(chat, turn, LIMIT_NOTE); return chat; }
        throw e;
      }
      off = ctx.agents.subscribe(chat.agentId, onSnap);
    } catch (e) {
      if (turn) finish(chat, turn, { status: 'error', error: e?.message || String(e) });
      else { inflight.delete(chat.id); throw e; }
    }
    return chat;
  }

  // A course PDF page as a JPEG for the model (view_page): 1400 px wide at most, read via pdftoppm.
  async function renderPage(rel, page) {
    const abs = inRoot(rel);
    const bin = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].find((b) => fs.existsSync(b)) || 'pdftoppm';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semester-view-'));
    try {
      await execFileP(bin, ['-jpeg', '-jpegopt', 'quality=82', '-scale-to', '1400', '-f', String(page), '-l', String(page), '-singlefile', abs, path.join(tmp, 'p')], { timeout: 30000 });
      return { data: fs.readFileSync(path.join(tmp, 'p.jpg')).toString('base64'), mimeType: 'image/jpeg' };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // ---------- operations for the frontend ----------
  const obj = (v) => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected an object'); return v; };
  const scopeOk = (s) => { if (s !== 'all' && !CLASSES.includes(s)) throw new Error(`Unknown class ${s}`); return s; };
  const inRoot = (rel) => {
    const root = fs.realpathSync(settings.root);
    let abs;
    try { abs = fs.realpathSync(path.resolve(settings.root, String(rel))); } catch { throw new Error('File not found'); }
    if (!abs.startsWith(root + path.sep)) throw new Error('Outside the semester folder');
    return abs;
  };
  // Opening runs the file's app: only documents, never programs or scripts.
  const OPENABLE = /\.(pdf|md|txt|html?|ipynb|png|jpe?g|pptx?|docx?|xlsx?|csv|zip|pml|smv|rs)$/i;

  ctx.handle('state', () => {
    let index = null;
    try { const s = getSearcher(); index = s.size; } catch (e) { index = { error: e.message }; }
    const l = ledger();
    return { settings, classes: CLASSES, chats: store.list(), index, api: { spent: l.spent(), cap: l.cap } };
  });
  ctx.handle('chat', (input) => {
    const c = store.get(obj(input).id);
    let partial = '';
    if (c.agentId && c.turns.at(-1)?.status === 'running' && c.turns.at(-1)?.via === 'subscription') {
      try { partial = (ctx.agents.get(c.agentId).partial?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join(''); } catch { /* gone */ }
    }
    return { ...c, partial };
  });
  ctx.handle('new-chat', (input) => store.create(scopeOk(obj(input).scope)));
  ctx.handle('ask', async (input) => {
    const { id, scope, text } = obj(input);
    const q = String(text || '').trim();
    if (!q) throw new Error('Type a question');
    const chat = id ? store.get(id) : store.create(scopeOk(scope || 'all'));
    await ask(chat, q);
    return { id: chat.id };
  });
  ctx.handle('stop', (input) => {
    const c = store.get(obj(input).id);
    apiRuns.get(c.id)?.abort();
    if (c.agentId) { try { ctx.agents.abort(c.agentId); } catch { /* not running */ } }
    return null;
  });
  ctx.handle('rename', (input) => { const { id, title } = obj(input); return store.rename(id, title); });
  ctx.handle('delete-chat', (input) => { store.remove(obj(input).id); return null; });
  ctx.handle('settings', (input) => {
    const v = obj(input);
    const next = { ...settings };
    if (v.model !== undefined) { if (!['haiku', 'sonnet', 'opus'].includes(v.model)) throw new Error('Unknown model'); next.model = v.model; }
    if (v.apiCapUsd !== undefined) { const n = Number(v.apiCapUsd); if (!(n >= 0 && n <= 100)) throw new Error('Cap must be 0–100'); next.apiCapUsd = n; }
    if (v.apiFallback !== undefined) next.apiFallback = !!v.apiFallback;
    if (v.graphQuestions !== undefined) next.graphQuestions = !!v.graphQuestions;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(next, null, 1)); fs.renameSync(settingsFile + '.tmp', settingsFile);
    settings = next;
    return settings;
  });
  ctx.handle('page-image', async (input) => {
    const p = getSearcher().page(String(obj(input).ref));
    if (!p) throw new Error('Unknown page');
    const abs = inRoot(p.path);
    if (!abs.toLowerCase().endsWith('.pdf')) return { ...p, image: null };
    const bin = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'].find((b) => fs.existsSync(b)) || 'pdftoppm';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semester-page-'));
    try {
      await execFileP(bin, ['-png', '-r', '90', '-f', String(p.page), '-l', String(p.page), '-singlefile', abs, path.join(tmp, 'p')], { timeout: 30000 });
      return { ...p, image: `data:image/png;base64,${fs.readFileSync(path.join(tmp, 'p.png')).toString('base64')}` };
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  ctx.handle('open', async (input) => {
    const { path: rel, reveal } = obj(input);
    const abs = inRoot(rel);
    if (!reveal && (!OPENABLE.test(abs) || fs.statSync(abs).isDirectory())) throw new Error('Only documents can be opened from here; use Reveal in Finder.');
    await execFileP('/usr/bin/open', reveal ? ['-R', abs] : [abs]);
    return null;
  });
  ctx.handle('teach-prompt', (input) => {
    const { ref, topic } = obj(input);
    const p = ref ? getSearcher().page(String(ref)) : null;
    const where = p ? `\nUse my course file ${path.join(settings.root, p.path)} (${p.cls}, around page ${p.page}).` : '';
    return { text: `Teach me ${String(topic || p?.title || 'this').trim()} from my ${p?.cls || ''} course material.${where}\nStart by finding out what I already understand.` };
  });
  // "Check Moodle now": runs the watcher once (its own lock prevents overlapping runs).
  let checking = null;
  const checkMoodle = (auto = false) => {
    if (checking) return { running: true };
    const node = [path.join(os.homedir(), '.local/share/fnm/aliases/default/bin/node'), '/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p));
    if (!node) throw new Error('Node.js not found (fnm default, Homebrew)');
    const script = path.join(settings.root, 'Dashboard/watcher/watch.mjs');
    checking = execFileP(node, [script], { cwd: path.dirname(script), timeout: 15 * 60 * 1000, signal: ctx.signal })
      .then((r) => ({ ok: true, out: r.stdout.trim().split('\n').at(-1) }))
      .catch((e) => ({ ok: false, out: String(e.stderr || e.message).trim().split('\n').at(-1) }))
      .then((res) => { checking = null; try { ctx.events.emit('feed', { ...res, auto: auto === true }); } catch { /* gone */ } });
    return { running: true };
  };
  ctx.handle('check-moodle', () => checkMoodle(false));
  // Automatic catch-up while LearnHarness is open: the launchd job can miss runs while the Mac sleeps, so if the last
  // check is over 2 h old, run it here (checked 1 min after start, then every 10 min).
  const STALE_MS = 2 * 60 * 60 * 1000;
  const autoCheck = () => {
    if (ctx.signal.aborted || checking) return;
    const last = Date.parse(readFeed()?.lastRun || '') || 0;
    if (Date.now() - last > STALE_MS && fs.existsSync(path.join(settings.root, 'Dashboard/watcher/watch.mjs'))) { try { checkMoodle(true); } catch { /* no node: the button shows the error */ } }
  };
  const autoFirst = setTimeout(autoCheck, 60 * 1000);
  const autoTimer = setInterval(autoCheck, 10 * 60 * 1000);
  autoFirst.unref?.(); autoTimer.unref?.();
  ctx.signal.addEventListener('abort', () => { clearTimeout(autoFirst); clearInterval(autoTimer); }, { once: true });
  // Tutors by class, for Semester's class pages and Home. newCount = course files added since the tutor last looked.
  ctx.handle('tutors', () => {
    const org = learningDir ? readOrganization(learningDir) : null;
    let index = null;
    try { index = getIndex(); } catch { /* no index yet */ }
    const out = Object.fromEntries(CLASSES.map((c) => [c, []]));
    const sessions = ctx.learning?.listSessions?.() || [];
    // Forget notes of deleted sessions, a week after they were last listed (LearnHarness skips a session file it can't
    // read at that moment, so one missing listing is not enough).
    if (sessions.length) {
      const live = new Set(sessions.map((s) => s.id));
      for (const id of tutors.ids()) {
        const n = tutors.get(id);
        if (live.has(id)) { if (n?.missingSince) tutors.set(id, { missingSince: null }); continue; }
        if (!n?.missingSince) tutors.set(id, { missingSince: new Date().toISOString() });
        else if (Date.now() - Date.parse(n.missingSince) > 7 * 864e5) tutors.remove(id);
      }
    }
    for (const s of sessions) {
      const cls = classOfSession(org, s.id);
      if (!cls) continue;
      let note = tutors.get(s.id) || tutors.ensure(s.id, s.createdAt, inferMode(s.title, s.kind));
      // Types guessed from a title (auto: true) follow renames; types chosen in Semester stay.
      if (note.auto === true && inferMode(s.title, s.kind) !== note.mode) note = tutors.set(s.id, { mode: inferMode(s.title, s.kind) });
      const prog = sessionProgress(getRecord(s.id));
      out[cls].push({
        taught: prog.taught, topics: prog.total,
        id: s.id, title: s.title, kind: s.kind || 'teaching', updatedAt: s.updatedAt, busy: !!s.busy,
        mode: note.mode, modeName: MODES[note.mode] || MODES.course, focus: note.focus || '',
        newCount: index ? newDocs(index, cls, note.lastCheck).length : 0,
      });
    }
    for (const c of CLASSES) out[c].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const dates = allDates();
    const exams = Object.fromEntries(CLASSES.map((c) => [c, examOf(dates, c)]).filter(([, e]) => e));
    return { classes: out, exams, available: !!learningDir };
  });
  ctx.handle('tutor-opening', (input) => {
    const { cls, mode, focus, ref } = obj(input);
    scopeOk(cls);
    if (!MODES[mode]) throw new Error(`Unknown lesson type ${mode}`);
    let where = '';
    if (ref) {
      const p = getSearcher().page(String(ref));
      if (p) where = `my file ${p.path} (around page ${p.page}, ref [${ref}])`;
    }
    return tutorOpening({ cls, mode, focus, ref: where });
  });
  ctx.handle('tutor-created', (input) => {
    const { chatId, cls, mode, focus } = obj(input);
    if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error('Bad session id');
    scopeOk(cls);
    const now = new Date().toISOString();
    return tutors.set(chatId, { mode: MODES[mode] ? mode : 'course', auto: false, focus: String(focus || '').slice(0, 200), createdAt: now, lastCheck: seenUpTo(getIndexSafe()) });
  });
  // ---------- question chats → LearnHarness's knowledge graph ----------
  // The window imports each finished answer as a notes source (LearnHarness's own extraction, on the user's models) and
  // files it in the class folder. These list what is still to send and record the outcome.
  const GRAPH_TRIES = 3;
  ctx.handle('graph-pending', () => {
    if (!settings.graphQuestions) return [];
    let searcher = null;
    try { searcher = getSearcher(); } catch { /* names without the index */ }
    const out = [];
    for (const c of store.list()) {
      const chat = store.get(c.id);
      chat.turns.forEach((t, i) => {
        if (t.status !== 'done' || !String(t.answer || '').trim() || out.length >= 5) return;
        if (t.graph && (t.graph.status === 'done' || (t.graph.tries || 0) >= GRAPH_TRIES)) return;
        // The class: the chat's own, else the one most of the answer's sources come from.
        const counts = new Map();
        for (const x of t.citations || []) if (x.cls) counts.set(x.cls, (counts.get(x.cls) || 0) + 1);
        const cls = chat.scope !== 'all' ? chat.scope : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        const named = String(t.answer).replace(/\[([0-9a-f]{8}:\d{1,5}(?:\s*[,;]\s*[0-9a-f]{8}:\d{1,5})*)\]/g, (_, inner) => `(${inner.split(/\s*[,;]\s*/).map((r) => {
          const p = searcher?.page(r);
          return p ? `${p.cls} · ${p.title}, p. ${p.page}` : 'course file';
        }).join('; ')})`);
        out.push({
          chatId: chat.id, turnId: t.id, cls,
          name: `Q · ${t.q.replace(/\s+/g, ' ').trim().slice(0, 70)}`,
          file: `semester-question-${t.id}.md`,
          text: `# Looked up: ${t.q.trim()}\n\n${named}\n\n(A question looked up in Semester${cls ? ` for ${cls}` : ''} on ${String(t.at).slice(0, 10)}: reference material, not something the learner was taught or tested on.)\n`,
        });
      });
    }
    return out;
  });
  ctx.handle('graph-mark', (input) => {
    const { chatId, turnId, ok, error } = obj(input);
    const chat = store.get(chatId);
    const t = chat.turns.find((x) => x.id === turnId);
    if (!t) return null;
    t.graph = { status: ok ? 'done' : 'failed', tries: (t.graph?.tries || 0) + (ok ? 0 : 1), at: new Date().toISOString(), ...(ok ? {} : { error: String(error || '').slice(0, 200) }) };
    store.save();
    return t.graph;
  });

  // ---------- key dates ----------
  ctx.handle('dates', (input) => {
    const cls = input && typeof input === 'object' && input.cls ? scopeOk(input.cls) : null;
    return allDates(cls === 'all' ? null : cls);
  });
  ctx.handle('date-add', (input) => {
    const { cls, title, at, kind } = obj(input);
    if (kind !== undefined && !DATE_KINDS.includes(kind)) throw new Error('Unknown kind');
    return dateStore.add({ cls: cls ? scopeOk(cls) : null, title, at, kind });
  });
  ctx.handle('date-remove', (input) => { dateStore.remove(String(obj(input).id)); return null; });

  // ---------- knowledge map: extraction for class lessons that went quiet ----------
  // LearnHarness extracts automatically only after ~4k new tokens; a study block often ends below that, so its
  // knowledge never reaches the map or Flashcards. The window asks for an extraction of lessons idle for 15 minutes
  // that changed since their last one.
  ctx.handle('extract-due', () => {
    const org = learningDir ? readOrganization(learningDir) : null;
    const due = [];
    // LearnHarness's master switch (Settings → Knowledge graph): off means no extraction at all.
    try { if (JSON.parse(fs.readFileSync(path.join(learningDir, 'settings.json'), 'utf8')).graph?.enabled === false) return []; } catch { /* default: on */ }
    for (const s of ctx.learning?.listSessions?.() || []) {
      // Practice sessions write nothing to the graph (as in LearnHarness's own trigger).
      if (!classOfSession(org, s.id) || s.busy || s.kind === 'practice') continue;
      const idle = Date.now() - Date.parse(s.updatedAt);
      const note = tutors.get(s.id);
      if (idle < 15 * 60e3 || (note?.extractedAt && note.extractedAt >= s.updatedAt)) continue;
      if (!(s.messageCount > 2)) continue;
      due.push(s.id);
    }
    return due.slice(0, 3);
  });
  ctx.handle('extract-mark', (input) => {
    const id = String(obj(input).id);
    const s = sessionsById().get(id);
    if (s) { if (!tutors.get(id)) tutors.ensure(id, s.createdAt, inferMode(s.title, s.kind)); tutors.set(id, { extractedAt: s.updatedAt }); }
    return null;
  });

  // The site updater's latest results (Dashboard/site-updater/results.json keeps them newest first).
  ctx.handle('site-updates', () => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(settings.root, 'Dashboard/site-updater/results.json'), 'utf8'));
      return (Array.isArray(r.results) ? r.results : []).slice(0, 10);
    } catch { return []; }
  });
  ctx.handle('feed', () => readFeed());
}
