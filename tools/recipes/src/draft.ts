import { Document, isScalar, visit } from 'yaml';

/**
 * A recipe as the importer's review screen holds it — one step removed from
 * `recipes/<slug>.yaml`, so that what a person checks and edits is plain
 * text in labelled fields rather than YAML and `**bold**` markup. Flags
 * (`flag` on a line, `warnings` on the whole) are review aids: they say
 * where the source was silent or unclear, and are never stored as if they
 * were recipe content (see `toRecipeYaml`).
 */
export interface DraftIngredient {
  /** "2 tbsp", "1–2 cups", "" when the source gave no amount. Becomes the bold, scalable part. */
  readonly amount: string;
  /** "soy sauce, low sodium" — the ingredient and any note the source attached to it. */
  readonly text: string;
  /** Why this line needs a second look, or "". */
  readonly flag: string;
}

export interface DraftStep {
  readonly text: string;
  readonly flag: string;
}

export type SourceVia =
  'caption' | 'pasted' | 'screenshots' | 'pasted+screenshots' | 'caption+screenshots';

export interface DraftSource {
  readonly url: string;
  readonly shortcode: string;
  /** Instagram handle without the @, or "". */
  readonly creator: string;
  /** Display name, if the source gave one, or "". */
  readonly creatorName: string;
  readonly via: SourceVia;
}

