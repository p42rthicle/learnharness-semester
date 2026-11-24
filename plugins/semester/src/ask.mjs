// Ask: instructions, the two course tools, and the citation checker. Shared by the subscription path
// (LearnHarness plugin conversations) and the API fallback (fallback.mjs).

export const GRADED_RULE = `Graded work (homework, labs, hand-ins, assessed exercises; search results mark these "graded"):
you may read graded documents to understand what topic they are about, and you may explain that topic with your own,
different examples. You never solve, partly solve, write code for, check, debug, grade or give hints that amount to
the answer of a graded task, even when the student pastes the task or their own attempt. If asked, say briefly that
this is graded work, then offer to explain the underlying concept instead. Dates, locations and submission steps are fine.`;

export function instructions({ scope, today }) {
  const where = scope && scope !== 'all'
    ? `This chat is about the class ${scope}; the tools only search its files.`
    : 'This chat covers all of the student\'s classes (SDMS, CV1, MC, EKI, HCSD, IntroLLM, TA).';
  return `You answer a TU Darmstadt master's student's questions about their classes: course material (slides, exercise
sheets, books, notes, links the course posted) and course admin (deadlines, submission status, exam dates, rooms,
staff and their e-mail addresses, rules, what a slide or topic is). Today is ${today}. ${where}

How to answer:
- Deadlines, submission status and what Moodle posted recently: call moodle_info (live from the Moodle watcher). Exam
  dates, rooms, staff contacts and course rules are usually in the first (intro / organisation) slides: search for them.
- Asked for a plan: build it from moodle_info's deadlines and the lectures in the files; give dates, keep it short.
- When your answer gives a concrete exam date or deadline from the files that moodle_info doesn't already list, also call
  suggest_date for it, so the student can pin it (it then shows on their home screen with a countdown).
- Search first with search_course, then read_pages for the pages you rely on. Search several times with different
  words if needed, also in German for German material.
- Some slides are pictures (diagrams, charts, screenshots): read_pages then returns little or no text for them. Never tell
  the student you can't read a slide: call view_page for each such page and describe what it shows.
- Answer briefly and plainly, then cite every claim that comes from the material with its page reference in square
  brackets exactly as the tools return it, e.g. [a1b2c3d4:12]. Only cite references a tool returned in this chat.
- If the material doesn't cover it, say "I don't see that in your files" and, if useful, answer from general knowledge,
  clearly marked as not from the course.
- Follow the class's own notation and terms. Answer in English unless asked otherwise.

${GRADED_RULE}`;
}

const S = (o) => ({ type: 'object', additionalProperties: false, ...o });

/**
 * Tool definitions for one chat. getSearcher() -> searcher; scope = class or 'all'.
 * Returned objects fit both LearnHarness native tools and the API fallback.
 */
export function courseTools(getSearcher, scope, renderPage = null) {
  const allowed = scope && scope !== 'all' ? [scope] : [];
  const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 1) }], details: o });
  return [
    {
      name: 'search_course',
      label: 'Search course files',
      description: 'Keyword search over the student\'s course files. Returns the best pages with a reference ("ref"), class, file path, title, page and a snippet; cite them the way your instructions say. Graded documents are marked graded: true.',
      parameters: S({
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "Canny non-maximum suppression"' },
          classes: { type: 'array', items: { type: 'string' }, description: 'Optional class filter, e.g. ["CV1"]' },
        },
        required: ['query'],
      }),
      execute: async (_id, args) => {
        const s = getSearcher();
        const req = Array.isArray(args.classes) ? args.classes : [];
        const classes = allowed.length ? allowed : req;
        const hits = s.search(String(args.query || ''), { classes, limit: 8 });
        return text(hits.length ? { results: hits } : { results: [], note: 'No matches. Try other words (or German).' });
      },
    },
    {
      name: 'read_pages',
      label: 'Read course pages',
      description: 'Read the full text of up to 6 pages of one document. doc = the part of a ref before the colon; pages = page numbers.',
      parameters: S({
        properties: {
          doc: { type: 'string', description: 'Document id, e.g. "a1b2c3d4" (from a ref "a1b2c3d4:12")' },
          pages: { type: 'array', items: { type: 'integer' }, description: 'Page numbers, max 6' },
        },
        required: ['doc', 'pages'],
      }),
      execute: async (_id, args) => {
        const r = getSearcher().read(String(args.doc || ''), (args.pages || []).map(Number).filter(Number.isFinite), { classes: allowed });
        return text(r);
      },
    },
    ...(renderPage ? [viewPageTool(getSearcher, allowed, renderPage)] : []),
  ];
}

