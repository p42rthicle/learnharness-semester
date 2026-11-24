// Class tutors: ordinary LearnHarness lesson sessions that sit in a class folder of LearnHarness's sidebar
// ("WiSe 26/27 › CV1"). The folder decides the class: a session in (or below) a folder named after a class is that
// class's tutor, so dragging a session into the folder makes it one and dragging it out makes it a general session
// again. Semester adds, per turn, course tools limited to that class and a class_updates tool that lists course files
// added since the tutor last looked, so the tutor can tell the learner and update its lesson plan.
import fs from 'node:fs';
import path from 'node:path';
import { CLASSES } from './search.mjs';

export const ROOT_FOLDER = 'WiSe 26/27';
export const MODES = {
  course: 'Follow the course',
  exam: 'Exam prep',
  homework: 'Homework concepts',
  topic: 'A topic',
  practice: 'Practice',
};

/** Lesson type of a session Semester did not create, from its kind and title ("Exam SDMS" → exam). */
export function inferMode(title, kind) {
  if (kind === 'practice') return 'practice';
  const t = String(title || '');
  if (/exam|prüfung|pruefung|klausur|revision|revise/i.test(t)) return 'exam';
  if (/homework|hausaufgabe|\bhw ?\d|sheet|übung|uebung|exercise|lab ?\d/i.test(t)) return 'homework';
  return 'course';
}

/** A session's lesson plan and which topics were taught. Same rule as LearnHarness's plan panel
 *  (derivePlanStatusesLh): quiz/explain calls tagged with a node; the latest one is "current", the earlier ones
 *  "visited". Taught = visited, so the topic being taught right now does not count yet. */
export function sessionProgress(record) {
  const nodes = record?.tree?.nodes || [];
  const ids = new Set(nodes.map((n) => n.id));
  const runs = [];
  for (const m of record?.messages || []) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content || []) {
      if (b?.type !== 'toolCall' || !['quiz', 'explain'].includes(b.name)) continue;
      const n = b.arguments?.nodeId;
      if (typeof n === 'string' && ids.has(n) && runs.at(-1) !== n) runs.push(n);
    }
  }
  const current = runs.at(-1) ?? null;
  const visited = new Set(runs.slice(0, -1));
  return {
    total: nodes.length, taught: nodes.filter((n) => visited.has(n.id)).length, current,
    nodes: nodes.map((n) => ({ id: n.id, title: n.title, taught: visited.has(n.id), current: n.id === current })),
  };
}

/** When the session was last active before the input that started this turn (ms), or null. LearnHarness saves the
 *  learner's input (a message or a quiz answer) before the turn runs, so that is the last message during the turn. */
export function lastStudied(record) {
  const msgs = record?.messages || [];
  let best = null;
  for (const m of msgs.slice(0, -1)) if (Number.isFinite(m.timestamp) && (best === null || m.timestamp > best)) best = m.timestamp;
  return best;
}

/** Class code for a folder name: "CV1", "cv1", "CV1 – Computer Vision" → "CV1"; anything else → null. */
export function classOfFolderName(name) {
  const n = String(name || '').trim();
  for (const c of CLASSES) {
    if (n.toLowerCase() === c.toLowerCase()) return c;
    if (n.toLowerCase().startsWith(c.toLowerCase()) && /^[\s·:–—-]/.test(n.slice(c.length))) return c;
  }
  return null;
}

/** organization = LearnHarness's source organization ({folders, placements}). Returns the class of a session, or null. */
export function classOfSession(organization, chatId) {
  if (!organization) return null;
  const folders = new Map((organization.folders || []).map((f) => [f.id, f]));
  let id = organization.placements?.[chatId]?.folderId ?? null;
  for (let hops = 0; id && hops < 32; hops++) {
    const f = folders.get(id);
    if (!f) return null;
    const c = classOfFolderName(f.name);
    if (c) return c;
    id = f.parentId;
  }
  return null;
}

export function readOrganization(learningDir) {
  try { return JSON.parse(fs.readFileSync(path.join(learningDir, 'graph', 'source-organization.json'), 'utf8')); } catch { return null; }
}

