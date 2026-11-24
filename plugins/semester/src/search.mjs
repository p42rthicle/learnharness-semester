// Course search for the Semester plugin: BM25 over the Semester index (Dashboard/index/out-semester/index.json.gz).
// Every page has a stable reference "<first 8 hex of the doc id>:<page>", e.g. "a1b2c3d4:12"; answers cite those.
import fs from 'node:fs';
import zlib from 'node:zlib';

export const CLASSES = ['SDMS', 'CV1', 'MC', 'EKI', 'HCSD', 'IntroLLM', 'TA'];

const STOP = new Set(`a an and are as at be but by can do does for from has have how i if in into is it its me my
not of on or so than that the their them then there these they this to was we what when where which who why will
with you your der die das und ist ein eine einer eines den dem des zu im mit von auf für fur nicht sich auch als
wie bei oder aus wird werden sind kann es`.split(/\s+/));

/** Lowercase word tokens (letters/digits, any script), no stop words, light plural stripping. */
export function tokenize(text) {
  const out = [];
  for (const m of String(text).toLowerCase().normalize('NFC').matchAll(/[\p{L}\p{N}]+(?:[+#][\p{L}\p{N}+#]*)?/gu)) {
    let t = m[0];
    if (t.length < 2 || STOP.has(t)) continue;
    if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
    else if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

export const refOf = (doc, page) => `${doc.id.slice(0, 8)}:${page}`;

/** index = parsed index.json ({docs, pages}). Returns a searcher. */
export function makeSearcher(index) {
  const docs = index.docs;
  const pages = index.pages; // [{d, p, t}]
  const byRef = new Map();
  const docByShort = new Map(docs.map((d) => [d.id.slice(0, 8), d]));
  const postings = new Map(); // term -> [[pageIdx, tf]]
  const lens = new Float64Array(pages.length);
  pages.forEach((pg, i) => {
    const doc = docs[pg.d];
    byRef.set(refOf(doc, pg.p), i);
    // The title and folder count as part of every page of the doc.
    const toks = tokenize(`${doc.title} ${doc.path.split('/').slice(0, -1).join(' ')} ${pg.t}`);
    lens[i] = toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let l = postings.get(t);
      if (!l) postings.set(t, (l = []));
      l.push([i, n]);
    }
  });
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, pages.length);
  const N = pages.length;

  function snippet(text, terms, max = 320) {
    const low = text.toLowerCase();
    let best = 0, bestScore = -1;
    for (let s = 0; s < Math.max(1, low.length - max / 2); s += 80) {
      const win = low.slice(s, s + max);
      const score = terms.reduce((a, t) => a + (win.includes(t) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    const start = Math.max(0, best - 20);
    return (start > 0 ? '…' : '') + text.slice(start, start + max).trim() + (start + max < text.length ? '…' : '');
  }

  function describe(i, terms) {
    const pg = pages[i];
    const doc = docs[pg.d];
    return {
      ref: refOf(doc, pg.p), cls: doc.cls, path: doc.path, title: doc.title, page: pg.p, pages: doc.pages,
      kind: doc.kind, graded: !!doc.graded, ...(terms ? { snippet: snippet(pg.t, terms) } : {}),
    };
  }

  return {
    size: { docs: docs.length, pages: pages.length },
    /** query -> top pages. classes/kinds filter (empty = all). */
    search(query, { classes = [], kinds = [], limit = 8 } = {}) {
      const terms = [...new Set(tokenize(query))];
      if (!terms.length) return [];
      const okCls = classes.length ? new Set(classes) : null;
      const okKind = kinds.length ? new Set(kinds) : null;
      const k1 = 1.4, b = 0.7;
      const score = new Map();
      for (const t of terms) {
        const l = postings.get(t);
        if (!l) continue;
        const idf = Math.log(1 + (N - l.length + 0.5) / (l.length + 0.5));
        for (const [i, tf] of l) {
          const doc = docs[pages[i].d];
          if (okCls && !okCls.has(doc.cls)) continue;
          if (okKind && !okKind.has(doc.kind)) continue;
          const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lens[i] / avg));
          score.set(i, (score.get(i) || 0) + s);
        }
      }
      // At most 3 pages per document, so one long book doesn't fill the list.
      const perDoc = new Map();
      const out = [];
      for (const [i] of [...score].sort((a, b) => b[1] - a[1])) {
        const d = pages[i].d;
        if ((perDoc.get(d) || 0) >= 3) continue;
        perDoc.set(d, (perDoc.get(d) || 0) + 1);
        out.push(describe(i, terms));
        if (out.length >= limit) break;
      }
      return out;
    },
    /** Full text of pages: ref "abcd1234:5" or a doc short id + page numbers. */
    read(doc, pageNums, { classes = [] } = {}) {
      const d = docByShort.get(String(doc).split(':')[0]);
      if (!d) return { error: `No document ${doc}` };
      if (classes.length && !classes.includes(d.cls)) return { error: `${d.title} is in ${d.cls}, outside the selected classes` };
      const out = [];
      for (const p of pageNums.slice(0, 6)) {
        const i = byRef.get(`${d.id.slice(0, 8)}:${p}`);
        if (i === undefined) continue;
        out.push({ ...describe(i), text: pages[i].t });
      }
      return { doc: { cls: d.cls, path: d.path, title: d.title, pages: d.pages, graded: !!d.graded }, pages: out };
    },
    /** The page behind a ref, or null. */
    page(ref) {
      const i = byRef.get(ref);
      return i === undefined ? null : { ...describe(i), text: pages[i].t };
    },
    /** Graded docs (for the system prompt: title, class and location only). */
    graded() {
      return docs.filter((d) => d.graded).map((d) => ({ cls: d.cls, path: d.path, title: d.title }));
    },
  };
}

export function loadIndex(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}
