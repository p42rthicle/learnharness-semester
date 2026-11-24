// Course full/short name (Moodle, TUCaN) -> class code.
const COURSE_PATTERNS = [
  ['SDMS', /scalable data management|skalierbare datenmanagement/iu],
  ['CV1', /computer vision(?!\s*(ii|2)\b)/iu],
  ['MC', /model checking/iu],
  ['EKI', /einf(ü|ue)hrung in die k(ü|ue)nstliche intelligenz|introduction to (ai|artificial intelligence)\b|\beki\b/iu],
  ['HCSD', /human[\s-]*centric/iu],
  ['IntroLLM', /large language models?/iu],
  ['TA', /text analytics|cross[\s-]*document|\bukp\b/iu],
];

/** Class code for any course/event name, or null. */
export function classOfCourseName(text) {
  const hay = String(text || '').normalize('NFC');
  for (const [cls, re] of COURSE_PATTERNS) if (re.test(hay)) return cls;
  return null;
}
