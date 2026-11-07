import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { draftProblems, slugify, toRecipeYaml } from './draft.ts';
import type { Draft } from './draft.ts';
import { shortcodeOf } from './instagram-url.ts';

/**
 * The importer's view of `recipes/`: which Reels are already in it, and
 * where a new one goes. Read fresh on every call — a dozen small files — so
 * a recipe added or deleted by hand while the importer runs is seen at once.
 */

export interface ExistingRecipe {
  readonly slug: string;
  readonly title: string;
}

function recipeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.yaml'));
}

/** The recipe already imported from this Reel, or null. A file that doesn't parse is skipped, not fatal. */
export function findByShortcode(directory: string, shortcode: string): ExistingRecipe | null {
  for (const name of recipeFiles(directory)) {
    let data: unknown;
    try {
      data = parse(readFileSync(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    const recipe = (typeof data === 'object' && data !== null ? data : {}) as {
      title?: unknown;
      source?: { url?: unknown };
    };
    if (shortcodeOf(recipe.source?.url) === shortcode) {
      const slug = name.slice(0, -'.yaml'.length);
      return { slug, title: typeof recipe.title === 'string' ? recipe.title : slug };
    }
  }
  return null;
}

/** A file name for this title that no recipe uses yet: `title`, then `title-2`, `title-3`… */
export function freeSlug(directory: string, title: string, shortcode: string): string {
  const base = slugify(title) || `reel-${shortcode.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const taken = new Set(recipeFiles(directory).map((name) => name.slice(0, -'.yaml'.length)));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type SaveResult =
  | { readonly ok: true; readonly slug: string; readonly path: string }
  | { readonly ok: false; readonly reason: 'invalid'; readonly problems: readonly string[] }
  | { readonly ok: false; readonly reason: 'duplicate'; readonly existing: ExistingRecipe };

/**
 * Writes the draft as a new recipe. Never overwrites: the duplicate check is
 * repeated here (another tab may have saved the same Reel since the review
 * began), and the file is opened with `wx`, so a name taken in between fails
 * instead of replacing someone's recipe.
 */
export function saveDraft(directory: string, draft: Draft, now = new Date()): SaveResult {
  const problems = draftProblems(draft);
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };
  const existing = findByShortcode(directory, draft.source.shortcode);
  if (existing !== null) return { ok: false, reason: 'duplicate', existing };

  const slug = freeSlug(directory, draft.title, draft.source.shortcode);
  const path = join(directory, `${slug}.yaml`);
  writeFileSync(path, toRecipeYaml(draft, now), { flag: 'wx' });
  return { ok: true, slug, path };
}
