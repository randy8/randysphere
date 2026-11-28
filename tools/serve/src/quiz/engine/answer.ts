/**
 * Typed-response matching, for the automated host (single player) and
 * practice only. A hosted game is always judged by its human host; this
 * never rules on a spoken response. Deliberately plain: normalise, strip
 * the question form and articles, accept an exact match, a match against
 * the response's required part (text outside parentheses), or a close
 * spelling. The player can always overrule it (honour system), so it errs
 * toward strictness only where a wrong "correct" would be surprising.
 */

const QUESTION_FORM = /^(?:what|who|where|when|which|how)(?:\s+(?:is|are|was|were|'s|’s))?\s+/;
const ARTICLES = /^(?:the|a|an)\s+/;

/** True if the response is phrased as a question ("What is…", "Who are…"). */
export function isQuestionForm(text: string): boolean {
  return QUESTION_FORM.test(text.trim().toLowerCase());
}

export function normalize(text: string): string {
  let out = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[“”"’‘`]/g, "'")
    .replace(/&/g, ' and ')
    .trim();
  out = out.replace(/\?+$/, '').trim();
  out = out.replace(QUESTION_FORM, '');
  out = out.replace(/[^a-z0-9' ]+/g, ' ').replace(/'/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(ARTICLES, '');
  return out;
}

/** The forms of an expected response worth matching: whole, without its (optional) part, each "or" alternative. */
function forms(expected: string): string[] {
  const out = new Set<string>();
  const add = (form: string): void => {
    const normalized = normalize(form);
    if (normalized) out.add(normalized);
  };
  add(expected);
  add(expected.replace(/\([^)]*\)/g, ' '));
  add(expected.replace(/[()]/g, ' '));
  for (const part of expected.split(/\s+(?:or|\/)\s+|\s*\/\s*/)) add(part);
  return [...out];
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[b.length] ?? 0;
}

/**
 * Whether `given` matches the response or an accepted alternative. No
 * guessing at surnames or synonyms: a board's author lists what else to
 * accept, and the player can overrule a miss.
 */
export function matches(given: string, response: string, accept: readonly string[] = []): boolean {
  const typed = normalize(given);
  if (!typed) return false;
  for (const expected of [response, ...accept].flatMap(forms)) {
    if (typed === expected) return true;
    const allowed = expected.length >= 12 ? 2 : expected.length >= 5 ? 1 : 0;
    if (distance(typed, expected) <= allowed) return true;
  }
  return false;
}