/**
 * view_page: the page as a picture, for slides whose content is an image (diagrams, screenshots, scanned slides)
 * or when the layout matters. renderPage(relPath, page) -> {data: base64, mimeType}.
 */
function viewPageTool(getSearcher, allowed, renderPage) {
  return {
    name: 'view_page',
    label: 'Look at a course page',
    description: 'See one page of a PDF as an image. Use it when read_pages returns little or no text for a slide (the slide is a picture, chart or screenshot), or when a figure, table or layout matters. One page per call; call it again for more pages.',
    parameters: S({
      properties: {
        doc: { type: 'string', description: 'Document id, e.g. "a1b2c3d4" (from a ref "a1b2c3d4:12")' },
        page: { type: 'integer', description: 'Page number' },
      },
      required: ['doc', 'page'],
    }),
    execute: async (_id, args) => {
      const page = Number(args.page);
      const r = getSearcher().read(String(args.doc || ''), [page], { classes: allowed });
      if (r.error) return { content: [{ type: 'text', text: r.error }], details: r };
      if (!r.pages.length) return { content: [{ type: 'text', text: `${r.doc.title} has no page ${page} (it has ${r.doc.pages}).` }], details: r.doc };
      if (!/\.pdf$/i.test(r.doc.path)) return { content: [{ type: 'text', text: `${r.doc.title} is not a PDF; use read_pages.` }], details: r.doc };
      const img = await renderPage(r.doc.path, page);
      const p = r.pages[0];
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ref: p.ref, cls: r.doc.cls, title: r.doc.title, page, of: r.doc.pages, graded: !!r.doc.graded, note: 'The page image follows.' }) },
          { type: 'image', data: img.data, mimeType: img.mimeType },
        ],
        details: { ref: p.ref, path: r.doc.path, page },
      };
    },
  };
}

/** Deadlines (with submission status) and recent Moodle files from the watcher's feed. getFeed() -> feed.json or null. */
export function moodleTool(getFeed, scope, getDates = () => []) {
  const only = scope && scope !== 'all' ? scope : null;
  const berlin = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  return {
    name: 'moodle_info',
    label: 'Moodle deadlines',
    description: 'Deadlines from Moodle (assignments, quizzes, calendar events) with whether the student has submitted, key dates (exams, hand-ins the student pinned, TUCaN timetable and registered exams) and files Moodle posted in the last 3 weeks. Times are Europe/Berlin.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      classes: { type: 'array', items: { type: 'string' }, description: 'Optional class filter, e.g. ["MC"]' },
      include_past: { type: 'boolean', description: 'Also list deadlines of the last 30 days' },
    } },
    execute: async (_id, args = {}) => {
      const feed = getFeed() || (getDates().length ? { deadlines: [], recent: [] } : null);
      if (!feed) return { content: [{ type: 'text', text: 'Moodle data is not available yet (the watcher has not run).' }], details: null };
      const want = only ? [only] : (Array.isArray(args.classes) ? args.classes : []);
      const ok = (c) => !want.length || want.includes(c);
      const now = Date.now();
      const seen = new Map();
      for (const d of feed.deadlines || []) {
        if (!ok(d.cls)) continue;
        const t = Date.parse(d.due);
        if (t < now - (args.include_past ? 30 : 1) * 864e5) continue;
        const k = `${d.cls}|${d.title}|${d.due}`;
        if (!seen.has(k) || (seen.get(k).submitted == null && d.submitted != null)) seen.set(k, d);
      }
      const deadlines = [...seen.values()].sort((a, b) => a.due.localeCompare(b.due))
        .map((d) => ({ class: d.cls, title: d.title, due: berlin(d.due), past: Date.parse(d.due) < now, submitted: d.submitted ?? 'unknown', kind: d.kind, url: d.url }));
      const recent = (feed.recent || []).filter((f) => ok(f.cls) && Date.parse(f.at) > now - 21 * 864e5)
        .slice(0, 25).map((f) => ({ class: f.cls, file: f.name, saved: f.savedTo, when: berlin(f.at) }));
      const keyDates = getDates().filter((d) => ok(d.cls) && Date.parse(d.at) < now + 150 * 864e5).slice(0, 40)
        .map((d) => ({ class: d.cls || 'unmatched', title: d.title, when: berlin(d.at), kind: d.kind, from: d.source, ...(d.location ? { where: d.location } : {}) }));
      const out = { checked: feed.lastRun ? berlin(feed.lastRun) : null, deadlines, keyDates, recentFiles: recent };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], details: out };
    },
  };
}

