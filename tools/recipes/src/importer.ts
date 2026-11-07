import { flagUngroundedAmounts, normalizeDraft } from './draft.ts';
import type { Draft, DraftSource, SourceVia } from './draft.ts';
import { ExtractionFailed, extractRecipe } from './extract.ts';
import type { Extraction, MessagesClient, Screenshot } from './extract.ts';
import { fetchCaption, ytDlpAvailable } from './fetch-caption.ts';
import type { CaptionResult, YtDlp } from './fetch-caption.ts';
import { InvalidReelUrl, parseReelUrl } from './instagram-url.ts';
import type { ReelReference } from './instagram-url.ts';
import { findByShortcode, saveDraft } from './library.ts';
import type { ExistingRecipe, SaveResult } from './library.ts';

/**
 * The importer's four steps — check the link, read the caption, draft the
 * recipe, save it — as plain functions over their dependencies, so the HTTP
 * layer is routing only and every step is testable without a network.
 */

export interface ImporterDeps {
  readonly recipesDirectory: string;
  readonly ytDlp?: YtDlp;
  /** Absent when no API key is configured: drafting is then unavailable, not broken. */
  readonly claude: MessagesClient | null;
  readonly model?: string;
  readonly now?: () => Date;
}

export type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export type CheckResult =
  | { readonly ok: true; readonly reel: ReelReference }
  | { readonly ok: false; readonly message: string; readonly existing?: ExistingRecipe };

export async function status(deps: ImporterDeps): Promise<{ ytDlp: boolean; claude: boolean }> {
  return { ytDlp: await ytDlpAvailable(deps.ytDlp), claude: deps.claude !== null };
}

/** Validates the link and refuses a Reel already in the collection. */
export function checkUrl(deps: ImporterDeps, url: unknown): CheckResult {
  let reel: ReelReference;
  try {
    reel = parseReelUrl(typeof url === 'string' ? url : '');
  } catch (error) {
    if (error instanceof InvalidReelUrl) return { ok: false, message: error.message };
    throw error;
  }
  const existing = findByShortcode(deps.recipesDirectory, reel.shortcode);
  if (existing !== null) {
    return { ok: false, message: `Already imported as “${existing.title}”.`, existing };
  }
  return { ok: true, reel };
}

export async function readCaption(deps: ImporterDeps, url: unknown): Promise<CaptionResult> {
  const checked = checkUrl(deps, url);
  if (!checked.ok) return checked;
  return fetchCaption(checked.reel, deps.ytDlp);
}

export interface DraftInput {
  readonly url: unknown;
  readonly text: unknown;
  /** Whether `text` came from yt-dlp (true) or was pasted by the person. */
  readonly textFromCaption: unknown;
  readonly creator: unknown;
  readonly creatorName: unknown;
  readonly screenshots: readonly Screenshot[];
}

const MAX_TEXT = 20_000;

function via(hasText: boolean, fromCaption: boolean, hasScreenshots: boolean): SourceVia {
  const text = fromCaption ? 'caption' : 'pasted';
  if (hasText && hasScreenshots) return `${text}+screenshots`;
  return hasText ? text : 'screenshots';
}

/** The model's extraction, made into a reviewable draft with every flag and warning it earned. */
export function draftFromExtraction(
  extraction: Extraction,
  source: DraftSource,
  sourceText: string,
  hasScreenshots: boolean,
): Draft {
  const draft = normalizeDraft(
    { ...extraction, source: { creator: source.creator || extraction.creator } },
    source,
  );
  const warnings = [...draft.warnings];
  if (extraction.vegetarian === 'no') {
    const items = extraction.nonVegetarianIngredients.join(', ');
    warnings.unshift(
      `Not vegetarian${items ? ` (${items})` : ''}. Dishes is a vegetarian menu — adapt it before saving, or don’t import it.`,
    );
  } else if (extraction.vegetarian === 'unclear') {
    warnings.push('Couldn’t tell whether this is vegetarian — check the ingredients.');
  }
  const tags =
    extraction.vegetarian === 'yes' && !draft.tags.includes('vegetarian')
      ? [...draft.tags, 'vegetarian']
      : draft.tags;
  // Amounts can be checked against a caption, not against a picture.
  const grounded = !hasScreenshots && sourceText.length > 0;
  return {
    ...draft,
    tags,
    warnings,
    ingredients: grounded
      ? flagUngroundedAmounts(draft.ingredients, sourceText)
      : draft.ingredients,
    optionalIngredients: grounded
      ? flagUngroundedAmounts(draft.optionalIngredients, sourceText)
      : draft.optionalIngredients,
  };
}

export async function draftRecipe(deps: ImporterDeps, input: DraftInput): Promise<Outcome<Draft>> {
  const checked = checkUrl(deps, input.url);
  if (!checked.ok) return checked;
  if (deps.claude === null) {
    return {
      ok: false,
      message: 'Drafting needs ANTHROPIC_API_KEY in .env. You can still write the recipe by hand.',
    };
  }
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text.length > MAX_TEXT) return { ok: false, message: 'That caption is too long.' };
  if (text.length === 0 && input.screenshots.length === 0) {
    return { ok: false, message: 'Paste the caption or add a screenshot first.' };
  }
  const creator = typeof input.creator === 'string' ? input.creator.replace(/^@/, '') : '';
  const source: DraftSource = {
    url: checked.reel.url,
    shortcode: checked.reel.shortcode,
    creator: /^[A-Za-z0-9._]{1,30}$/.test(creator) ? creator : '',
    creatorName: typeof input.creatorName === 'string' ? input.creatorName : '',
    via: via(text.length > 0, input.textFromCaption === true, input.screenshots.length > 0),
  };

  let extraction: Extraction;
  try {
    extraction = await extractRecipe(
      { text, screenshots: input.screenshots, creator: source.creator },
      deps.claude,
      deps.model,
    );
  } catch (error) {
    if (error instanceof ExtractionFailed) return { ok: false, message: error.message };
    throw error;
  }
  if (!extraction.isRecipe) {
    const why = extraction.warnings.join(' ');
    return { ok: false, message: `This doesn’t look like a recipe.${why ? ` ${why}` : ''}` };
  }
  return {
    ok: true,
    value: draftFromExtraction(extraction, source, text, input.screenshots.length > 0),
  };
}

/** Saves the reviewed draft. The link is re-parsed rather than trusted from the form. */
export function saveRecipe(
  deps: ImporterDeps,
  body: unknown,
): SaveResult | { ok: false; reason: 'url'; message: string } {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as {
    source?: { url?: unknown };
  };
  const checked = checkUrl(deps, raw.source?.url);
  if (!checked.ok) {
    return checked.existing === undefined
      ? { ok: false, reason: 'url', message: checked.message }
      : { ok: false, reason: 'duplicate', existing: checked.existing };
  }
  const draft = normalizeDraft(body, {
    url: checked.reel.url,
    shortcode: checked.reel.shortcode,
    creator: '',
    creatorName: '',
    via: 'pasted',
  });
  return saveDraft(deps.recipesDirectory, draft, deps.now?.());
}
