// Class tutors: folder → class, per-session tools, "what's new" and the lesson list. Offline: a made-up index,
// a made-up LearnHarness learning folder and a fake plugin host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { classOfFolderName, classOfSession, inferMode, lastStudied, makeTutorStore, newDocs, seenUpTo, sessionProgress, tutorOpening } from '../src/tutors.mjs';
import { berlinToIso, keyDates, makeDateStore, parseIcs, readTucan } from '../src/dates.mjs';
import { extractTurn } from '../src/ask.mjs';

const OLD = '2026-11-01T10:00:00.000Z', NEW = '2026-11-22T10:00:00.000Z';
const doc = (id, cls, p, mtime, kind = 'slides', graded = false) => ({ id: id.padEnd(12, '0'), cls, path: p, title: path.basename(p, path.extname(p)), kind, graded, pages: 3, bytes: 1, mtime });
const INDEX = {
  version: 1, semester: true,
  docs: [
    doc('aaaa1111', 'CV1', 'CV1/Slides/l5-features.pdf', OLD),
    doc('bbbb2222', 'CV1', 'CV1/Slides/l7-optical-flow.pdf', NEW),
    doc('cccc3333', 'CV1', 'Additional resources/CV1/Overview.md', NEW, 'links'),
    doc('dddd4444', 'MC', 'MC/Slides/MC_07.pdf', NEW),
    doc('eeee5555', 'CV1', 'CV1/Exercises/hw3.pdf', NEW, 'homework', true),
  ],
  pages: [
    { d: 0, p: 1, t: 'Harris corners' }, { d: 1, p: 1, t: 'Optical flow, brightness constancy' },
    { d: 2, p: 1, t: 'links' }, { d: 3, p: 1, t: 'CTL' }, { d: 4, p: 1, t: 'Homework 3' },
  ],
};
const ORG = {
  version: 1,
  folders: [
    { id: 'f_root', name: 'WiSe 26/27', parentId: null, createdAt: OLD },
    { id: 'f_cv1', name: 'CV1', parentId: 'f_root', createdAt: OLD },
    { id: 'f_deep', name: 'exam', parentId: 'f_cv1', createdAt: OLD },
    { id: 'f_mc', name: 'MC – Model Checking', parentId: null, createdAt: OLD },
    { id: 'f_misc', name: 'Hobbies', parentId: null, createdAt: OLD },
  ],
  placements: {
    chat_cv1: { folderId: 'f_cv1' }, chat_deep: { folderId: 'f_deep' }, chat_mc: { folderId: 'f_mc' },
    chat_misc: { folderId: 'f_misc' }, chat_gone: { folderId: 'f_missing' },
  },
};