/** Plugin-owned tutor notes: {version, tutors: {chatId: {mode, focus, createdAt, lastCheck}}}. */
export function makeTutorStore(dataDir) {
  const file = path.join(dataDir, 'tutors.json');
  // Read on every use: the file is small, and this stays right if another copy of the plugin wrote it.
  const load = () => {
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { d = null; }
    return d && d.version === 1 && d.tutors && typeof d.tutors === 'object' ? d : { version: 1, tutors: {} };
  };
  const save = (d) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(d, null, 1));
    fs.renameSync(file + '.tmp', file);
  };
  return {
    get: (id) => load().tutors[id] || null,
    /** Notes for a session, created on first sight. `since` = where "new" starts for a session we didn't create. */
    ensure(id, since, mode = 'course') {
      const d = load();
      // auto: the lesson type was guessed from the session's title, so it follows a rename.
      if (!d.tutors[id]) { d.tutors[id] = { mode, auto: true, focus: '', createdAt: new Date().toISOString(), lastCheck: since || new Date().toISOString() }; save(d); }
      return d.tutors[id];
    },
    set(id, fields) { const d = load(); d.tutors[id] = { ...(d.tutors[id] || {}), ...fields }; save(d); return d.tutors[id]; },
    remove(id) { const d = load(); if (d.tutors[id]) { delete d.tutors[id]; save(d); } },
    ids: () => Object.keys(load().tutors),
  };
}

/** What a check has covered: files the index held when it was built. Files downloaded after that build are not in the
 *  index yet, so "seen" stops at the build time, not at now; otherwise they would never be reported. */
export function seenUpTo(index) {
  const built = Date.parse(index?.built || '');
  return new Date(Number.isFinite(built) ? Math.min(built, Date.now()) : Date.now()).toISOString();
}

/** Course documents of a class changed after `since` (ISO), newest first. Link overviews are left out (they change
 *  on every Moodle check). index = the Semester index ({docs}). */
export function newDocs(index, cls, since) {
  const t = Date.parse(since || 0) || 0;
  return (index?.docs || [])
    .filter((d) => d.cls === cls && d.kind !== 'links' && Date.parse(d.mtime) > t)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

const MODE_GOAL = {
  course: (cls) => `follow the ${cls} course with the learner: teach the lectures in order, at the pace of the course`,
  exam: (cls) => `prepare the learner for the ${cls} exam: find weak spots, revise what the exam covers, practise exam-style questions`,
  homework: (cls, focus) => `teach the concepts the learner needs for ${focus || 'the current homework'} in ${cls}. Read the sheet only to see which topics it uses; never solve, outline, check or hint at its tasks — teach the ideas with your own examples`,
  topic: (cls, focus) => `teach ${focus || 'the topic the learner asked for'} from the ${cls} material`,
  practice: (cls) => `give the learner practice problems on ${cls} topics that were already taught (see class_progress), weakest first`,
};

/** The tutor brief that rides in class_updates' description (the model sees it every turn). */
export function tutorBrief(cls, note, root) {
  const goal = (MODE_GOAL[note?.mode] || MODE_GOAL.course)(cls, note?.focus);
  return `This session is the learner's ${cls} tutor (Semester). Its goal: ${goal}. search_course and read_pages only search ${cls}'s files here.${root ? ` The class folder is ${path.join(root, cls)} (use this absolute path with file tools).` : ''}
- Call class_updates at the start of each lesson block and whenever the learner comes back. Always tell the learner in one line what is new in ${cls} (or that nothing is) and whether the plan already covers it. If it changes what should be taught, update the plan with plan_init: keep what has been covered, add or reorder the rest.
- If class_updates says the learner was away for more than a day, open with a two-line recap of where you stopped and two quick recall questions on it before going on.
- Before making or changing a plan, call class_progress: it lists what every ${cls} session has taught, the lectures that exist and the exam date. Build on it; never claim a topic is covered unless class_progress shows it taught.
- Cite course pages as (document title, p. N), never as raw ids.`;
}

/**
 * The class_updates tool for one session. getIndex() -> the Semester index; root = the semester folder.
 * Marks the files as seen (lastCheck = now) when it reports them.
 */
export function classUpdatesTool({ cls, chatId, store, getIndex, root, getRecord = () => null }) {
  const note = store.get(chatId);
  return {
    name: 'class_updates',
    label: `New in ${cls}`,
    description: `${tutorBrief(cls, note, root)}\nReturns new or changed ${cls} files since the last check, with the document id to use with read_pages.`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => {
      const n = store.get(chatId) || store.ensure(chatId);
      const since = n.lastCheck;
      const index = getIndex();
      const docs = newDocs(index, cls, since);
      const upTo = seenUpTo(index);
      if (upTo > since) store.set(chatId, { lastCheck: upTo });
      const files = docs.slice(0, 25).map((d) => ({
        doc: d.id.slice(0, 8), title: d.title, path: d.path, pages: d.pages, kind: d.kind, graded: !!d.graded, added: d.mtime.slice(0, 10),
      }));
      const last = lastStudied(getRecord(chatId));
      const away = last ? { lastStudied: new Date(last).toISOString(), daysAway: Math.round((Date.now() - last) / 864e5 * 10) / 10 } : {};
      const out = files.length
        ? { ...away, since, newFiles: files, ...(docs.length > files.length ? { more: docs.length - files.length } : {}),
          note: `Read with read_pages(doc, pages). Graded files: explain the topic only. Files not listed may be newer than the search index (rebuilt after each Moodle check and nightly); they are in ${path.join(root, cls)}.` }
        : { ...away, since, newFiles: [], note: `Nothing new in ${cls} since ${since.slice(0, 16).replace('T', ' ')} UTC.` };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], details: out };
    },
  };
}

