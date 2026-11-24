// Semester plugin frontend: one view with chats grouped by class on the left, and Home or a chat on the right.
// Optional study site per class: class -> [path on SITE_BASE, link text].
const SITES = {};
const SITE_BASE = ''; // set to your own study-site address to show the class-site links
const LEARN_CLASSES = ['SDMS', 'CV1', 'MC', 'EKI', 'HCSD', 'IntroLLM']; // TA is a seminar: no learning folder
const ROOT_FOLDER = 'WiSe 26/27'; // LearnHarness sidebar folder holding one subfolder per class (see src/tutors.mjs)
// Same rule as classOfFolderName in src/tutors.mjs: "CV1", "cv1" or "CV1 – Computer Vision" all mean CV1.
const folderIsClass = (name, cls) => {
  const n = String(name || '').trim().toLowerCase(), c = cls.toLowerCase();
  return n === c || (n.startsWith(c) && /^[\s·:–—-]/.test(n.slice(c.length)));
};
const REF_RE = /\[([0-9a-f]{8}:\d{1,5}(?:\s*[,;]\s*[0-9a-f]{8}:\d{1,5})*)\]/g;

export function activate(ctx) {
  ctx.registerView({
    id: 'semester',
    name: 'Semester',
    mount(container, signal) {
      let alive = true;
      let state = null; // {settings, classes, chats, index, api}
      let current = null; // open question chat id, or null
      let classPage = null; // class whose page is open (when no chat is open), or null for Home
      let tutorsByClass = {}; // class -> lessons (LearnHarness sessions in its folder)
      let examsByClass = {}; // class -> next exam date (pinned or TUCaN)
      const pinnedKeys = new Set(); // "cls|title|at" of pinned dates, so Pin buttons show as done
      const expanded = new Set(); // sidebar groups showing all their chats
      let homeScope = 'all';
      let draft = '';
      let sending = false;
      let chat = null;
      const handles = []; // live for the whole view (composer, dialogs)
      const keep = (h) => { handles.push(h); return h; };
      let paneHandles = []; // Markdown etc. of the current pane: disposed whenever the pane is rebuilt
      const own = (h) => { paneHandles.push(h); return h; };
      const clearPane = () => { for (const h of paneHandles) { try { h.dispose(); } catch { /* gone */ } } paneHandles = []; };
      let shellFor = null; // chat id whose header/log/composer are on screen
      let logEl = null, titleEl = null;
      let lastFeed = null, checkingMoodle = false;
      signal.addEventListener('abort', () => { alive = false; }, { once: true });

      const el = (tag, cls, text, parent) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = text;
        if (parent) parent.append(n);
        return n;
      };
      const guard = (fn) => async (...a) => {
        try { await fn(...a); } catch (e) { if (alive) toast(e instanceof Error ? e.message : String(e)); }
      };

      container.classList.add('sem-root');
      const side = el('nav', 'sem-side', null, container);
      const main = el('section', 'sem-main', null, container);
      // Hideable sidebar: the « button in the sidebar hides it, the » button (top left) brings it back; ⌘\ toggles.
      const SIDE_KEY = 'semester.sideHidden';
      let sideHidden = false;
      try { sideHidden = localStorage.getItem(SIDE_KEY) === '1'; } catch { /* storage off */ }
      const showSide = el('button', 'sem-side-show', '»', container);
      showSide.type = 'button'; showSide.title = 'Show the Semester sidebar (⌘\\)'; showSide.setAttribute('aria-label', 'Show sidebar');
      const applySide = () => {
        container.classList.toggle('sem-side-hidden', sideHidden);
        showSide.hidden = !sideHidden;
        try { localStorage.setItem(SIDE_KEY, sideHidden ? '1' : '0'); } catch { /* storage off */ }
      };
      const toggleSide = () => { sideHidden = !sideHidden; applySide(); (sideHidden ? showSide : side.querySelector('.sem-side-hide'))?.focus(); };
      showSide.onclick = toggleSide;
      container.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleSide(); } }, { signal });
      applySide();
      const toastEl = el('div', 'sem-toast', null, container);
      toastEl.setAttribute('role', 'alert');
      let toastTimer;
      function toast(msg) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000); }
      toastEl.hidden = true;

      // ---------- composer (shared by Home, class pages and chats) ----------
      const composerBox = el('div', 'sem-composer');
      const scopeRow = el('div', 'sem-scopes', null, composerBox);
      const inputBox = el('div', 'sem-input', null, composerBox);
      const canSend = () => !!draft.trim() && !sending && !(chat && chat.turns.at(-1)?.status === 'running');
      const composerProps = () => ({
        value: draft,
        onChange: (v) => { draft = v; syncComposer(); },
        onSend: () => void send(),
        busy: sending || !!(chat && chat.turns.at(-1)?.status === 'running'),
        onStop: guard(async () => { if (chat) await ctx.call('stop', { id: chat.id }); }),
        canSend: canSend(),
        placeholder: current ? 'Ask a follow-up…' : classPage ? `Ask about ${classPage}: deadlines, slides, contacts, a plan…` : 'Ask about your classes: deadlines, slides, contacts, a plan…',
        autoFocus: true,
      });
      const composer = keep(ctx.ui.mountComposer(inputBox, composerProps(), { signal }));
      // No host dictation button here: system-wide dictation tools type into any text field.
      function syncComposer() { if (alive) composer.update(composerProps()); }

      function renderScopes() {
        scopeRow.replaceChildren();
        if (current || classPage) { scopeRow.hidden = true; return; }
        scopeRow.hidden = false;
        for (const s of ['all', ...(state?.classes || [])]) {
          const b = el('button', 'sem-chip' + (homeScope === s ? ' on' : ''), s === 'all' ? 'All classes' : s, scopeRow);
          b.type = 'button';
          b.onclick = () => { homeScope = s; renderScopes(); };
        }
      }

      const send = guard(async () => {
        if (!canSend()) return;
        const text = draft.trim();
        sending = true; syncComposer();
        try {
          const r = await ctx.call('ask', current ? { id: current, text } : { scope: classPage || homeScope, text });
          draft = '';
          current = r.id;
          await refreshState();
          await openChat(r.id);
        } finally { sending = false; syncComposer(); }
      });

      // ---------- sidebar ----------
      const goHome = () => { current = null; chat = null; classPage = null; render(); };
      const goClass = (cls) => { current = null; chat = null; classPage = cls; render(); };
      // ---------- chat actions: rename and delete, from a right-click menu, the ⋯ button, F2 / Delete ----------
      let menuEl = null;
      const closeMenu = () => { menuEl?.remove(); menuEl = null; };
      const onAway = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
      const onMenuKey = (e) => { if (e.key === 'Escape') closeMenu(); };
      document.addEventListener('pointerdown', onAway, true);
      document.addEventListener('keydown', onMenuKey, true);
      signal.addEventListener('abort', () => { closeMenu(); document.removeEventListener('pointerdown', onAway, true); document.removeEventListener('keydown', onMenuKey, true); }, { once: true });
      function openChatMenu(c, x, y, titleSpan) {
        closeMenu();
        menuEl = el('div', 'sem-menu', null, container);
        menuEl.setAttribute('role', 'menu');
        const item = (label, fn, cls) => { const b = el('button', 'sem-menu-item' + (cls ? ` ${cls}` : ''), label, menuEl); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.onclick = () => { closeMenu(); fn(); }; return b; };
        item('Rename', () => startRename(c, titleSpan));
        item('Delete', () => confirmDelete(c), 'danger');
        const r = menuEl.getBoundingClientRect();
        menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
        menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
        menuEl.querySelector('button')?.focus();
      }
      // Rename in place: Enter saves, Esc cancels, clicking away saves.
      function startRename(c, titleSpan) {
        if (!titleSpan?.isConnected) { void openChat(c.id); return; }
        const input = el('input', 'sem-rename sem-rename-inline'); input.value = c.title; input.setAttribute('aria-label', 'Chat name');
        // Swap the whole open-button for the box: an input inside a <button> makes Space "click" the button.
        const target = titleSpan.closest('.sem-entry-open') || titleSpan;
        target.replaceWith(input); input.focus(); input.select();
        const stop = (e) => e.stopPropagation();
        input.onclick = stop; input.onpointerdown = stop; input.onkeyup = stop;
        let done = false;
        const finish = guard(async (save) => {
          if (done) return; done = true;
          const name = input.value.trim();
          if (save && name && name !== c.title) await ctx.call('rename', { id: c.id, title: name });
          await refreshState();
          if (current === c.id) chat = await ctx.call('chat', { id: c.id });
          render();
        });
        input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void finish(true); } if (e.key === 'Escape') { e.preventDefault(); void finish(false); } };
        input.onblur = () => void finish(true);
      }
      function confirmDelete(c) {
        const box = el('div', 'sem-confirm');
        el('p', null, `Delete "${c.title}"? This can't be undone.`, box);
        const row = el('div', 'sem-confirm-row', null, box);
        const yes = el('button', 'sem-btn', 'Delete', row); yes.type = 'button';
        const no = el('button', 'sem-link', 'Cancel', row); no.type = 'button';
        const dlg = keep(ctx.ui.openDialog({ title: 'Delete chat', content: box }, { signal }));
        no.onclick = () => dlg.dispose();
        yes.onclick = guard(async () => {
          await ctx.call('delete-chat', { id: c.id });
          dlg.dispose();
          if (current === c.id) { current = null; chat = null; classPage = c.scope === 'all' ? null : c.scope; }
          await refreshState(); render();
        });
        setTimeout(() => yes.focus(), 0);
      }
      // A chat in a list: click opens it; right-click, ⋯, F2 and Delete give rename/delete.
      function chatEntry(c, parent, cls, extra) {
        const row = el('div', cls, null, parent);
        const open = el('button', 'sem-entry-open', null, row); open.type = 'button';
        const titleSpan = el('span', 'sem-chat-title', c.title, open);
        extra?.(open);
        open.onclick = () => void openChat(c.id);
        const more = el('button', 'sem-more-btn', '⋯', row); more.type = 'button';
        more.title = 'Rename or delete'; more.setAttribute('aria-label', `Rename or delete "${c.title}"`);
        more.onclick = (e) => { e.stopPropagation(); const b = more.getBoundingClientRect(); openChatMenu(c, b.left, b.bottom + 4, titleSpan); };
        row.oncontextmenu = (e) => { e.preventDefault(); openChatMenu(c, e.clientX, e.clientY, titleSpan); };
        open.onkeydown = (e) => {
          if (e.key === 'F2') { e.preventDefault(); startRename(c, titleSpan); }
          if (e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) { e.preventDefault(); confirmDelete(c); }
        };
        return row;
      }
      const chatRow = (c) => chatEntry(c, side, 'sem-chat' + (c.id === current ? ' on' : ''), (open) => { if (c.running) el('span', 'sem-dot', '●', open); });
      function renderSide() {
        side.replaceChildren();
        const top = el('div', 'sem-side-top', null, side);
        const home = el('button', 'sem-home' + (!current && !classPage ? ' on' : ''), 'Home', top);
        home.type = 'button';
        const hide = el('button', 'sem-side-hide', '«', top);
        hide.type = 'button'; hide.title = 'Hide the sidebar (⌘\\)'; hide.setAttribute('aria-label', 'Hide sidebar');
        hide.onclick = toggleSide;
        home.onclick = goHome;
        const byTime = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
        const chats = state?.chats || [];
        // Questions across all classes.
        const allChats = chats.filter((c) => c.scope === 'all').sort(byTime);
        const head = el('div', 'sem-group', null, side);
        el('span', 'sem-group-name', 'Questions', head);
        const add = el('button', 'sem-add', '+', head);
        add.type = 'button'; add.title = 'New question chat across all classes'; add.setAttribute('aria-label', add.title);
        add.onclick = guard(async () => { const c = await ctx.call('new-chat', { scope: 'all' }); await refreshState(); await openChat(c.id); });
        const showAll = expanded.has('all');
        for (const c of showAll ? allChats : allChats.slice(0, 5)) chatRow(c);
        if (allChats.length > 5) {
          const more = el('button', 'sem-more', showAll ? 'Show fewer' : `Show all ${allChats.length}`, side); more.type = 'button';
          more.onclick = () => { showAll ? expanded.delete('all') : expanded.add('all'); renderSide(); };
        }
        // Classes: a class's own question chats show while that class (or one of its chats) is open.
        el('div', 'sem-group-name sem-gap', 'Classes', side);
        const openCls = classPage || (chat && chat.scope !== 'all' ? chat.scope : null);
        for (const cls of state?.classes || []) {
          const row = el('button', 'sem-class' + (classPage === cls ? ' on' : ''), null, side);
          row.type = 'button';
          el('span', 'sem-chat-title', cls, row);
          const fresh = (tutorsByClass[cls] || []).reduce((a, t) => a + (t.newCount ? 1 : 0), 0);
          if (fresh) { const b = el('span', 'sem-badge', String(fresh), row); b.title = `${fresh} lesson${fresh === 1 ? ' has' : 's have'} new material`; }
          row.onclick = () => goClass(cls);
          if (openCls === cls) for (const c of chats.filter((x) => x.scope === cls).sort(byTime)) chatRow(c);
        }
        const foot = el('div', 'sem-foot', null, side);
        // Moodle check, on every page: when it last ran, and a button to run it now.
        const mood = el('div', 'sem-moodle', null, foot);
        const lr = Date.parse(lastFeed?.lastRun || '');
        const mins = lr ? Math.round((Date.now() - lr) / 6e4) : null;
        el('div', mins != null && mins > 150 ? 'sem-warn' : null, mins == null ? 'Moodle not checked yet'
          : `Moodle checked ${mins < 2 ? 'just now' : mins < 90 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`}`, mood);
        const chk = el('button', 'sem-check', checkingMoodle ? 'Checking Moodle…' : 'Check Moodle now', mood);
        chk.type = 'button'; chk.disabled = checkingMoodle;
        chk.onclick = guard(async () => { checkingMoodle = true; renderSide(); try { await ctx.call('check-moodle'); } catch (e) { checkingMoodle = false; renderSide(); throw e; } });
        const s = state?.settings;
        if (s) {
          el('div', null, `Claude ${s.model} · subscription`, foot);
          if (state.api.spent > 0) el('div', null, `API fallback: $${state.api.spent.toFixed(2)} of $${state.api.cap} this month`, foot);
          if (state.index?.error) el('div', 'sem-warn', state.index.error, foot);
          const set = el('button', 'sem-link', 'Settings', foot);
          set.type = 'button';
          set.onclick = () => openSettings();
        }
      }

      // ---------- shared bits for Home and class pages ----------
      const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
      const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Berlin' });
      const ago = (iso) => {
        const h = (Date.now() - Date.parse(iso)) / 36e5;
        return h < 1 ? 'just now' : h < 24 ? `${Math.round(h)} h ago` : h < 48 ? 'yesterday' : day(iso);
      };
      // Moodle can list one task as an assignment and as a calendar event: keep one, preferring the one with a status.
      function deadlines(feed, cls, days) {
        const seen = new Map();
        for (const d of feed?.deadlines || []) {
          if (cls && d.cls !== cls) continue;
          const k = `${d.cls}|${d.title}|${d.due}`;
          if (!seen.has(k) || (seen.get(k).submitted == null && d.submitted != null)) seen.set(k, d);
        }
        return [...seen.values()].filter((d) => Date.parse(d.due) > Date.now() - 864e5 && Date.parse(d.due) < Date.now() + days * 864e5)
          .sort((a, b) => a.due.localeCompare(b.due));
      }
      function deadlineRow(box, d, showCls = true) {
        const r = el('div', 'sem-row' + (d.submitted === false ? ' todo' : ''), null, box);
        el('span', 'sem-when', when(d.due), r);
        if (showCls) el('b', null, d.cls, r);
        const a = el('a', null, d.title, r); if (/^https?:\/\//.test(d.url)) { a.href = d.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        if (d.submitted != null) el('span', 'sem-muted', d.submitted ? 'submitted' : 'not submitted', r);
      }
      const openLesson = (id) => { try { ctx.app.openSession(id); } catch (e) { toast(e.message); } };
      const goodSite = (r) => r.status === 'published';
      // Only the newest result per class counts (a later publish supersedes an earlier rejection).
      const latestSites = (sites) => { const seen = new Set(); return sites.filter((r) => r.status !== 'skipped' && !seen.has(r.cls) && seen.add(r.cls)); };
      const siteLine = (box, r, showCls = true) => {
        const row = el('div', 'sem-row', null, box);
        el('span', 'sem-when', day(r.at), row);
        if (showCls) el('b', null, r.cls, row);
        el('span', goodSite(r) ? null : 'sem-warn', goodSite(r)
          ? `Class site updated${r.summary ? `: ${r.summary}` : ''}`
          : `Site update ${r.status === 'waiting' ? 'waiting (usage limit)' : 'not published'}${r.reason || r.reasons?.[0] || r.summary ? `: ${r.reason || r.reasons?.[0] || r.summary}` : ''}`, row);
      };
      async function loadExtras() {
        const [feed, tutors, sites] = await Promise.all([
          ctx.call('feed').catch(() => null), ctx.call('tutors').catch(() => null), ctx.call('site-updates').catch(() => []),
        ]);
        if (tutors?.classes) { tutorsByClass = tutors.classes; examsByClass = tutors.exams || {}; }
        if (feed) lastFeed = feed;
        return { feed, sites };
      }

      // ---------- Home: ask, what's coming up, what's new ----------
      let pageSeq = 0; // bumps on every page render: a slower, older render stops after its await
      async function renderHome() {
        const seq = ++pageSeq;
        clearPane(); shellFor = null;
        main.replaceChildren();
        const wrap = el('div', 'sem-home-wrap', null, main);
        el('h1', 'sem-h1', 'What do you want to know?', wrap);
        wrap.append(composerBox);
        renderScopes(); syncComposer();
        const body = el('div', 'sem-feed', null, wrap);
        const { feed, sites } = await loadExtras();
        if (!alive || current || classPage || seq !== pageSeq) return;
        renderSide();
        body.replaceChildren();

        const up = el('div', 'sem-card', null, body);
        el('h2', null, 'Coming up', up);
        const pinned = (await ctx.call('dates').catch(() => [])).filter((d) => (d.source === 'pinned' || d.kind === 'exam') && Date.parse(d.at) < Date.now() + 14 * 864e5)
          .map((d) => ({ cls: d.cls || '', title: d.title, due: d.at, url: '', submitted: null }));
        if (!alive || current || classPage || seq !== pageSeq) return;
        const dl = [...deadlines(feed, null, 14), ...pinned].sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
        if (!dl.length) el('p', 'sem-muted', feed ? 'Nothing due in the next two weeks.' : 'Deadlines appear here after the next Moodle check.', up);
        for (const d of dl) deadlineRow(up, d);
        const exams = Object.entries(examsByClass).sort((a, b) => a[1].at.localeCompare(b[1].at));
        if (exams.length) el('p', 'sem-muted', 'Exams: ' + exams.map(([c, e]) => `${c} ${day(e.at)} (${Math.max(0, Math.ceil((Date.parse(e.at) - Date.now()) / 864e5))} d)`).join(' · '), up);

        const nw = el('div', 'sem-card', null, body);
        el('h2', null, 'New', nw);
        let any = false;
        // Lessons with new material first: the reason to come back.
        for (const cls of state?.classes || []) {
          for (const t of (tutorsByClass[cls] || []).filter((x) => x.newCount)) {
            any = true;
            const r = el('div', 'sem-row', null, nw);
            el('b', null, cls, r);
            const a = el('button', 'sem-link', `${t.title}: ${t.newCount} new file${t.newCount === 1 ? '' : 's'} since your last lesson`, r); a.type = 'button';
            a.onclick = () => openLesson(t.id);
          }
        }
        // New files (and ★ links) from the last 7 days, one line per class; details are on the class page.
        const week = Date.now() - 7 * 864e5;
        const per = new Map();
        for (const f of feed?.recent || []) {
          if (!(Date.parse(f.at) > week)) continue;
          const e = per.get(f.cls) || { files: [], links: 0 };
          if (String(f.savedTo || '').startsWith('Additional resources/')) e.links++; else e.files.push(f);
          per.set(f.cls, e);
        }
        for (const [cls, { files, links }] of per) {
          any = true;
          const r = el('div', 'sem-row', null, nw);
          el('b', null, cls, r);
          const parts = [];
          if (files.length) parts.push(`${files.length} new file${files.length === 1 ? '' : 's'}: ${files.slice(0, 2).map((f) => f.name).join(', ')}${files.length > 2 ? '…' : ''}`);
          if (links) parts.push(`${links} ★ link${links === 1 ? '' : 's'} worth a look`);
          const a = el('button', 'sem-link', parts.join(' · '), r); a.type = 'button';
          a.onclick = () => goClass(cls);
        }
        for (const s of latestSites(sites).filter((x) => Date.parse(x.at) > week)) { any = true; siteLine(nw, s); }
        if (!any) el('p', 'sem-muted', 'Nothing new this week.', nw);

        const foot = el('div', 'sem-bar', null, wrap);
        if (feed?.keyOk === false) el('span', 'sem-warn', `Moodle sign-in needed: ${feed.keyProblem || 'the Moodle key stopped working'}`, foot);
        el('span', 'sem-muted', feed?.lastRun ? `Moodle checked ${ago(feed.lastRun)}${feed.errors?.length ? ` · ${feed.errors.length} error(s)` : ''}` : 'Moodle not checked yet', foot);
        const check = el('button', 'sem-link', 'Check now', foot); check.type = 'button';
        if (checkingMoodle) { check.disabled = true; check.textContent = 'Checking Moodle…'; }
        check.onclick = guard(async () => { check.disabled = true; check.textContent = 'Checking Moodle…'; checkingMoodle = true; renderSide(); await ctx.call('check-moodle'); });
      }

      // ---------- a class: lessons, questions, what's new ----------
      async function renderClass() {
        const cls = classPage;
        const seq = ++pageSeq;
        clearPane(); shellFor = null;
        main.replaceChildren();
        const wrap = el('div', 'sem-home-wrap', null, main);
        const head = el('div', 'sem-class-head', null, wrap);
        el('h1', 'sem-h1', cls, head);
        if (SITE_BASE && SITES[cls]) {
          const a = el('a', 'sem-link', `${SITES[cls][1]} ↗`, head);
          a.href = SITE_BASE + SITES[cls][0] + '/'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = 'Your interactive study site for this class';
        }
        wrap.append(composerBox);
        renderScopes(); syncComposer();
        const body = el('div', 'sem-feed', null, wrap);
        const { feed, sites } = await loadExtras();
        if (!alive || current || classPage !== cls || seq !== pageSeq) return;
        renderSide();

        // Question chats for this class.
        const qs = (state?.chats || []).filter((c) => c.scope === cls).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        {
          const qc = el('div', 'sem-card', null, body);
          el('h2', null, 'Questions', qc);
          if (!qs.length) el('p', 'sem-muted', `Nothing asked yet. Ask above: deadlines, the professor's e-mail, which slide something is on, a plan for the week…`, qc);
          for (const c of qs.slice(0, 12)) chatEntry(c, qc, 'sem-lesson sem-entry', (open) => { el('span', 'sem-muted', ago(c.updatedAt), open); });
        }

        // What's new and due in this class.
        const nw = el('div', 'sem-card', null, body);
        el('h2', null, `New in ${cls}`, nw);
        const dl = deadlines(feed, cls, 28);
        for (const d of dl) deadlineRow(nw, d, false);
        const recent = (feed?.recent || []).filter((f) => f.cls === cls && !String(f.savedTo || '').startsWith('Additional resources/')).slice(0, 8);
        for (const f of recent) {
          const r = el('div', 'sem-row', null, nw);
          el('span', 'sem-when', day(f.at), r);
          const a = el('button', 'sem-link', f.name, r); a.type = 'button';
          a.onclick = guard(() => (f.savedTo ? ctx.call('open', { path: f.savedTo }) : window.open(f.url, '_blank', 'noopener')));
        }
        for (const s of latestSites(sites).filter((x) => x.cls === cls)) siteLine(nw, s, false);
        const stars = (feed?.links || []).filter((l) => l.action === 'recommend' && l.cls === cls);
        for (const l of stars) {
          const d = el('details', 'sem-star', null, nw);
          el('summary', null, `★ ${l.title}`, d);
          if (l.md) own(ctx.ui.mountMarkdown(el('div', 'sem-md', null, d), { text: l.md }, { signal }));
          if (/^https?:\/\//.test(l.url)) { const a = el('a', null, 'Open', d); a.href = l.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        }
        if (!dl.length && !recent.length && !stars.length) el('p', 'sem-muted', 'Nothing new from Moodle yet.', nw);

        // Learning: the class's LearnHarness lessons, their progress, the exam, and buttons that start a lesson filed
        // in the class folder before its first message (so it is a class tutor from the first answer).
        const lessons = tutorsByClass[cls] || [];
        const exam = examsByClass[cls];
        const lc = el('div', 'sem-card', null, body);
        el('h2', null, 'Learning', lc);
        if (exam) {
          const days = Math.ceil((Date.parse(exam.at) - Date.now()) / 864e5);
          el('p', 'sem-exam', `${exam.title}: ${when(exam.at)} · ${days > 0 ? `${days} days left` : 'today or past'}`, lc);
        }
        if (!lessons.length) el('p', 'sem-muted', `No ${cls} lessons yet. "Continue the course" starts one that follows the lectures; it finds the slides itself.`, lc);
        for (const t of lessons) {
          const r = el('button', 'sem-lesson', null, lc); r.type = 'button';
          el('span', 'sem-lesson-title', t.title, r);
          const tag = t.kind === 'practice' ? 'Practice' : t.modeName;
          if (!t.title.toLowerCase().includes(tag.toLowerCase())) el('span', 'sem-pill', tag, r);
          if (t.topics) el('span', 'sem-muted', `${t.taught}/${t.topics} topics`, r);
          if (t.newCount) el('span', 'sem-badge', `${t.newCount} new`, r);
          el('span', 'sem-muted', ago(t.updatedAt), r);
          r.onclick = () => openLesson(t.id);
        }
        const starts = el('div', 'sem-starts', null, lc);
        const ask = el('div', 'sem-ask-focus', null, lc);
        ask.hidden = true;
        const busyStarts = (on) => { for (const x of lc.querySelectorAll('.sem-starts button, .sem-ask-focus button')) x.disabled = on; };
        const startBtn = (label, run, prompt) => {
          const b = el('button', 'sem-chip', label, starts); b.type = 'button';
          b.onclick = () => {
            if (!prompt) { busyStarts(true); return void guard(async () => { try { await run(); } finally { busyStarts(false); } })(); }
            ask.hidden = false; ask.replaceChildren();
            const input = el('input', 'sem-rename', null, ask); input.placeholder = prompt; input.setAttribute('aria-label', prompt);
            const go = el('button', 'sem-btn', 'Start', ask); go.type = 'button';
            const fire = guard(async () => {
              if (!input.value.trim()) return input.focus();
              busyStarts(true);
              try { await run(input.value.trim()); } finally { busyStarts(false); }
            });
            go.onclick = fire;
            input.onkeydown = (e) => { if (e.key === 'Enter') void fire(); if (e.key === 'Escape') ask.hidden = true; };
            input.focus();
          };
        };
        const course = lessons.find((t) => t.mode === 'course' && t.kind !== 'practice');
        startBtn(course ? 'Continue the course' : '+ Follow the course', async () => (course ? openLesson(course.id) : startLesson({ cls, mode: 'course' })));
        const examLesson = lessons.find((t) => t.mode === 'exam');
        startBtn(examLesson ? 'Continue exam prep' : '+ Exam prep', async () => (examLesson ? openLesson(examLesson.id) : startLesson({ cls, mode: 'exam' })));
        startBtn('+ Practice', async () => startLesson({ cls, mode: 'practice' }));
        startBtn('+ A topic', (f) => startLesson({ cls, mode: 'topic', focus: f }), 'What do you want to learn? e.g. B+ tree splits');
        startBtn('+ Homework concepts', (f) => startLesson({ cls, mode: 'homework', focus: f }), 'Which homework? e.g. Homework 3');
        const links = el('p', 'sem-muted', null, lc);
        links.append(`Lessons live in LearnHarness under ${ROOT_FOLDER} › ${cls}; any session you drag there becomes a ${cls} lesson. Review what you learned: `);
        const fc = el('a', 'sem-link', 'Flashcards', links); fc.href = '/plugins/flashcards/library';
        links.append('.');

        // Key dates: pinned here, plus TUCaN's calendar export.
        const kd = el('div', 'sem-card', null, body);
        el('h2', null, 'Key dates', kd);
        const dates = await ctx.call('dates', { cls }).catch(() => []);
        if (!alive || classPage !== cls || seq !== pageSeq) return;
        if (!dates.length) el('p', 'sem-muted', 'No exam or other dates yet. Add them below, or export your TUCaN timetable (Stundenplan → Export) into the TUCaN folder of your semester.', kd);
        for (const d of dates.slice(0, 12)) {
          const r = el('div', 'sem-row', null, kd);
          el('span', 'sem-when', when(d.at), r);
          el('span', null, `${d.kind === 'exam' ? '📝 ' : ''}${d.title}${d.location ? ` · ${d.location}` : ''}`, r);
          if (d.source === 'pinned') { const x = el('button', 'sem-link', 'Remove', r); x.type = 'button'; x.onclick = guard(async () => { await ctx.call('date-remove', { id: d.id }); render(); }); }
          else el('span', 'sem-muted', 'TUCaN', r);
        }
        const add = el('div', 'sem-ask-focus', null, kd);
        const title = el('input', 'sem-rename', null, add); title.placeholder = 'e.g. Exam, Lab 1 hand-in'; title.setAttribute('aria-label', 'What');
        const at = el('input', 'sem-rename sem-date', null, add); at.type = 'datetime-local'; at.setAttribute('aria-label', 'When');
        const kind = el('select', 'sem-rename sem-kind', null, add);
        for (const [v, l] of [['exam', 'Exam'], ['deadline', 'Deadline'], ['event', 'Other']]) { const o = el('option', null, l, kind); o.value = v; }
        const save = el('button', 'sem-btn', 'Add date', add); save.type = 'button';
        save.onclick = guard(async () => {
          if (!title.value.trim() || !at.value) throw new Error('Give the date a name and a time.');
          await ctx.call('date-add', { cls, title: title.value, at: new Date(at.value).toISOString(), kind: kind.value });
          render();
        });
      }

      // ---------- starting a lesson in LearnHarness ----------
      // Uses the same internal routes as LearnHarness's own sidebar: create a session, file it in the class folder,
      // name it, and hand the opening message to the chat page (which sends it). If that fails, the message is copied.
      async function lh(url, body) {
        const r = await fetch(url, body === undefined ? { cache: 'no-store' }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `LearnHarness said ${r.status}`);
        return j;
      }
      async function rootFolder() {
        const dir = await lh('/api/graph/sources');
        const root = (dir.organization?.folders || []).find((f) => f.parentId === null && f.name === ROOT_FOLDER);
        return root ? root.id : (await lh('/api/graph/sources', { action: 'create-folder', name: ROOT_FOLDER, parentId: null })).createdFolderId;
      }
      // Looked-up answers (when imported into the graph) go into "<class> › Questions", apart from the lessons.
      async function questionsFolder(cls) {
        const parent = cls ? await classFolder(cls) : await rootFolder();
        const dir = await lh('/api/graph/sources');
        const f = (dir.organization?.folders || []).find((x) => x.parentId === parent && x.name === 'Questions');
        return f ? f.id : (await lh('/api/graph/sources', { action: 'create-folder', name: 'Questions', parentId: parent })).createdFolderId;
      }
      async function classFolder(cls) {
        const rootId = await rootFolder();
        let dir = await lh('/api/graph/sources');
        const folders = () => dir.organization?.folders || [];
        const root = { id: rootId };
        // Prefer the class folder under the semester folder, else any folder the user already named after the class.
        const sub = folders().find((f) => f.parentId === root.id && folderIsClass(f.name, cls)) || folders().find((f) => folderIsClass(f.name, cls));
        if (sub) return sub.id;
        dir = await lh('/api/graph/sources', { action: 'create-folder', name: cls, parentId: root.id });
        return dir.createdFolderId;
      }
      let starting = false; // one lesson start at a time (a double click must not make two sessions or folders)
      async function startLesson({ cls, mode = 'topic', focus = '', ref }) {
        if (starting) return;
        starting = true;
        try {
          const o = cls ? await ctx.call('tutor-opening', { cls, mode, focus, ref })
            : { title: String(focus || 'Lesson').slice(0, 80), text: (await ctx.call('teach-prompt', { ref, topic: focus })).text };
          const copyFallback = async (why) => {
            let copied = false;
            try { await navigator.clipboard.writeText(o.text); copied = true; } catch { /* no clipboard */ }
            toast(copied ? `${why} Its opening message is copied: click "+ Teaching", paste it and send.`
              : `${why} Click "+ Teaching" and ask: ${o.text.slice(0, 160)}…`);
          };
          let id, folder = null;
          try {
            if (cls) folder = await classFolder(cls);
            id = (await lh('/api/chats', { title: o.text })).id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('no session id');
          } catch (e) { await copyFallback(`Couldn't start the lesson by itself (${e.message}).`); return; }
          // The lesson type first, so the tutor brief is right even if filing fails below.
          if (cls) await ctx.call('tutor-created', { chatId: id, cls, mode, focus }).catch(() => {});
          let handedOver = false;
          try {
            const v = JSON.stringify({ text: o.text, attempted: false });
            sessionStorage.setItem(`lh.openingPrompt.${id}`, v);
            handedOver = sessionStorage.getItem(`lh.openingPrompt.${id}`) === v;
          } catch { /* storage refused */ }
          try {
            if (folder) await lh('/api/graph/sources', { action: 'move', kind: 'source', id, parentId: folder });
            await lh('/api/graph/sources', { action: 'rename-source', id, name: o.title });
          } catch (e) { toast(`The lesson started, but filing it in ${ROOT_FOLDER} › ${cls} failed (${e.message}). Drag it there in the sidebar.`); }
          if (!handedOver) await copyFallback('The lesson is open but could not start by itself.');
          openLesson(id);
        } finally { starting = false; }
      }

      // ---------- a chat ----------
      async function loadPinned() {
        for (const d of await ctx.call('dates').catch(() => [])) if (d.source === 'pinned') pinnedKeys.add(`${d.cls}|${d.title}|${d.at}`);
      }
      async function openChat(id) {
        await loadPinned();
        if (id !== current) shellFor = null;
        current = id;
        chat = await ctx.call('chat', { id });
        if (!alive || current !== id) return;
        render();
      }

      function answerMarkdown(t) {
        const num = new Map((t.citations || []).map((c) => [c.ref, c]));
        return (t.answer || '').replace(REF_RE, (_, inner) => inner.split(/\s*[,;]\s*/).map((r) => {
          const c = num.get(r);
          return c ? `<sup>[${c.n}${c.verified ? '' : '?'}]</sup>` : `[${r}]`;
        }).join(''));
      }

      function renderChat() {
        if (shellFor !== chat.id) {
          ++pageSeq;
          clearPane();
          main.replaceChildren();
          shellFor = chat.id;
          const head = el('div', 'sem-chat-head', null, main);
          const pill = el('button', 'sem-pill', chat.scope === 'all' ? 'All classes' : chat.scope, head); pill.type = 'button';
          pill.title = chat.scope === 'all' ? 'Home' : `Open the ${chat.scope} page`;
          pill.onclick = () => (chat.scope === 'all' ? goHome() : goClass(chat.scope));
          titleEl = el('h1', 'sem-h1 small', chat.title, head);
          titleEl.title = 'Double-click to rename';
          titleEl.ondblclick = () => {
            const input = el('input', 'sem-rename'); input.value = chat.title;
            titleEl.replaceWith(input); input.focus();
            let done = false;
            const finishRename = guard(async (save) => {
              if (done) return; done = true;
              if (save) await ctx.call('rename', { id: chat.id, title: input.value });
              input.replaceWith(titleEl);
              await refreshState(); chat = await ctx.call('chat', { id: chat.id }); titleEl.textContent = chat.title; renderSide();
            });
            input.onkeydown = (e) => { if (e.key === 'Enter') void finishRename(true); if (e.key === 'Escape') void finishRename(false); };
            input.onblur = () => void finishRename(true);
          };
          const del = el('button', 'sem-link danger', 'Delete chat', head); del.type = 'button';
          del.onclick = () => confirmDelete(chat);
          logEl = el('div', 'sem-log', null, main);
          main.append(composerBox);
          renderScopes(); syncComposer();
          renderLog(true);
          return;
        }
        titleEl.textContent = chat.title;
        renderLog(false);
        syncComposer();
      }

      // The host's view viewport may be what scrolls, not .sem-main: find the element that actually scrolls.
      function scroller() {
        for (let n = main; n; n = n.parentElement) {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
        }
        return document.scrollingElement;
      }

      function renderLog(jump) {
        const sc = scroller();
        const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160;
        const turnsBefore = logEl.querySelectorAll('.sem-q').length;
        clearPane();
        logEl.replaceChildren();
        const log = logEl;
        if (!chat.turns.length) el('p', 'sem-muted', chat.scope === 'all' ? 'Ask anything about your classes.' : `Ask anything about ${chat.scope}. This chat only searches ${chat.scope}'s files.`, log);
        for (const t of chat.turns) {
          el('div', 'sem-q', t.q, log);
          const a = el('div', 'sem-a', null, log);
          if (t.status === 'running') {
            const md = el('div', null, null, a);
            if (chat.partial && t === chat.turns.at(-1)) own(ctx.ui.mountMarkdown(md, { text: chat.partial }, { signal }));
            el('p', 'sem-muted', t.via === 'api' ? 'Answering through the API (subscription limit reached)…' : 'Searching your files…', a);
            continue;
          }
          if (t.status === 'error') { el('p', 'sem-warn', t.error || 'Something went wrong.', a); continue; }
          own(ctx.ui.mountMarkdown(el('div', 'sem-md', null, a), { text: answerMarkdown(t) }, { signal }));
          if (t.citations?.length) {
            const cl = el('div', 'sem-cites', null, a);
            for (const c of t.citations) {
              const row = el('div', 'sem-cite' + (c.verified ? '' : ' unverified'), null, cl);
              el('b', null, `[${c.n}]`, row);
              if (!c.path) { el('span', 'sem-muted', `${c.ref}: not in your files (unverified)`, row); continue; }
              el('span', null, `${c.cls} · ${c.title} · p. ${c.page}${c.graded ? ' · graded' : ''}${c.verified ? '' : ' · unverified'}`, row);
              const show = el('button', 'sem-link', 'Show page', row); show.type = 'button';
              show.onclick = guard(() => showPage(c.ref));
              const open = el('button', 'sem-link', 'Open', row); open.type = 'button';
              open.onclick = guard(() => ctx.call('open', { path: c.path }));
              const teach = el('button', 'sem-link', 'Teach me this', row); teach.type = 'button';
              teach.onclick = guard(() => teachMe({ ref: c.ref, topic: t.q, cls: c.cls || chat.scope, graded: c.graded, title: c.title, page: c.page, turnGraded: t.citations.some((x) => x.graded) }));
            }
          }
          // Dates the answer offered to pin (suggest_date): one click puts them in Key dates, Coming up and the countdown.
          for (const p of t.pins || []) {
            const done = pinnedKeys.has(`${p.cls}|${p.title}|${p.at}`);
            const b = el('button', 'sem-pin' + (done ? ' done' : ''), done ? `✓ Pinned: ${p.cls} · ${p.title} · ${when(p.at)}` : `📌 Pin ${p.cls} · ${p.title} · ${when(p.at)}`, a); b.type = 'button';
            b.disabled = done;
            b.onclick = guard(async () => {
              await ctx.call('date-add', { cls: p.cls, title: p.title, at: p.at, kind: p.kind });
              pinnedKeys.add(`${p.cls}|${p.title}|${p.at}`);
              b.textContent = `✓ Pinned: ${p.cls} · ${p.title} · ${when(p.at)}`; b.classList.add('done'); b.disabled = true;
              await refreshState(); renderSide();
            });
          }
          const meta = el('div', 'sem-meta', null, a);
          meta.textContent = [t.via === 'api' ? `API · $${(t.cost || 0).toFixed(4)}` : 'subscription', t.note || '', t.searches?.length ? `${t.searches.length} lookup${t.searches.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
          const teach = el('button', 'sem-link', 'Teach me this', meta); teach.type = 'button';
          teach.onclick = guard(() => {
            const c = t.citations?.find((x) => x.verified && !x.graded) || t.citations?.find((x) => x.verified);
            const turnGraded = !!t.citations?.some((x) => x.graded);
            if (turnGraded && !c) throw new Error('This answer used graded work: open its class and use "Homework concepts" instead.');
            return teachMe({ ref: c?.ref, topic: t.q, cls: c?.cls || chat.scope, graded: c?.graded, title: c?.title, page: c?.page, turnGraded });
          });
        }
        if (jump || nearBottom || chat.turns.length > turnsBefore) {
          const newTurn = chat.turns.length > turnsBefore && !jump;
          // Answers are rendered by the host a moment later (Markdown), so scroll again once their height is known.
          const go = () => {
            if (!alive || !logEl?.isConnected) return;
            const qs = logEl.querySelectorAll('.sem-q');
            (newTurn ? qs[qs.length - 1] : composerBox)?.scrollIntoView({ block: newTurn ? 'start' : 'end' });
          };
          requestAnimationFrame(go);
          setTimeout(go, 300);
        }
      }

      async function showPage(ref) {
        const p = await ctx.call('page-image', { ref });
        const box = el('div', 'sem-page');
        el('h2', null, `${p.cls} · ${p.title} · page ${p.page}`, box);
        if (p.image) { const img = el('img', null, null, box); img.src = p.image; img.alt = `${p.title}, page ${p.page}`; }
        else el('pre', null, p.text, box);
        const open = el('button', 'sem-btn', 'Open file', box); open.type = 'button';
        open.onclick = guard(() => ctx.call('open', { path: p.path }));
        keep(ctx.ui.openDialog({ title: `${p.title}, page ${p.page}`, content: box }, { signal }));
      }

      // "Teach me this" on an answer: a topic lesson in the cited page's class (or the chat's class).
      // From a graded page it becomes a "homework concepts" lesson on that document, without the question's wording,
      // so the lesson teaches the topic and never works on the task.
      // If anything in that answer was graded, the question's own words never go into the lesson (it may be about the task):
      // the lesson is named after the cited page's document instead.
      async function teachMe({ ref, topic, cls, graded, title, turnGraded, page }) {
        const c = cls && cls !== 'all' ? cls : null;
        if (graded) {
          if (!c) throw new Error('This page is graded work: open its class and use "Homework concepts" instead.');
          return startLesson({ cls: c, mode: 'homework', focus: title || 'this graded work' });
        }
        const short = turnGraded ? `${title || 'this material'}${page ? `, page ${page}` : ''}` : String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        await startLesson({ cls: c, mode: 'topic', focus: short, ref });
      }

      function openSettings() {
        const s = state.settings;
        const box = el('div', 'sem-settings');
        el('h2', null, 'Semester settings', box);
        const row = (label) => { const r = el('label', 'sem-set-row', null, box); el('span', null, label, r); return r; };
        const model = el('select', null, null, row('Model for new chats'));
        for (const m of ['haiku', 'sonnet', 'opus']) { const o = el('option', null, `Claude ${m}`, model); o.value = m; }
        model.value = s.model;
        const fb = el('input', null, null, row('Use the API key when the subscription limit is hit')); fb.type = 'checkbox'; fb.checked = s.apiFallback;
        const cap = el('input', null, null, row('Monthly API limit (USD)')); cap.type = 'number'; cap.min = '0'; cap.max = '100'; cap.value = String(s.apiCapUsd);
        const gq = el('input', null, null, row('Add question chats to the knowledge graph')); gq.type = 'checkbox'; gq.checked = s.graphQuestions !== false;
        el('p', 'sem-muted', 'Chats normally run on your Claude subscription through LearnHarness\'s Claude Code connection. Existing chats keep their model.', box);
        const save = el('button', 'sem-btn', 'Save', box); save.type = 'button';
        const dlg = keep(ctx.ui.openDialog({ title: 'Semester settings', content: box }, { signal }));
        save.onclick = guard(async () => { await ctx.call('settings', { model: model.value, apiFallback: fb.checked, apiCapUsd: Number(cap.value), graphQuestions: gq.checked }); dlg.dispose(); await refreshState(); renderSide(); });
      }

      function render() { if (!alive) return; renderSide(); if (current && chat) renderChat(); else if (classPage) void renderClass(); else void renderHome(); }

      async function refreshState() {
        const [st, f] = await Promise.all([ctx.call('state'), ctx.call('feed').catch(() => null)]);
        state = st; if (f) lastFeed = f;
        void syncGraph(); void extractQuiet();
      }

      // Class lessons idle for 15 minutes get their knowledge-map extraction (LearnHarness waits for ~4k new tokens,
      // which a study block often doesn't reach), so the map and Flashcards keep up.
      let extracting = false;
      async function extractQuiet() {
        if (extracting || !alive) return;
        extracting = true;
        try {
          for (const id of await ctx.call('extract-due').catch(() => [])) {
            const r = await fetch('/api/graph/coverage/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: id }) }).catch(() => null);
            if (r && (r.ok || r.status === 409)) await ctx.call('extract-mark', { id }).catch(() => {});
          }
        } finally { extracting = false; }
      }

      // Finished answers → LearnHarness's knowledge graph (Settings: "Add question chats to the knowledge graph").
      // One at a time, in the background; each is a notes source named "Q · <question>" in the class folder.
      let graphBusy = false;
      async function syncGraph() {
        if (graphBusy || !alive) return;
        graphBusy = true;
        try {
          for (;;) {
            const pending = await ctx.call('graph-pending').catch(() => []);
            if (!pending.length || !alive) break;
            for (const p of pending) {
              let ok = false, error = '';
              try {
                const form = new FormData();
                form.append('files', new File([p.text], p.file, { type: 'text/markdown' }));
                const r = await fetch('/api/graph/import', { method: 'POST', body: form });
                const j = await r.json().catch(() => ({}));
                const res = j.results?.[0];
                if (!r.ok || !res?.ok) throw new Error(res?.error || j.error || `import said ${r.status}`);
                const dir = await lh('/api/graph/sources');
                const src = (dir.sources || []).find((x) => x.kind === 'notes' && x.filePath === p.file);
                if (src) {
                  const folder = await questionsFolder(p.cls);
                  await lh('/api/graph/sources', { action: 'move', kind: 'source', id: src.id, parentId: folder });
                  await lh('/api/graph/sources', { action: 'rename-source', id: src.id, name: p.name });
                }
                ok = true;
              } catch (e) { error = e instanceof Error ? e.message : String(e); }
              const marked = await ctx.call('graph-mark', { chatId: p.chatId, turnId: p.turnId, ok, error }).then(() => true, () => false);
              if (!ok || !marked) return; // try again on a later refresh, never re-import in a tight loop
            }
          }
        } finally { graphBusy = false; }
      }

      const offNote = ctx.onNotification((ev) => {
        if (ev.topic === 'feed') {
          checkingMoodle = false;
          // Automatic catch-up checks stay quiet (a failed one is retried 10 min later); checks you start report back.
          if (!ev.data?.auto) toast(ev.data?.ok ? `Moodle checked: ${ev.data.out}` : `Moodle check failed: ${String(ev.data?.out || '').replace(/^watcher: /, '')}`);
          void ctx.call('feed').then((f) => { if (f) lastFeed = f; }, () => null).then(() => { if (!alive) return; if (!current) render(); else renderSide(); });
          return;
        }
        if (ev.topic !== 'chat') return;
        void guard(async () => {
          await refreshState();
          if (current && ev.data?.id === current) { chat = await ctx.call('chat', { id: current }); render(); }
          else if (classPage) render(); // class page: its question list
          else renderSide(); // Home: keep what's on screen
        })();
      });
      // While an answer streams, re-read the open chat for the partial text (visible view only).
      const timer = setInterval(() => {
        if (!alive || !current || !chat || chat.turns.at(-1)?.status !== 'running' || document.hidden) return;
        void guard(async () => { const c = await ctx.call('chat', { id: current }); if (alive && c.id === current) { chat = c; renderChat(); } })();
      }, 1500);
      const extractTimer = setInterval(() => { if (!document.hidden) void extractQuiet(); }, 5 * 60e3);
      const offResync = ctx.onResync(() => void guard(async () => { await refreshState(); if (current) chat = await ctx.call('chat', { id: current }); render(); })());

      void guard(async () => { await refreshState(); render(); })();
      // One folder per class in LearnHarness's sidebar (${ROOT_FOLDER} › SDMS, CV1, …): lessons filed there are that
      // class's tutors. Created once if missing; renamed or moved folders are found by name (see folderIsClass).
      void (async () => {
        try {
          const dir = await lh('/api/graph/sources');
          const have = (dir.organization?.folders || []).map((f) => f.name);
          for (const cls of LEARN_CLASSES) if (!have.some((n) => folderIsClass(n, cls))) await classFolder(cls);
        } catch { /* LearnHarness routes unavailable: lessons can still be filed by hand */ }
      })();

      return () => {
        alive = false; clearInterval(timer); clearInterval(extractTimer); offNote(); offResync(); clearPane();
        for (const h of handles) { try { h.dispose(); } catch { /* already gone */ } }
        container.replaceChildren(); container.classList.remove('sem-root');
      };
    },
  });
  ctx.registerAction({ id: 'open', name: 'Open Semester', run: () => ctx.app.openView('semester') });
  ctx.placeAction({ id: 'sidebar-open', actionId: 'open', location: 'sidebar' });
}