describe('tutor helpers', () => {
  test('folder names map to classes', () => {
    assert.equal(classOfFolderName('CV1'), 'CV1');
    assert.equal(classOfFolderName('cv1'), 'CV1');
    assert.equal(classOfFolderName('MC – Model Checking'), 'MC');
    assert.equal(classOfFolderName('IntroLLM'), 'IntroLLM');
    assert.equal(classOfFolderName('CV10'), null);
    assert.equal(classOfFolderName('Hobbies'), null);
    assert.equal(classOfFolderName('TAX'), null);
  });
  test('a session takes the class of its folder or any parent folder', () => {
    assert.equal(classOfSession(ORG, 'chat_cv1'), 'CV1');
    assert.equal(classOfSession(ORG, 'chat_deep'), 'CV1');
    assert.equal(classOfSession(ORG, 'chat_mc'), 'MC');
    assert.equal(classOfSession(ORG, 'chat_misc'), null);
    assert.equal(classOfSession(ORG, 'chat_gone'), null);
    assert.equal(classOfSession(ORG, 'chat_unfiled'), null);
    assert.equal(classOfSession(null, 'chat_cv1'), null);
    const loop = { folders: [{ id: 'a', name: 'x', parentId: 'b' }, { id: 'b', name: 'y', parentId: 'a' }], placements: { c: { folderId: 'a' } } };
    assert.equal(classOfSession(loop, 'c'), null); // a broken (cyclic) tree does not hang
  });
  test('new docs: by class and time, link overviews left out, graded included', () => {
    assert.deepEqual(newDocs(INDEX, 'CV1', '2026-11-10T00:00:00Z').map((d) => d.title), ['l7-optical-flow', 'hw3']);
    assert.equal(newDocs(INDEX, 'CV1', OLD).length, 2);
    assert.equal(newDocs(INDEX, 'CV1', '2026-11-23T00:00:00Z').length, 0);
  });
  test('a check covers files up to the index build, not up to now (later downloads are not indexed yet)', () => {
    assert.equal(seenUpTo({ built: '2026-11-20T08:00:00.000Z' }), '2026-11-20T08:00:00.000Z');
    const t = Date.parse(seenUpTo({}));
    assert.ok(Math.abs(t - Date.now()) < 5000);
    assert.ok(Date.parse(seenUpTo({ built: '2999-01-01T00:00:00Z' })) <= Date.now() + 1000);
  });
  test('lesson type from title/kind; progress from tagged plan nodes; when the learner last studied', () => {
    assert.equal(inferMode('Exam SDMS', 'teaching'), 'exam');
    assert.equal(inferMode('SDMS Klausur', undefined), 'exam');
    assert.equal(inferMode('HW 3 concepts', 'teaching'), 'homework');
    assert.equal(inferMode('anything', 'practice'), 'practice');
    assert.equal(inferMode('Teach me SDMS', 'teaching'), 'course');
    const rec = {
      tree: { nodes: [{ id: 'a', title: 'Pages' }, { id: 'b', title: 'Buffer pool' }, { id: 'c', title: 'B+ trees' }] },
      messages: [
        { role: 'user', timestamp: 1000 }, { role: 'assistant', content: [{ type: 'toolCall', name: 'quiz', arguments: { nodeId: 'a' } }] },
        { role: 'assistant', content: [{ type: 'toolCall', name: 'explain', arguments: { nodeId: 'b' } }] }, { role: 'user', timestamp: 5000 },
      ],
    };
    const p = sessionProgress(rec);
    assert.equal(`${p.taught}/${p.total}`, '1/3'); // like LearnHarness: the latest tagged topic is "current", not taught yet
    assert.equal(p.current, 'b');
    assert.deepEqual(p.nodes.filter((n) => !n.taught && !n.current).map((n) => n.title), ['B+ trees']);
    assert.equal(lastStudied(rec), 1000); // the newest message before this turn's input
    assert.equal(lastStudied({ messages: [{ role: 'user', timestamp: 5 }] }), null);
    assert.equal(lastStudied({ messages: [{ role: 'assistant', timestamp: 7 }, { role: 'toolResult', timestamp: 9 }] }), 7); // a quiz answer as the input
    assert.equal(sessionProgress(null).total, 0);
  });

  test('odd TUCaN files: quoted or Windows time zones, bad dates, quoted colons; one bad file hides nothing', () => {
    const ev = parseIcs(['BEGIN:VEVENT', 'SUMMARY:Klausur Model Checking', 'DTSTART;TZID="Europe/Berlin":20270209T140000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY;ALTREP="http://x.y/z":Klausureinsicht Model Checking', 'DTSTART;TZID=W. Europe Standard Time:20270310T100000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:broken', 'DTSTART:20271340T100000', 'END:VEVENT'].join('\n'));
    assert.deepEqual(ev.map((e) => [e.title, e.start]), [['Klausur Model Checking', '2027-02-09T13:00:00.000Z'], ['Klausureinsicht Model Checking', '2027-03-10T09:00:00.000Z']]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tucan2-'));
    fs.writeFileSync(path.join(dir, 'a.ics'), ['BEGIN:VEVENT', 'SUMMARY:Klausur Model Checking', 'DTSTART;TZID="Europe/Berlin":20270209T140000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Klausureinsicht Model Checking', 'DTSTART:20270310T090000Z', 'END:VEVENT'].join('\n'));
    fs.writeFileSync(path.join(dir, 'b.ics'), Buffer.from([0xff, 0xfe, 0x00]));
    const t = readTucan(dir);
    assert.deepEqual(t.map((d) => [d.cls, d.kind]), [['MC', 'exam'], ['MC', 'event']]); // the review ("Einsicht") is not the exam
    const store = makeDateStore(dir);
    store.add({ cls: 'MC', title: 'Lab hand-in', at: '2027-01-10T10:00:00Z', kind: 'deadline' });
    assert.equal(keyDates({ store, tucanDir: dir, fromMs: Date.parse('2026-11-01') }).length, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('TUCaN calendar: events, Berlin times, exams, classes by course name', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Klausur Scalable Data Management Systems', 'DTSTART;TZID=Europe/Berlin:20270208T110000',
      'DTEND;TZID=Europe/Berlin:20270208T123000', 'LOCATION:Hall 1', 'END:VEVENT', 'BEGIN:VEVENT', 'SUMMARY:Computer Vision I - Vorlesung',
      'DTSTART:20261103T080000Z', 'LOCATION:Hall 2\\, ', ' Raum 2', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const ev = parseIcs(ics);
    assert.equal(ev[0].start, '2027-02-08T10:00:00.000Z'); // 11:00 CET
    assert.equal(ev[1].start, '2026-11-03T08:00:00.000Z');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tucan-'));
    fs.writeFileSync(path.join(dir, 'export.ics'), ics);
    const t = readTucan(dir);
    assert.deepEqual(t.map((d) => [d.cls, d.kind]), [['CV1', 'event'], ['SDMS', 'exam']]);
    const store = makeDateStore(dir);
    store.add({ cls: 'MC', title: 'Exam', at: '2027-02-09T13:00:00Z', kind: 'exam' });
    assert.throws(() => store.add({ cls: 'XYZ', title: 'x', at: '2027-01-01' }), /Unknown class/);
    assert.throws(() => store.add({ cls: 'MC', title: '', at: '2027-01-01' }), /name/);
    assert.deepEqual(keyDates({ store, tucanDir: dir, cls: 'SDMS', fromMs: Date.parse('2026-11-01') }).map((d) => d.title), ['Klausur Scalable Data Management Systems']);
    assert.equal(keyDates({ store, tucanDir: dir, fromMs: Date.parse('2026-11-01') }).length, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('pin offers: Berlin wall time to ISO; suggest_date calls are collected from the answer', () => {
    assert.equal(berlinToIso('2027-02-08 11:00'), '2027-02-08T10:00:00.000Z');
    assert.equal(berlinToIso('2027-06-01T10:00'), '2027-06-01T08:00:00.000Z');
    assert.equal(berlinToIso('2027-03-03'), '2027-03-02T23:00:00.000Z');
    assert.equal(berlinToIso('next Tuesday'), null);
    const t = extractTurn([{ role: 'assistant', content: [{ type: 'toolCall', name: 'suggest_date', arguments: { class: 'SDMS', title: 'Exam', when: '2027-02-08 11:00', kind: 'exam' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'On 8 Feb.' }], stopReason: 'stop' }], 0);
    assert.deepEqual(t.suggestions, [{ class: 'SDMS', title: 'Exam', when: '2027-02-08 11:00', kind: 'exam' }]);
  });

  test('opening messages: titles per lesson type; homework keeps the graded rule', () => {
    assert.equal(tutorOpening({ cls: 'CV1', mode: 'exam' }).title, 'CV1 · Exam prep');
    assert.equal(tutorOpening({ cls: 'CV1', mode: 'course' }).title, 'CV1 · Course');
    const hw = tutorOpening({ cls: 'IntroLLM', mode: 'homework', focus: 'Homework 3' });
    assert.equal(hw.title, 'IntroLLM · Homework 3 concepts');
    assert.match(hw.text, /don't solve, outline or check/);
    assert.match(tutorOpening({ cls: 'MC', mode: 'topic', focus: 'CTL fixpoints' }).text, /Teach me CTL fixpoints/);
  });
});

describe('tutors in the backend', () => {
  let root, dataDir, learning, backend;
  const handlers = new Map();
  const ctx = {};
  const SESSIONS = [
    { id: 'chat_cv1', title: 'CV1 · Exam prep', createdAt: OLD, updatedAt: '2026-11-20T09:00:00Z', kind: 'teaching', busy: false },
    { id: 'chat_mc', title: 'Model Checking', createdAt: OLD, updatedAt: '2026-11-07T20:50:00Z', kind: 'teaching', busy: false },
    { id: 'chat_misc', title: 'Sourdough', createdAt: OLD, updatedAt: OLD, kind: 'teaching', busy: false },
  ];
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-root-'));
    fs.mkdirSync(path.join(root, 'Dashboard/index/out-semester'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Dashboard/index/out-semester/index.json.gz'), zlib.gzipSync(JSON.stringify(INDEX)));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-data-'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ root }));
    learning = fs.mkdtempSync(path.join(os.tmpdir(), 'tutor-lh-'));
    fs.mkdirSync(path.join(learning, 'graph'));
    fs.writeFileSync(path.join(learning, 'graph/source-organization.json'), JSON.stringify(ORG));
    Object.assign(ctx, {
      dataDirectory: dataDir, signal: new AbortController().signal, cleanup: () => {},
      handle: (n, f) => handlers.set(n, f), events: { emit: () => {} },
      registerInstructions: (c) => { ctx.instr = c; }, registerTools: (c) => { ctx.lessonTools = c; },
      inference: { catalog: async () => ({ models: [] }) },
      agents: { register: () => () => {}, create: () => ({}), get: () => ({ messages: [] }), subscribe: () => () => {}, send: async () => {}, abort: () => {} },
      learning: { directory: learning, listSessions: () => SESSIONS, getSession: () => null },
    });
    backend = await import('../src/backend.mjs');
    backend.activate(ctx);
  });
  after(() => { for (const d of [root, dataDir, learning]) fs.rmSync(d, { recursive: true, force: true }); });

  test('a session outside class folders searches everything and has no class_updates', () => {
    const names = ctx.lessonTools.create({ chatId: 'chat_misc', agent: 'teacher' }).map((t) => t.name);
    assert.deepEqual(names, ['search_course', 'read_pages', 'view_page']);
    assert.match(ctx.instr.text, /class_updates/);
  });

  test('a CV1-folder session: CV1-only search, a tutor brief, and what is new since it last looked', async () => {
    handlers.get('tutor-created')({ chatId: 'chat_cv1', cls: 'CV1', mode: 'exam', focus: '' });
    tutorsStore().set('chat_cv1', { lastCheck: '2026-11-10T00:00:00Z' }); // pretend the last lesson was on 10 Nov
    const tools = ctx.lessonTools.create({ chatId: 'chat_cv1', agent: 'teacher' });
    assert.deepEqual(tools.map((t) => t.name), ['search_course', 'read_pages', 'view_page', 'class_updates', 'class_progress', 'moodle_info']);
    const upd = tools.find((t) => t.name === 'class_updates');
    assert.match(upd.description, /CV1 tutor/);
    assert.match(upd.description, /exam/);
    assert.match(upd.description, /plan_init/);
    const search = tools.find((t) => t.name === 'search_course');
    const hits = JSON.parse((await search.execute('x', { query: 'CTL', classes: ['MC'] })).content[0].text).results;
    assert.equal(hits.length, 0); // MC asked for, but this session only searches CV1
    const first = JSON.parse((await upd.execute('u1', {})).content[0].text);
    assert.deepEqual(first.newFiles.map((f) => f.title), ['l7-optical-flow', 'hw3']);
    assert.equal(first.newFiles.find((f) => f.title === 'hw3').graded, true);
    const again = JSON.parse((await upd.execute('u2', {})).content[0].text);
    assert.equal(again.newFiles.length, 0); // reported once, then marked seen
  });

  test('the tools factory never throws (that would drop the graded rule for the turn)', () => {
    const saved = ctx.learning.listSessions;
    ctx.learning.listSessions = () => { throw new Error('broken store'); };
    fs.writeFileSync(path.join(learning, 'graph/source-organization.json'), JSON.stringify({ ...ORG, placements: { ...ORG.placements, chat_new: { folderId: 'f_cv1' } } }));
    try {
      const names = ctx.lessonTools.create({ chatId: 'chat_new', agent: 'teacher' }).map((t) => t.name);
      assert.ok(names.includes('search_course'));
    } finally {
      ctx.learning.listSessions = saved;
      fs.writeFileSync(path.join(learning, 'graph/source-organization.json'), JSON.stringify(ORG));
    }
  });

  test('class_progress: all sessions of the class, lectures, and the exam from pinned dates', async () => {
    handlers.get('date-add')({ cls: 'CV1', title: 'CV1 exam', at: '2027-03-03T09:00:00Z', kind: 'exam' });
    const tool = ctx.lessonTools.create({ chatId: 'chat_cv1', agent: 'teacher' }).find((t) => t.name === 'class_progress');
    const r = JSON.parse((await tool.execute('p', {})).content[0].text);
    assert.equal(r.exam.title, 'CV1 exam');
    assert.ok(r.exam.daysLeft > 0);
    assert.deepEqual(r.sessions.map((x) => [x.title, x.thisSession]), [['CV1 · Exam prep', true]]);
    assert.deepEqual(r.lectures.map((l) => l.title), ['l5-features', 'l7-optical-flow']);
    assert.equal(handlers.get('tutors')().exams.CV1.title, 'CV1 exam');
  });

  test('lessons by class for Semester: dragged-in old session counts what arrived since it started', () => {
    const r = handlers.get('tutors')();
    assert.deepEqual(r.classes.CV1.map((t) => [t.id, t.modeName, t.newCount]), [['chat_cv1', 'Exam prep', 0]]);
    assert.deepEqual(r.classes.MC.map((t) => [t.id, t.modeName, t.newCount]), [['chat_mc', 'Follow the course', 1]]);
    assert.equal(r.classes.SDMS.length, 0);
    assert.ok(!Object.values(r.classes).flat().some((t) => t.id === 'chat_misc'));
  });

  test('tutor-opening and tutor-created validate their input', () => {
    assert.throws(() => handlers.get('tutor-opening')({ cls: 'XYZ', mode: 'exam' }), /Unknown class/);
    assert.throws(() => handlers.get('tutor-opening')({ cls: 'CV1', mode: 'cram' }), /Unknown lesson type/);
    assert.throws(() => handlers.get('tutor-created')({ chatId: '../x', cls: 'CV1', mode: 'exam' }), /Bad session id/);
    const o = handlers.get('tutor-opening')({ cls: 'CV1', mode: 'topic', focus: 'optical flow', ref: 'bbbb2222:1' });
    assert.match(o.text, /CV1\/Slides\/l7-optical-flow\.pdf/);
  });

  test('site updates are read newest first', () => {
    fs.mkdirSync(path.join(root, 'Dashboard/site-updater'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Dashboard/site-updater/results.json'), JSON.stringify({ results: [{ cls: 'CV1', status: 'published', at: NEW }, { cls: 'MC', status: 'rejected', at: OLD }] }));
    assert.deepEqual(handlers.get('site-updates')().map((r) => r.cls), ['CV1', 'MC']);
  });

  const tutorsStore = () => makeTutorStore(dataDir);
});

describe('question chats → knowledge graph', () => {
  let root, dataDir, backend;
  const handlers = new Map();
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-root-'));
    fs.mkdirSync(path.join(root, 'Dashboard/index/out-semester'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Dashboard/index/out-semester/index.json.gz'), zlib.gzipSync(JSON.stringify(INDEX)));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-data-'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ root }));
    const turn = (id, q, status, answer, citations = []) => ({ id, q, at: NEW, status, via: 'subscription', answer, citations, searches: [], cost: 0 });
    fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ version: 1, chats: [
      { id: 'c_all', scope: 'all', title: 'flow', createdAt: NEW, updatedAt: NEW, agentId: null, agentModel: null, turns: [
        turn('t1', 'What is optical flow?', 'done', 'Brightness constancy [bbbb2222:1].', [{ ref: 'bbbb2222:1', cls: 'CV1', verified: true }]),
        turn('t2', 'and?', 'error', ''),
      ] },
      { id: 'c_mc', scope: 'MC', title: 'ctl', createdAt: NEW, updatedAt: NEW, agentId: null, agentModel: null, turns: [turn('t3', 'CTL?', 'done', 'Branching time.')] },
    ] }));
    const ctx = {
      dataDirectory: dataDir, signal: new AbortController().signal, cleanup: () => {}, handle: (n, f) => handlers.set(n, f), events: { emit: () => {} },
      registerInstructions: () => {}, registerTools: () => {}, inference: { catalog: async () => ({ models: [] }) },
      agents: { register: () => () => {}, create: () => ({}), get: () => ({ messages: [] }), subscribe: () => () => {}, send: async () => {}, abort: () => {} },
    };
    backend = await import('../src/backend.mjs');
    backend.activate(ctx);
  });
  after(() => { for (const d of [root, dataDir]) fs.rmSync(d, { recursive: true, force: true }); });

  test('finished answers are offered once, with their class and readable sources; failures retry at most 3 times', () => {
    assert.deepEqual(handlers.get('graph-pending')(), []); // off by default: question chats are admin, not learning
    handlers.get('settings')({ graphQuestions: true });
    const p = handlers.get('graph-pending')();
    assert.deepEqual(p.map((x) => [x.turnId, x.cls]), [['t1', 'CV1'], ['t3', 'MC']]);
    assert.match(p[0].text, /\(CV1 · l7-optical-flow, p\. 1\)/);
    assert.equal(p[0].name, 'Q · What is optical flow?');
    handlers.get('graph-mark')({ chatId: 'c_all', turnId: 't1', ok: true });
    for (let i = 0; i < 3; i++) handlers.get('graph-mark')({ chatId: 'c_mc', turnId: 't3', ok: false, error: 'busy' });
    assert.deepEqual(handlers.get('graph-pending')(), []);
    handlers.get('settings')({ graphQuestions: false });
    assert.equal(handlers.get('state')().settings.graphQuestions, false);
  });
});

