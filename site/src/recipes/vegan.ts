/**
 * Make It Vegan: every recipe's second way to be prepared, worked out at
 * build time from one curated library (recipes/substitutions/vegan.yaml)
 * rather than written twice. Pure: it never changes the recipe it's given,
 * only returns a vegan reading of it alongside — the page renders both and
 * a toggle chooses (vegan-toggle.ts).
 *
 * The rules that keep it honest:
 * - A phrase only counts when it's the ingredient itself: "vegan", "plant-
 *   based", "dairy-free"… just before it, or "-free" just after, mean it's
 *   already fine; each entry's `unless`/`unlessFollowedBy` rule out the
 *   rest ("peanut butter", "cream of tartar").
 * - A swap keeps the recipe's own quantity. Ratios (flax per egg) live in
 *   the library's `why`, never as a new bold quantity the scaler would scale.
 *   The page lists each swap and its products only; `why` stays in the
 *   library as the reasoning behind it, unrendered.
 * - `reformulate` swaps are never applied: the line stays as written, and
 *   the recipe isn't offered as vegan.
 * - Instructions change only for ingredients the recipe actually swapped,
 *   with the same choice, so the list and the steps always agree.
 */

export type Confidence = 'direct' | 'recipe-dependent' | 'reformulate';
export const CONFIDENCES: readonly Confidence[] = ['direct', 'recipe-dependent', 'reformulate'];

export interface VeganOption {
  readonly id: string;
  readonly use: string;
  readonly confidence: Confidence;
  readonly why: string;
  readonly products: readonly string[];
  readonly role: string | null;
}

export interface VeganEntry {
  readonly id: string;
  readonly category: string;
  readonly matches: readonly string[];
  readonly unless: readonly string[];
  readonly unlessFollowedBy: readonly string[];
  readonly brandPrefix: boolean;
  readonly options: readonly VeganOption[];
}

/** The library as written in YAML, checked and filled in; throws with the entry named on anything malformed. */
export function readLibrary(raw: unknown): VeganEntry[] {
  if (!Array.isArray(raw)) throw new Error('vegan.yaml: expected a list of entries');
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const entry = value as Record<string, unknown>;
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    const where = `vegan.yaml entry ${id || `#${String(index + 1)}`}`;
    if (id === '') throw new Error(`${where}: needs an id`);
    if (seen.has(id)) throw new Error(`${where}: id used twice`);
    seen.add(id);
    const strings = (key: string): string[] => {
      const list = entry[key] ?? [];
      if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
        throw new Error(`${where}: ${key} must be a list of words`);
      }
      return list.map((item) => item.toLowerCase());
    };
    const matches = strings('matches');
    if (matches.length === 0) throw new Error(`${where}: needs at least one phrase in matches`);
    const optionsRaw = entry['options'];
    if (!Array.isArray(optionsRaw) || optionsRaw.length === 0)
      throw new Error(`${where}: needs options`);
    const optionIds = new Set<string>();
    const options = optionsRaw.map((optionValue) => {
      const option = optionValue as Record<string, unknown>;
      const optionId = typeof option['id'] === 'string' ? option['id'] : '';
      const at = `${where}, option ${optionId || '(no id)'}`;
      if (optionId === '' || optionIds.has(optionId)) throw new Error(`${at}: needs a unique id`);
      optionIds.add(optionId);
      if (typeof option['use'] !== 'string' || option['use'] === '')
        throw new Error(`${at}: needs use`);
      if (!CONFIDENCES.includes(option['confidence'] as Confidence)) {
        throw new Error(`${at}: confidence must be one of ${CONFIDENCES.join(', ')}`);
      }
      if (typeof option['why'] !== 'string' || option['why'] === '')
        throw new Error(`${at}: needs why`);
      const products = option['products'] ?? [];
      if (!Array.isArray(products)) throw new Error(`${at}: products must be a list`);
      return {
        id: optionId,
        use: option['use'],
        confidence: option['confidence'] as Confidence,
        why: option['why'],
        products: products.map(String),
        role: typeof option['role'] === 'string' ? option['role'] : null,
      };
    });
    return {
      id,
      category: typeof entry['category'] === 'string' ? entry['category'] : 'other',
      matches,
      unless: strings('unless'),
      unlessFollowedBy: strings('unlessFollowedBy'),
      brandPrefix: entry['brandPrefix'] === true,
      options,
    };
  });
}

