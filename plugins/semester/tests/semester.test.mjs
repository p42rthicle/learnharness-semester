// Offline tests: made-up course index, a fake LearnHarness host and a mock Anthropic API. No real files or keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { checkCitations, citedRefs, courseTools, extractTurn, isLimitError, moodleTool, refsInToolOutput } from '../src/ask.mjs';
import { askViaApi, costOf, makeLedger } from '../src/fallback.mjs';
import { makeSearcher, refOf, tokenize } from '../src/search.mjs';

const CANARY = 'GRADED_CANARY_91f2';
const doc = (id, cls, p, title, kind = 'slides', graded = false, pages = 1) => ({ id: id.padEnd(12, '0'), cls, path: p, title, kind, graded, pages, bytes: 1, mtime: new Date().toISOString() });
const INDEX = {
  version: 1, semester: true,
  docs: [
    doc('aaaa1111', 'CV1', 'CV1/Slides/l6-edges.pdf', 'l6-edges', 'slides', false, 2),
    doc('bbbb2222', 'SDMS', 'SDMS/Slides/02-indexing.pdf', '02-indexing'),
    doc('cccc3333', 'IntroLLM', 'IntroLLM/homeworks/HW03.ipynb', 'HW03', 'homework', true),
    doc('dddd4444', 'TA', 'Additional resources/TA/Overview.md', 'Overview', 'links'),
  ],
  pages: [
    { d: 0, p: 1, t: 'Edge detection overview. Gradients.' },
    { d: 0, p: 2, t: 'The Canny edge detector: smoothing, gradient, non-maximum suppression, hysteresis thresholds.' },
    { d: 1, p: 1, t: 'B+ trees: fanout and height. Inner nodes store keys only.' },
    { d: 2, p: 1, t: `Homework 3: implement scaled dot-product attention. ${CANARY}` },
    { d: 3, p: 1, t: 'Worth a look: an example talk that opens with a personal story.' },
  ],
};
const S = makeSearcher(INDEX);
const CANNY = 'aaaa1111:2';