export interface Draft {
  readonly title: string;
  readonly description: string;
  readonly prepTime: string;
  readonly cookTime: string;
  readonly totalTime: string;
  readonly servings: string;
  readonly ingredients: readonly DraftIngredient[];
  readonly optionalIngredients: readonly DraftIngredient[];
  readonly instructions: readonly DraftStep[];
  readonly notes: readonly string[];
  readonly tags: readonly string[];
  readonly source: DraftSource;
  /** Whole-recipe concerns: missing amounts, not vegetarian, partly in a video's audio… */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Cleaning text that came from a stranger's caption and a model.

const LIMITS = { short: 80, title: 120, line: 600, description: 300, list: 60, tags: 8, tag: 24 };

/**
 * Plain, single-line text: no control characters, no zero-width or
 * bidirectional-override characters (which can make a line display
 * differently from what it contains), no `**` (the one markup the site
 * renders — the importer adds it itself, only around amounts), collapsed
 * whitespace, and a length cap. The site HTML-escapes everything it renders
 * (markup.ts), so angle brackets are left alone rather than mangled.
 */
export function cleanText(value: unknown, max: number = LIMITS.line): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

function cleanList<T>(value: unknown, each: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value.slice(0, LIMITS.list)) {
    const cleaned = each(item);
    if (cleaned !== null) out.push(cleaned);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function cleanIngredient(value: unknown): DraftIngredient | null {
  const raw = record(value);
  const text = cleanText(raw['text']);
  if (text.length === 0) return null;
  return { amount: cleanText(raw['amount'], LIMITS.short), text, flag: cleanText(raw['flag']) };
}

function cleanStep(value: unknown): DraftStep | null {
  const raw = record(value);
  const text = cleanText(raw['text']);
  return text.length === 0 ? null : { text, flag: cleanText(raw['flag']) };
}

/** Lowercase words and hyphens only: "weeknight", "air-fryer". */
export function cleanTag(value: unknown): string | null {
  const tag = cleanText(value, 200)
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
  return tag.length === 0 || tag.length > LIMITS.tag ? null : tag;
}

const VIA: ReadonlySet<string> = new Set([
  'caption',
  'pasted',
  'screenshots',
  'pasted+screenshots',
  'caption+screenshots',
]);

/**
 * A draft from anything — the model's output or the review form posted
 * back — with every field present, of the right type, and cleaned. The
 * source URL and shortcode are not trusted from the input; the caller sets
 * them from its own parse of the link.
 */
export function normalizeDraft(value: unknown, source: DraftSource): Draft {
  const raw = record(value);
  const rawSource = record(raw['source']);
  const via =
    typeof rawSource['via'] === 'string' && VIA.has(rawSource['via'])
      ? rawSource['via']
      : source.via;
  const creator = cleanText(rawSource['creator'] ?? source.creator, 40).replace(/^@/, '');
  const tags = [...new Set(cleanList(raw['tags'], cleanTag))].slice(0, LIMITS.tags);
  return {
    title: cleanText(raw['title'], LIMITS.title),
    description: cleanText(raw['description'], LIMITS.description),
    prepTime: cleanText(raw['prepTime'], LIMITS.short),
    cookTime: cleanText(raw['cookTime'], LIMITS.short),
    totalTime: cleanText(raw['totalTime'], LIMITS.short),
    servings: cleanText(raw['servings'], LIMITS.short),
    ingredients: cleanList(raw['ingredients'], cleanIngredient),
    optionalIngredients: cleanList(raw['optionalIngredients'], cleanIngredient),
    instructions: cleanList(raw['instructions'], cleanStep),
    notes: cleanList(raw['notes'], (note) => cleanText(note) || null),
    tags,
    source: {
      url: source.url,
      shortcode: source.shortcode,
      creator: /^[A-Za-z0-9._]{1,30}$/.test(creator) ? creator : '',
      creatorName: cleanText(rawSource['creatorName'] ?? source.creatorName, LIMITS.short),
      via: via as SourceVia,
    },
    warnings: cleanList(raw['warnings'], (warning) => cleanText(warning) || null),
  };
}

/** What has to be true before a draft can become a file; each problem is a sentence to show. */
export function draftProblems(draft: Draft): string[] {
  const problems: string[] = [];
  if (draft.title.length === 0) problems.push('Give the recipe a title.');
  if (draft.ingredients.length === 0) problems.push('Add at least one ingredient.');
  if (draft.instructions.length === 0) problems.push('Add at least one step.');
  return problems;
}

// ---------------------------------------------------------------------------
// Grounding: an amount the caption never mentions is flagged, not trusted.

const GLYPHS: Readonly<Record<string, number>> = {
  '¼': 1 / 4,
  '½': 1 / 2,
  '¾': 3 / 4,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '⅛': 1 / 8,
};
const WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  half: 1 / 2,
  quarter: 1 / 4,
  dozen: 12,
};
const NUMBER = /(\d+(?:[.,]\d+)?(?:\/\d+)?|[¼½¾⅓⅔⅛]|\b[a-z]+\b)/gi;

/** Every number a piece of text mentions, as values: "1 1/2 cups" → [1, 0.5]; "half a lemon" → [0.5, 1]. */
export function numbersIn(text: string): number[] {
  const values: number[] = [];
  for (const [token] of text.toLowerCase().matchAll(NUMBER)) {
    if (token in GLYPHS) values.push(GLYPHS[token] ?? 0);
    else if (/^[a-z]+$/.test(token)) {
      if (token in WORDS) values.push(WORDS[token] ?? 0);
    } else if (token.includes('/')) {
      const [top, bottom] = token.split('/').map(Number);
      if (top !== undefined && bottom !== undefined && bottom !== 0) values.push(top / bottom);
    } else values.push(Number(token.replace(',', '.')));
  }
  return values;
}

/**
 * Flags each ingredient whose amount contains a number the source text
 * never mentions — the most likely shape of a model filling a gap. Only
 * meaningful when the text is the whole source: with screenshots the
 * amounts may come from an image this can't read, so the caller skips it.
 * "Words" a/an count as 1, so "a pinch" stays unflagged while "2 pinches"
 * against a caption that never says two is caught.
 */
export function flagUngroundedAmounts(
  ingredients: readonly DraftIngredient[],
  sourceText: string,
): DraftIngredient[] {
  const known = numbersIn(sourceText);
  const mentioned = (value: number): boolean => known.some((k) => Math.abs(k - value) < 0.01);
  return ingredients.map((ingredient) => {
    if (ingredient.flag.length > 0) return ingredient;
    const missing = numbersIn(ingredient.amount).filter((value) => !mentioned(value));
    return missing.length === 0
      ? ingredient
      : { ...ingredient, flag: 'This amount isn’t in the caption.' };
  });
}

// ---------------------------------------------------------------------------
// Writing the file, in the shape the hand-written recipes already have.

/** "my-tofu-dish" from "My Tofu Dish!"; "" if the title has no letters or digits. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

const DURATION =
  /\b(\d+(?:[–-]\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)|\d+\s*°\s*[FC])\b/g;

/**
 * An ingredient line as the site reads it: the amount in `**bold**` (the
 * part the serving scaler multiplies), then the rest.
 */
export function ingredientLine(ingredient: DraftIngredient): string {
  return ingredient.amount.length > 0
    ? `**${ingredient.amount}** ${ingredient.text}`
    : ingredient.text;
}

/** A step as the site reads it: times and temperatures emphasised, the way the hand-written recipes mark them. */
export function stepLine(step: DraftStep): string {
  return step.text.replace(DURATION, '**$1**');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The YAML text of `recipes/<slug>.yaml`. Every field the site already
 * reads keeps its meaning; `tags` and `source` are new and optional, so a
 * hand-written recipe without them is unchanged. A line still flagged at
 * save time is kept, and its flag becomes a note beginning "Unconfirmed",
 * so the uncertainty is published honestly rather than silently dropped.
 */
export function toRecipeYaml(draft: Draft, now: Date): string {
  const month = `${MONTHS[now.getMonth()] ?? ''} ${String(now.getFullYear())}`;
  const unconfirmed = [
    ...draft.ingredients.filter((line) => line.flag).map((line) => `${line.text} (${line.flag})`),
    ...draft.optionalIngredients
      .filter((line) => line.flag)
      .map((line) => `${line.text} (${line.flag})`),
    ...draft.instructions.flatMap((line, index) =>
      line.flag ? [`Step ${String(index + 1)} (${line.flag})`] : [],
    ),
  ].map((text) => `Unconfirmed: ${text.replace(/\.\)$/, ')')}`);

  const data: Record<string, unknown> = {};
  const put = (key: string, value: string | readonly unknown[] | object): void => {
    if (typeof value === 'string' ? value.length > 0 : !Array.isArray(value) || value.length > 0) {
      data[key] = value;
    }
  };
  put('title', draft.title);
  put('description', draft.description);
  put('prepTime', draft.prepTime);
  put('cookTime', draft.cookTime);
  put('totalTime', draft.totalTime);
  put('servings', draft.servings);
  put('tags', draft.tags);
  put('ingredients', draft.ingredients.map(ingredientLine));
  put('optionalIngredients', draft.optionalIngredients.map(ingredientLine));
  put('instructions', draft.instructions.map(stepLine));
  put('notes', [...draft.notes, ...unconfirmed]);
  const source: Record<string, string> = { platform: 'Instagram', url: draft.source.url };
  if (draft.source.creator) {
    source['creator'] = `@${draft.source.creator}`;
    source['creatorUrl'] = `https://www.instagram.com/${draft.source.creator}/`;
  }
  if (draft.source.creatorName) source['creatorName'] = draft.source.creatorName;
  source['importedFrom'] = draft.source.via;
  source['imported'] = now.toISOString().slice(0, 10);
  put('source', source);
  put('version', '1.0');
  put('created', month);
  put('updated', month);

  const document = new Document(data);
  // Quote the way Prettier (singleQuote) does, so `pnpm check` accepts the
  // file as written: single quotes, double only to avoid escaping an apostrophe.
  visit(document, {
    Scalar(key, node) {
      if (key === 'key' || !isScalar(node) || typeof node.value !== 'string') return;
      const text = node.value;
      node.type = text.includes("'") && !text.includes('"') ? 'QUOTE_DOUBLE' : 'QUOTE_SINGLE';
    },
  });
  return document.toString({ lineWidth: 0 });
}