/** A recipe's own choices: `vegan: { use: { <entry id>: <option id> } }`. */
export interface VeganChoices {
  readonly use: Readonly<Record<string, string>>;
}

export interface Swap {
  readonly entry: VeganEntry;
  readonly option: VeganOption;
  /** The words as the recipe wrote them. */
  readonly found: string;
  /** The words that replace them, plural and capital matched. */
  readonly into: string;
}

export interface VeganLine {
  readonly original: string;
  readonly vegan: string;
  /** Swaps made in this line. */
  readonly swaps: readonly Swap[];
  /** Non-vegan ingredients left as written, because no swap is reliable. */
  readonly unresolved: readonly Swap[];
}

export type VeganStatus = 'vegan' | 'adaptable' | 'not-adaptable';

export interface VeganVersion {
  /** vegan: nothing to change. adaptable: every non-vegan ingredient has a swap. not-adaptable: at least one doesn't. */
  readonly status: VeganStatus;
  readonly ingredients: readonly VeganLine[];
  readonly optionalIngredients: readonly VeganLine[];
  readonly instructions: readonly VeganLine[];
  /** One per ingredient swapped, in the order first met: what the page explains. */
  readonly swaps: readonly Swap[];
  readonly unresolved: readonly Swap[];
}

// Words that mark an ingredient as already plant-based when they come just
// before it ("vegan ground beef", "plant-based butter").
const ALREADY_FINE =
  /(?:^|[\s(])(?:vegan|plant[- ]based|dairy[- ]free|non[- ]dairy|vegetarian|meatless|egg[- ]free|meat[- ]free)(?:\s+[\w'’-]+){0,2}\s+$/i;

const ORDINARY = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'your',
  'some',
  'more',
  'of',
  'with',
  'and',
  'or',
  'in',
  'to',
  'add',
  'stir',
  'whisk',
]);

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Compiled {
  readonly entry: VeganEntry;
  readonly pattern: RegExp;
}

function compile(entry: VeganEntry): Compiled {
  const phrases = [...entry.matches]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => escape(phrase).replace(/\s+/g, '\\s+'));
  // A trailing plural matches too (eggs, cheeses, tortillas).
  const core = `(?:${phrases.join('|')})(?:e?s)?`;
  const brand = entry.brandPrefix ? `(?:([\\w'’]+)\\s+)?` : '';
  return { entry, pattern: new RegExp(`${brand}\\b${core}\\b`, 'gi') };
}

interface Found {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly entry: VeganEntry;
}