describe('search', () => {
  test('tokenizer: lowercase, stop words, plurals', () => {
    assert.deepEqual(tokenize('The Trees and the Queries of B+ trees'), ['tree', 'query', 'b+', 'tree']);
  });
  test('finds the right page, with ref, class and snippet', () => {
    const r = S.search('canny non-maximum suppression');
    assert.equal(r[0].ref, CANNY);
    assert.equal(r[0].cls, 'CV1');
    assert.match(r[0].snippet, /Canny/);
    assert.equal(refOf(INDEX.docs[0], 2), CANNY);
  });
  test('class filter holds', () => {
    assert.equal(S.search('fanout canny', { classes: ['SDMS'] }).every((x) => x.cls === 'SDMS'), true);
    assert.equal(S.search('canny', { classes: ['SDMS'] }).length, 0);
  });
  test('graded docs are searchable but flagged', () => {
    const r = S.search('attention homework');
    assert.equal(r[0].graded, true);
    assert.deepEqual(S.graded().map((g) => g.path), ['IntroLLM/homeworks/HW03.ipynb']);
  });
  test('read: full text, max 6 pages, class limit', () => {
    const r = S.read('aaaa1111', [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(r.pages.length, 2);
    assert.match(r.pages[1].text, /hysteresis/);
    assert.match(S.read('aaaa1111', [1], { classes: ['SDMS'] }).error, /outside the selected classes/);
    assert.match(S.read('ffff0000', [1]).error, /No document/);
  });
});

describe('ask helpers', () => {
  test('a class chat\'s tools only search that class, whatever the model asks', async () => {
    const [search, read] = courseTools(() => S, 'SDMS');
    const out = (await search.execute('t1', { query: 'canny fanout', classes: ['CV1'] })).content[0].text;
    assert.match(out, /bbbb2222/);
    assert.doesNotMatch(out, /aaaa1111/);
    assert.match((await read.execute('t2', { doc: 'aaaa1111', pages: [2] })).content[0].text, /outside the selected classes/);
  });
  test('citations: only refs returned by a tool in this chat are verified', async () => {
    const [search] = courseTools(() => S, 'all');
    const out = (await search.execute('t1', { query: 'canny' })).content[0].text;
    const seen = refsInToolOutput([out]);
    assert.ok(seen.has(CANNY));
    const text = `Canny thins edges with NMS [${CANNY}]. B+ trees have high fanout [bbbb2222:1]. Made up [eeee5555:3].`;
    assert.deepEqual(citedRefs(text), [CANNY, 'bbbb2222:1', 'eeee5555:3']);
    const c = checkCitations(text, seen, S);
    assert.deepEqual(c.map((x) => [x.n, x.verified]), [[1, true], [2, false], [3, false]]);
    assert.equal(c[0].page, 2);
    assert.equal(c[2].path, undefined);
  });
  test('moodle_info: upcoming deadlines (deduped, with status), recent files, class-limited in a class chat', async () => {
    const soon = new Date(Date.now() + 3 * 864e5).toISOString(), old = new Date(Date.now() - 10 * 864e5).toISOString();
    const feed = { lastRun: new Date().toISOString(), deadlines: [
      { cls: 'MC', title: 'Exercise 4', due: soon, kind: 'event', submitted: null },
      { cls: 'MC', title: 'Exercise 4', due: soon, kind: 'assign', submitted: false },
      { cls: 'MC', title: 'Exercise 2', due: old, kind: 'assign', submitted: true },
      { cls: 'CV1', title: 'Quiz 6', due: soon, kind: 'quiz', submitted: null },
    ], recent: [{ cls: 'MC', name: 'MC_07.pdf', savedTo: 'MC/Slides/MC_07.pdf', at: new Date().toISOString() }] };
    const run = async (scope, args) => JSON.parse((await moodleTool(() => feed, scope).execute('m', args)).content[0].text);
    const mc = await run('MC', { classes: ['CV1'] });
    assert.deepEqual(mc.deadlines.map((d) => [d.title, d.submitted]), [['Exercise 4', false]]);
    assert.equal(mc.recentFiles[0].file, 'MC_07.pdf');
    assert.equal((await run('all', { include_past: true })).deadlines.length, 3);
    assert.match(JSON.stringify(await moodleTool(() => null, 'all').execute('m', {})), /not available/);
  });
  test('grouped refs [a:1, b:2] are both cited', () => {
    assert.deepEqual(citedRefs(`x [${CANNY}, bbbb2222:1]`), [CANNY, 'bbbb2222:1']);
  });
  test('extractTurn: final text, tool outputs, lookups', () => {
    const msgs = [
      { role: 'user', content: 'old' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'toolCall', id: '1', name: 'search_course', arguments: { query: 'canny' } }], usage: { input: 10, output: 5 } },
      { role: 'toolResult', toolCallId: '1', toolName: 'search_course', content: [{ type: 'text', text: `{"ref": "${CANNY}"}` }], isError: false },
      { role: 'assistant', content: [{ type: 'text', text: `Answer [${CANNY}]` }], usage: { input: 20, output: 7 }, stopReason: 'stop' },
    ];
    const t = extractTurn(msgs, 1);
    assert.equal(t.answer, `Answer [${CANNY}]`);
    assert.deepEqual(t.searches, ['search: canny']);
    assert.equal(t.usage.input, 30);
    assert.ok(refsInToolOutput(t.toolTexts).has(CANNY));
  });
  test('limit errors are recognised', () => {
    for (const m of ['Claude Code usage limit reached. Check your provider account', 'Claude AI usage limit reached|1764000000',
      "You've hit your limit · resets 5pm (Europe/Berlin)", '5-hour limit reached', 'You are out of extra usage', 'Weekly limit reached']) assert.ok(isLimitError(m), m);
    // Transient or unrelated errors must never send a question to the paid API.
    for (const m of ['ENOENT', 'invalid tool arguments', '429 Too Many Requests', 'rate_limit_error', 'Context limit reached', 'max_tokens limit reached']) assert.ok(!isLimitError(m), m);
  });
});

