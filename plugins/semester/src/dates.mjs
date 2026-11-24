// Key dates per class: exams, hand-ins and anything else the student pins, plus whatever TUCaN's calendar export holds.
//   - Pinned dates live in the plugin's data folder (dates.json).
//   - TUCaN: TUCaN has no API or live feed; its timetable "Export" writes an iCalendar file (registered exams included).
//     Every .ics in <semester>/TUCaN/ is read; events are matched to classes by course name (the watcher's patterns).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classOfCourseName } from './lib/course-names.mjs';
import { CLASSES } from './search.mjs';

export const DATE_KINDS = ['exam', 'deadline', 'event'];
// An exam, but not its review ("Einsicht") or a prep session.
const EXAM = /^(?!.*(einsicht|vorbereitung|preparation|review)).*(prüfung|pruefung|klausur|\bexam\b)/i;

/** Minimal RFC 5545 reader: VEVENTs with SUMMARY, DTSTART, DTEND, LOCATION (folded lines, TZID or UTC or all-day). */
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  const unescape = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev?.start) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    // The value starts at the first colon outside a quoted parameter (ALTREP="http://…").
    let i = -1, quoted = false;
    for (let k = 0; k < line.length; k++) { if (line[k] === '"') quoted = !quoted; else if (line[k] === ':' && !quoted) { i = k; break; } }
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    const value = line.slice(i + 1);
    const tzid = params.find((p) => p.startsWith('TZID='))?.slice(5).replace(/^"|"$/g, '');
    if (name === 'SUMMARY') ev.title = unescape(value);
    else if (name === 'LOCATION') ev.location = unescape(value);
    else if (name === 'DESCRIPTION') ev.description = unescape(value).slice(0, 300);
    else if (name === 'DTSTART') ev.start = icsTime(value, tzid);
    else if (name === 'DTEND') ev.end = icsTime(value, tzid);
  }
  return events;
}

/** "20270208T110000" (+TZID Europe/Berlin), "20270208T100000Z" or "20270208" → ISO string. */
function icsTime(v, tzid) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +se > 60) return null;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)).toISOString();
  // Local time (TUCaN uses Europe/Berlin): find the UTC instant whose Berlin wall clock matches.
  // Unknown zone names (Windows-style "W. Europe Standard Time") fall back to Berlin, where TUCaN is.
  let zone = tzid || 'Europe/Berlin';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'Europe/Berlin'; }
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const wall = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  };
  let t = guess - (wall(guess) - guess);
  t -= wall(t) - guess; // second pass settles DST edges
  return new Date(t).toISOString();
}

/** TUCaN events from every .ics in dir: [{id, cls, title, at, end, location, kind:'exam'|'event', source:'tucan'}]. */
const tucanCache = { key: '', events: [] };
export function readTucan(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.ics')).sort(); } catch { return []; }
  // Parsed once per set of file versions.
  const key = dir + '|' + files.map((f) => { try { const st = fs.statSync(path.join(dir, f)); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return f; } }).join('|');
  if (tucanCache.key === key) return tucanCache.events;
  const out = new Map();
  for (const f of files) {
    let events = [];
    try { events = parseIcs(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; } // one bad file never hides the rest
    for (const e of events) {
      const id = 'tucan-' + crypto.createHash('sha1').update(`${e.title}|${e.start}`).digest('hex').slice(0, 12);
      out.set(id, { id, cls: classOfCourseName(`${e.title} ${e.description || ''}`), title: e.title || '(no title)', at: e.start,
        end: e.end || null, location: e.location || '', kind: EXAM.test(e.title || '') ? 'exam' : 'event', source: 'tucan' });
    }
  }
  tucanCache.key = key;
  tucanCache.events = [...out.values()].sort((a, b) => a.at.localeCompare(b.at));
  return tucanCache.events;
}

/** Pinned dates: {version:1, dates:[{id, cls, title, at, kind, source:'pinned'}]}. Read on every use (small file). */
export function makeDateStore(dataDir) {
  const file = path.join(dataDir, 'dates.json');
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.dates) ? j.dates : []; } catch { return []; } };
  const save = (dates) => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, dates }, null, 1));
    fs.renameSync(file + '.tmp', file);
  };
  return {
    list: load,
    add({ cls, title, at, kind }) {
      if (cls !== null && !CLASSES.includes(cls)) throw new Error(`Unknown class ${cls}`);
      const t = String(title || '').trim().slice(0, 120);
      if (!t) throw new Error('Give the date a name, e.g. "Exam"');
      const ms = Date.parse(at);
      if (!Number.isFinite(ms)) throw new Error('Not a date');
      const d = { id: crypto.randomUUID(), cls, title: t, at: new Date(ms).toISOString(), kind: DATE_KINDS.includes(kind) ? kind : 'event', source: 'pinned' };
      save([...load(), d]);
      return d;
    },
    remove(id) { save(load().filter((d) => d.id !== id)); },
  };
}

/** "2027-02-08", "2027-02-08T11:00" or "2027-02-08 11:00" as Berlin wall time (or any ISO with zone) → ISO, or null. */
export function berlinToIso(text) {
  const t = String(text || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(t);
  if (m) return icsTime(`${m[1]}${m[2]}${m[3]}T${m[4] || '00'}${m[5] || '00'}00`, 'Europe/Berlin');
  const ms = /[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** All key dates (pinned + TUCaN), optionally for one class, from `fromMs` on, sorted. */
export function keyDates({ store, tucanDir, cls = null, fromMs = Date.now() - 864e5 }) {
  // Read separately: a problem with one source must not hide the other.
  let pinned = [], tucan = [];
  try { pinned = store.list(); } catch { /* unreadable dates.json */ }
  try { tucan = readTucan(tucanDir); } catch { /* unreadable export */ }
  const all = [...pinned, ...tucan];
  return all.filter((d) => (!cls || d.cls === cls) && Date.parse(d.end || d.at) >= fromMs).sort((a, b) => a.at.localeCompare(b.at));
}

/** The class's exam: the next pinned or TUCaN date of kind exam. */
export function examOf(dates, cls) {
  return dates.find((d) => d.cls === cls && d.kind === 'exam') || null;
}