/** Every non-vegan ingredient named in `text`, earlier library entries winning any overlap. */
function find(text: string, library: readonly Compiled[], only?: ReadonlySet<string>): Found[] {
  const found: Found[] = [];
  for (const { entry, pattern } of library) {
    if (only !== undefined && !only.has(entry.id)) continue;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      let start = match.index;
      const end = start + match[0].length;
      // A brand goes with the product only when it really is one: a
      // capitalised word that isn't an ordinary one ("Seggiano pesto",
      // never "the pesto"). The pattern is case-insensitive, so check here.
      const prefix = match[1];
      if (prefix !== undefined && (!/^[A-Z]/.test(prefix) || ORDINARY.has(prefix.toLowerCase()))) {
        start += match[0].length - match[0].slice(prefix.length).trimStart().length;
      }
      const before = text.slice(0, start);
      const after = text.slice(end).toLowerCase();
      const previousWord = /([\w'’-]+)\s*$/.exec(before)?.[1]?.toLowerCase() ?? '';
      if (ALREADY_FINE.test(before)) continue;
      if (/^-free\b/.test(after)) continue;
      if (entry.unless.includes(previousWord)) continue;
      if (
        entry.unlessFollowedBy.some((words) => new RegExp(`^\\s+${escape(words)}\\b`).test(after))
      )
        continue;
      if (found.some((other) => start < other.end && end > other.start)) continue;
      found.push({ start, end, text: text.slice(start, end), entry });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

function choose(entry: VeganEntry, choices: VeganChoices | null): VeganOption {
  const chosen = choices?.use[entry.id];
  const option =
    chosen === undefined ? entry.options[0] : entry.options.find((o) => o.id === chosen);
  if (option === undefined) {
    throw new Error(
      `vegan.use.${entry.id}: no option "${String(chosen)}" (have ${entry.options.map((o) => o.id).join(', ')})`,
    );
  }
  return option;
}

/**
 * The replacement words, matching the original's plural, and capitalised
 * only where a sentence starts — "grated Parmesan" is a proper noun, not a
 * capital to copy. A product name (any capital in it: "JUST Egg") and a
 * trailing parenthesis ("aquafaba (…)") are never pluralised.
 */
function wording(
  found: string,
  option: VeganOption,
  entry: VeganEntry,
  sentenceStart: boolean,
): string {
  const lower = found.toLowerCase().replace(/\s+/g, ' ');
  const plural = !entry.matches.includes(lower) && /s$/.test(lower) && !/s$/.test(option.use);
  let words = option.use;
  if (plural && !/[A-Z]/.test(words) && !/\)$/.test(words)) words = `${words}s`;
  return sentenceStart && /^[a-z]/.test(words)
    ? words.charAt(0).toUpperCase() + words.slice(1)
    : words;
}

function rewrite(
  text: string,
  library: readonly Compiled[],
  choices: VeganChoices | null,
  only?: ReadonlySet<string>,
): VeganLine {
  const swaps: Swap[] = [];
  const unresolved: Swap[] = [];
  let vegan = '';
  let cursor = 0;
  for (const found of find(text, library, only)) {
    const option = choose(found.entry, choices);
    const before = text.slice(0, found.start);
    const sentenceStart = /^\s*$/.test(before) || /[.!?]\s+$/.test(before);
    const into = wording(found.text, option, found.entry, sentenceStart);
    const swap = { entry: found.entry, option, found: found.text, into };
    if (option.confidence === 'reformulate') {
      unresolved.push(swap);
      continue;
    }
    vegan += text.slice(cursor, found.start) + into;
    cursor = found.end;
    swaps.push(swap);
  }
  vegan += text.slice(cursor);
  return { original: text, vegan, swaps, unresolved };
}

function firstPerEntry(swaps: readonly Swap[]): Swap[] {
  const seen = new Set<string>();
  return swaps.filter((swap) => !seen.has(swap.entry.id) && seen.add(swap.entry.id));
}

export interface RecipeLines {
  readonly ingredients: readonly string[];
  readonly optionalIngredients: readonly string[];
  readonly instructions: readonly string[];
}

/** The vegan reading of a recipe. The recipe itself is never modified. */
export function veganVersion(
  recipe: RecipeLines,
  library: readonly VeganEntry[],
  choices: VeganChoices | null = null,
): VeganVersion {
  const compiled = library.map(compile);
  const ingredients = recipe.ingredients.map((line) => rewrite(line, compiled, choices));
  const optionalIngredients = recipe.optionalIngredients.map((line) =>
    rewrite(line, compiled, choices),
  );
  const listed = [...ingredients, ...optionalIngredients];
  const swapped = new Set(listed.flatMap((line) => line.swaps.map((swap) => swap.entry.id)));
  const instructions = recipe.instructions.map((line) => rewrite(line, compiled, choices, swapped));
  const swaps = firstPerEntry(listed.flatMap((line) => line.swaps));
  const unresolved = firstPerEntry(listed.flatMap((line) => line.unresolved));
  const status: VeganStatus =
    unresolved.length > 0 ? 'not-adaptable' : swaps.length > 0 ? 'adaptable' : 'vegan';
  return { status, ingredients, optionalIngredients, instructions, swaps, unresolved };
}

export const CONFIDENCE_LABEL: Readonly<Record<Confidence, string>> = {
  direct: 'Direct swap',
  'recipe-dependent': 'Depends on the dish',
  reformulate: 'Needs a different recipe',
};