// ---------- mock Anthropic API ----------
function mockApi() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push({ headers: req.headers, body, raw });
      const last = body.messages.at(-1);
      const hadTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
      const content = hadTool
        ? [{ type: 'text', text: `Canny uses non-maximum suppression [${CANNY}].` }]
        : [{ type: 'tool_use', id: `tu_${calls.length}`, name: 'search_course', input: { query: 'canny' } }];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content,
        stop_reason: hadTool ? 'end_turn' : 'tool_use', stop_sequence: null,
        usage: { input_tokens: 100000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }));
    });
  });
  return { calls, server };
}

describe('API fallback', () => {
  const api = mockApi();
  let base;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semester-fb-'));
  before(async () => { await new Promise((r) => api.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${api.server.address().port}`; });
  after(() => { api.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('costs: Sonnet 5.5 price table', () => {
    assert.equal(costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12);
    assert.equal(costOf('claude-haiku-5-5', { input_tokens: 1e6 }), 0.1);
  });

  test('runs the tool loop, sends the workspace header, counts the cost', async () => {
    const ledger = makeLedger(dir, 20);
    const r = await askViaApi({ apiKey: 'sk-ant-test-xyz', workspaceId: 'wrkspc_test', baseURL: base, model: 'claude-sonnet-5-5',
      system: 'sys', history: [{ q: 'earlier', answer: 'earlier answer' }], question: 'What does Canny do?',
      tools: courseTools(() => S, 'all'), ledger });
    assert.match(r.answer, /non-maximum suppression/);
    assert.equal(api.calls.length, 2);
    assert.equal(api.calls[0].headers['anthropic-workspace-id'], 'wrkspc_test');
    assert.equal(api.calls[0].body.messages[0].content, 'earlier');
    assert.ok(r.cost > 0.4 && r.cost < 0.5, String(r.cost)); // 2 × (100k in + 1k out) on Sonnet
    assert.equal(ledger.spent().toFixed(4), r.cost.toFixed(4));
    assert.ok(!fs.readFileSync(path.join(dir, 'api-spend.json'), 'utf8').includes('sk-ant'));
  });

  test('stops at the monthly cap', async () => {
    const ledger = makeLedger(dir, 0.5); // ~0.43 already spent above
    await assert.rejects(askViaApi({ apiKey: 'k', baseURL: base, model: 'claude-sonnet-5-5', system: 's', history: [], question: 'q',
      tools: courseTools(() => S, 'all'), ledger }), /limit/);
    const n = api.calls.length;
    await assert.rejects(askViaApi({ apiKey: 'k', baseURL: base, model: 'claude-sonnet-5-5', system: 's', history: [], question: 'q',
      tools: courseTools(() => S, 'all'), ledger }), /reached this month/);
    assert.equal(api.calls.length, n, 'no request once the cap is used up');
  });
});

// ---------- the backend against a fake LearnHarness host ----------
function fakeHost(dataDirectory, script) {
  const handlers = new Map(), emitted = [], defs = new Map(), sessions = new Map(), cleanups = [];
  let n = 0;
  const snap = (s) => JSON.parse(JSON.stringify(s));
  const ctx = {
    dataDirectory, signal: new AbortController().signal,
    cleanup: (f) => cleanups.push(f),
    handle: (name, fn) => handlers.set(name, fn),
    events: { emit: (topic, data) => emitted.push({ topic, data }) },
    registerInstructions: (c) => { ctx.instr = c; return () => {}; },
    registerTools: (c) => { ctx.lessonTools = c; return () => {}; },
    inference: { catalog: async () => ({ models: [{ provider: 'claude-code', id: 'sonnet' }, { provider: 'claude-code', id: 'haiku' }] }) },
    agents: {
      register: (d) => { defs.set(d.id, d); return () => defs.delete(d.id); },
      create: (defId) => { const s = { id: `ag${++n}`, definitionId: defId, messages: [], status: 'idle', pending: [] }; sessions.set(s.id, s); return snap(s); },
      get: (id) => snap(sessions.get(id)),
      list: () => [...sessions.values()].map(snap),
      abort: () => {},
      subscribe: (id, fn) => { const s = sessions.get(id); s.listeners = [...(s.listeners || []), fn]; fn(snap({ ...s, listeners: undefined })); return () => { s.listeners = s.listeners.filter((x) => x !== fn); }; },
      send: async (id, text) => {
        const s = sessions.get(id);
        s.messages.push({ role: 'user', content: text });
        s.status = 'running'; s.error = undefined;
        setTimeout(async () => { await script(s, defs.get(s.definitionId), text); s.listeners?.forEach((f) => f(snap({ ...s, listeners: undefined }))); }, 5);
        return snap({ ...s, listeners: undefined });
      },
    },
  };
  return { ctx, call: (name, input) => handlers.get(name)(input), emitted, defs, sessions };
}

async function waitFor(fn, ms = 3000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
}

describe('backend with a fake LearnHarness', () => {
  const api = mockApi();
  let base, root, dataDir, backend;
  before(async () => {
    await new Promise((r) => api.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${api.server.address().port}`;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'semester-root-'));
    fs.mkdirSync(path.join(root, 'Dashboard/index/out-semester'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Dashboard/index/out-semester/index.json.gz'), zlib.gzipSync(JSON.stringify(INDEX)));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semester-data-'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ root }));
    Object.assign(process.env, { WISE_ANTHROPIC_KEY: 'sk-ant-test-backend', WISE_ANTHROPIC_WORKSPACE: 'wrkspc_x', WISE_ANTHROPIC_URL: base });
    backend = await import('../src/backend.mjs');
  });
  after(() => { api.server.close(); for (const d of [root, dataDir]) fs.rmSync(d, { recursive: true, force: true }); });

  // The "subscription" model: searches with the definition's own tools, then answers citing what it found.
  const goodScript = async (s, def, text) => {
    const tool = def.tools.find((t) => t.name === 'search_course');
    const res = await tool.execute('c1', { query: /fanout/.test(text) ? 'fanout' : 'canny', classes: ['CV1', 'SDMS'] });
    const ref = JSON.parse(res.content[0].text).results[0]?.ref || 'none';
    s.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'search_course', arguments: { query: 'x' } }] });
    s.messages.push({ role: 'toolResult', toolCallId: 'c1', toolName: 'search_course', content: res.content, isError: false });
    s.messages.push({ role: 'assistant', content: [{ type: 'text', text: `Here it is [${ref}] and an invented one [eeee5555:1].` }], stopReason: 'stop' });
    s.status = 'idle';
  };

  test('lessons get the course tools and the graded rule', () => {
    const h = fakeHost(dataDir, goodScript);
    backend.activate(h.ctx);
    assert.deepEqual(h.ctx.instr.agents, ['prober', 'teacher', 'practice']);
    assert.match(h.ctx.instr.text, /never solve/);
    assert.deepEqual(h.ctx.lessonTools.create({}).map((t) => t.name), ['search_course', 'read_pages', 'view_page']);
  });

  test('an SDMS chat: answered on the subscription, scoped, citations checked, free', async () => {
    const h = fakeHost(dataDir, goodScript);
    backend.activate(h.ctx);
    const { id } = await h.call('ask', { scope: 'SDMS', text: 'What is the fanout of a B+ tree?' });
    const chat = await waitFor(() => { const c = h.call('chat', { id }); return c.turns[0].status !== 'running' && c; });
    const t = chat.turns[0];
    assert.equal(t.status, 'done', t.error);
    assert.equal(t.via, 'subscription');
    assert.equal(t.cost, 0);
    assert.equal(chat.scope, 'SDMS');
    assert.equal(chat.title, 'What is the fanout of a B+ tree?');
    assert.deepEqual(t.citations.map((c) => [c.ref, c.verified]), [['bbbb2222:1', true], ['eeee5555:1', false]]);
    assert.equal(h.defs.get('ask-SDMS-sonnet').model.provider, 'claude-code');
    assert.ok(h.emitted.some((e) => e.topic === 'chat' && e.data.id === id));
    // a follow-up continues the same LearnHarness conversation
    await h.call('ask', { id, text: 'And the height?' });
    const c2 = await waitFor(() => { const c = h.call('chat', { id }); return c.turns[1]?.status === 'done' && c; });
    assert.equal(c2.agentId, chat.agentId);
    assert.equal(h.sessions.get(chat.agentId).messages.filter((m) => m.role === 'user').length, 2);
    assert.equal(api.calls.length, 0, 'no API use while the subscription works');
  });

  test('subscription limit → the API answers, cost counted, later turns tell the conversation', async () => {
    let limited = true;
    const h = fakeHost(dataDir, async (s, def, text) => {
      if (limited) { s.status = 'error'; s.error = 'Claude Code usage limit reached. Check your provider account and try again later.'; return; }
      return goodScript(s, def, text);
    });
    backend.activate(h.ctx);
    const { id } = await h.call('ask', { scope: 'all', text: 'Explain Canny' });
    const chat = await waitFor(() => { const c = h.call('chat', { id }); return c.turns[0].status !== 'running' && c; });
    const t = chat.turns[0];
    assert.equal(t.status, 'done', t.error);
    assert.equal(t.via, 'api');
    assert.match(t.note, /usage limit/);
    assert.ok(t.cost > 0);
    assert.equal(t.citations[0].verified, true);
    assert.equal(api.calls[0].headers['anthropic-workspace-id'], 'wrkspc_x');
    const st = h.call('state');
    assert.ok(st.api.spent > 0 && st.api.cap === 20);
    limited = false;
    await h.call('ask', { id, text: 'Thanks, and hysteresis?' });
    await waitFor(() => h.call('chat', { id }).turns[1]?.status === 'done');
    const sent = h.sessions.get(chat.agentId).messages.filter((m) => m.role === 'user').at(-1).content;
    assert.match(sent, /answered while you were unavailable/);
    assert.match(sent, /Explain Canny/);
  });

  test('files: actions refuse paths outside the semester folder; key never stored', async () => {
    const h = fakeHost(dataDir, goodScript);
    backend.activate(h.ctx);
    await assert.rejects(h.call('open', { path: '../'.repeat(20) + 'etc/hosts' }), /Outside the semester folder/);
    fs.writeFileSync(path.join(root, 'evil.command'), 'echo hi');
    await assert.rejects(h.call('open', { path: 'evil.command' }), /Only documents/);
    for (const f of fs.readdirSync(dataDir)) assert.ok(!fs.readFileSync(path.join(dataDir, f), 'utf8').includes('sk-ant-test'), f);
  });

  test('no Claude Code connection: an error, never a paid API answer', async () => {
    const h = fakeHost(dataDir, goodScript);
    h.ctx.inference.catalog = async () => ({ models: [{ provider: 'openai', id: 'gpt' }] });
    backend.activate(h.ctx);
    const n = api.calls.length;
    await assert.rejects(h.call('ask', { scope: 'all', text: 'hello' }), /Claude Code \(sonnet\) isn't available/);
    assert.equal(api.calls.length, n);
  });

  test('a failure before the run starts does not leave the chat stuck', async () => {
    const h = fakeHost(dataDir, goodScript);
    h.ctx.agents.create = () => { throw new Error('agent store broken'); };
    backend.activate(h.ctx);
    const c = h.call('new-chat', { scope: 'CV1' });
    await h.call('ask', { id: c.id, text: 'one' });
    let chat = h.call('chat', { id: c.id });
    assert.equal(chat.turns[0].status, 'error');
    assert.match(chat.turns[0].error, /agent store broken/);
    await h.call('ask', { id: c.id, text: 'two' }); // not "still answering"
    chat = h.call('chat', { id: c.id });
    assert.equal(chat.turns.length, 2);
  });

  test('a follow-up may cite a page found in an earlier turn', async () => {
    let n = 0;
    const h = fakeHost(dataDir, async (s, def, text) => {
      if (++n === 1) return goodScript(s, def, text);
      s.messages.push({ role: 'assistant', content: [{ type: 'text', text: `As before [bbbb2222:1].` }], stopReason: 'stop' });
      s.status = 'idle';
    });
    backend.activate(h.ctx);
    const { id } = await h.call('ask', { scope: 'SDMS', text: 'fanout of B+ trees?' });
    await waitFor(() => h.call('chat', { id }).turns[0].status === 'done');
    await h.call('ask', { id, text: 'remind me?' });
    const c = await waitFor(() => { const x = h.call('chat', { id }); return x.turns[1]?.status === 'done' && x; });
    assert.deepEqual(c.turns[1].citations.map((x) => [x.ref, x.verified]), [['bbbb2222:1', true]]);
  });
});