const CLASS_HINT = {
  SDMS: 'SDMS', CV1: 'Computer Vision I (CV1)', MC: 'Model Checking (MC)', EKI: 'Einführung in die KI (EKI)',
  HCSD: 'HCSD', IntroLLM: 'Intro to LLMs (IntroLLM)', TA: 'the TA seminar',
};

/** Title and opening message of a new tutor session. */
export function tutorOpening({ cls, mode, focus, ref }) {
  const name = CLASS_HINT[cls] || cls;
  const f = String(focus || '').trim().slice(0, 200);
  const tools = `Use my ${cls} course files (search_course and read_pages) and cite pages.`;
  const start = 'Start by finding out what I already know.';
  let title, text;
  switch (mode) {
    case 'exam':
      title = `${cls} · Exam prep`;
      text = `Help me prepare for the ${name} exam. ${tools} Work from the lectures and exercises, find my weak spots, then plan revision around what the exam covers and give me exam-style questions. ${start}`;
      break;
    case 'homework':
      title = `${cls} · ${f || 'Homework'} concepts`;
      text = `Teach me the concepts I need for ${f || 'the current homework'} in ${name}. ${tools} Read the sheet to see which topics it uses, but don't solve, outline or check any of its tasks: teach the ideas with your own examples, so I can do the homework myself. ${start}`;
      break;
    case 'topic':
      title = `${cls} · ${f || 'Topic'}`;
      text = `Teach me ${f || 'this'} from my ${name} course material.${ref ? ` Start from ${ref}.` : ''} ${tools} ${start}`;
      break;
    case 'practice':
      title = `${cls} · Practice${f ? `: ${f}` : ''}`;
      text = `Give me practice problems on ${f || `the ${name} topics I have already learned`}. ${tools} Start with what I'm weakest at.`;
      break;
    default:
      title = `${cls} · Course`;
      text = `Be my ${name} tutor and follow the course with me: teach the lectures in order, from the ones that exist so far. ${tools} When new lectures arrive, add them to the plan. ${start}`;
  }
  return { title: title.slice(0, 80), text };
}

/**
 * class_progress: the class's one shared picture: lectures that exist, key dates and the exam, and what each of the
 * class's sessions planned and taught. sessions() -> [{id, title, kind, updatedAt}] of this class; getRecord(id) -> record.
 */
export function classProgressTool({ cls, chatId, store, getIndex, sessions, getRecord, dates }) {
  return {
    name: 'class_progress',
    label: `${cls} progress`,
    description: `The learner's ${cls} progress across all ${cls} sessions: each session's plan with topics taught and not yet, the ${cls} lectures that exist, key dates and days to the exam. Call it before making or changing a plan.`,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: async () => {
      const now = Date.now();
      const lectures = (getIndex()?.docs || []).filter((d) => d.cls === cls && d.kind === 'slides')
        .sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true })).map((d) => ({ doc: d.id.slice(0, 8), title: d.title, pages: d.pages }));
      const list = sessions().map((s) => {
        const p = sessionProgress(getRecord(s.id));
        const note = store.get(s.id);
        return {
          title: s.title, thisSession: s.id === chatId, type: MODES[note?.mode] || MODES.course, lastActive: s.updatedAt,
          taught: `${p.taught}/${p.total} topics`, taughtTopics: p.nodes.filter((n) => n.taught).map((n) => n.title),
          ...(p.current ? { inProgress: p.nodes.find((n) => n.current)?.title } : {}),
          notYet: p.nodes.filter((n) => !n.taught && !n.current).map((n) => n.title).slice(0, 30),
        };
      });
      const ds = dates();
      const exam = ds.find((d) => d.kind === 'exam');
      const out = {
        today: new Date(now).toISOString().slice(0, 10),
        exam: exam ? { title: exam.title, at: exam.at, daysLeft: Math.ceil((Date.parse(exam.at) - now) / 864e5) } : 'unknown: ask the learner or search the intro slides',
        keyDates: ds.slice(0, 12).map((d) => ({ title: d.title, at: d.at, kind: d.kind })),
        lectures, sessions: list,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], details: out };
    },
  };
}