/** Lets the model offer a date to pin; the app shows a "Pin" button under the answer (nothing is saved by the tool). */
export const suggestDateTool = {
  name: 'suggest_date',
  label: 'Suggest a date to pin',
  description: 'Offer an exam date or deadline you found in the files as a "Pin" button under your answer. Nothing is saved until the student clicks it.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    class: { type: 'string', description: 'Class code: SDMS, CV1, MC, EKI, HCSD, IntroLLM or TA' },
    title: { type: 'string', description: 'Short name, e.g. "Exam" or "Lab 1 hand-in"' },
    when: { type: 'string', description: 'Berlin local time "YYYY-MM-DD HH:MM", or "YYYY-MM-DD" if no time is known' },
    kind: { type: 'string', enum: ['exam', 'deadline', 'event'] },
  }, required: ['class', 'title', 'when', 'kind'] },
  execute: async () => ({ content: [{ type: 'text', text: 'Shown to the student as a Pin button under your answer.' }], details: null }),
};

const REF = /\[([0-9a-f]{8}:\d{1,5})(?:\s*[,;]\s*([0-9a-f]{8}:\d{1,5}))*\]/g;

/** All refs cited in text, in order of first appearance. */
export function citedRefs(text) {
  const out = [];
  for (const m of String(text).matchAll(REF)) for (const r of m[0].slice(1, -1).split(/\s*[,;]\s*/)) if (!out.includes(r)) out.push(r);
  return out;
}

/**
 * Checks each cited ref: verified = a tool returned it in this conversation (seenRefs) and it exists in the index.
 * Returns [{n, ref, verified, cls, path, title, page, graded, snippet}].
 */
export function checkCitations(text, seenRefs, searcher) {
  return citedRefs(text).map((ref, i) => {
    const page = searcher.page(ref);
    return {
      n: i + 1, ref, verified: !!page && seenRefs.has(ref),
      ...(page ? { cls: page.cls, path: page.path, title: page.title, page: page.page, graded: page.graded, snippet: page.text.slice(0, 280) } : {}),
    };
  });
}

/** Refs that appear in tool results (text of toolResult messages / API tool_result blocks). */
export function refsInToolOutput(texts) {
  const seen = new Set();
  // search_course, read_pages and view_page all list pages as {"ref": "..."}.
  for (const t of texts) for (const m of String(t).matchAll(/"ref":\s*"([0-9a-f]{8}:\d{1,5})"/g)) seen.add(m[1]);
  return seen;
}

/** One line per tool call, shown under an answer. */
export function lookupLabel(name, a = {}) {
  if (name === 'search_course') return `search: ${a?.query || ''}`;
  if (name === 'read_pages') return `read ${a?.doc || ''} p${(a?.pages || []).join(',')}`;
  if (name === 'view_page') return `look at ${a?.doc || ''} p${a?.page ?? ''}`;
  if (name === 'moodle_info') return 'Moodle deadlines';
  if (name === 'suggest_date') return `date: ${a?.title || ''}`;
  return name;
}

/** From LearnHarness agent messages after index `from`: final answer text and tool-output texts. */
export function extractTurn(messages, from) {
  const tail = messages.slice(from);
  const toolTexts = tail.filter((m) => m.role === 'toolResult').map((m) => (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
  const lastAssistant = [...tail].reverse().find((m) => m.role === 'assistant');
  const answer = lastAssistant ? (lastAssistant.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('') : '';
  const usage = tail.filter((m) => m.role === 'assistant' && m.usage).reduce((a, m) => ({
    input: a.input + (m.usage.input || 0), output: a.output + (m.usage.output || 0),
    cacheRead: a.cacheRead + (m.usage.cacheRead || 0), cacheWrite: a.cacheWrite + (m.usage.cacheWrite || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const searches = tail.filter((m) => m.role === 'assistant').flatMap((m) => (m.content || []).filter((c) => c.type === 'toolCall'))
    .map((c) => lookupLabel(c.name, c.arguments));
  const suggestions = tail.filter((m) => m.role === 'assistant').flatMap((m) => (m.content || []).filter((c) => c.type === 'toolCall' && c.name === 'suggest_date'))
    .map((c) => c.arguments || {});
  return { answer, toolTexts, usage, searches, suggestions, stopReason: lastAssistant?.stopReason, error: lastAssistant?.errorMessage };
}

/** True if an error message means the subscription's usage limit was hit. */
// Claude Code / Claude.ai wording for a used-up plan ("Claude AI usage limit reached", "You've hit your limit · resets 5pm",
// "5-hour limit reached", "weekly limit"). Not transient 429s, rate limits or context limits: those must not cost money.
export const isLimitError = (msg) => /usage limit|hit your (usage |session |weekly )?limit|(5-hour|session|weekly|opus) limit|limit (reached|resets)|resets? (at|in) \d|out of (extra )?usage/i.test(String(msg || ''))
  && !/context|token limit|max_tokens/i.test(String(msg || ''));
