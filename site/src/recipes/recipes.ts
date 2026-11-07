import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import { readLibrary } from './vegan.ts';
import type { VeganChoices, VeganEntry } from './vegan.ts';

/**
 * One hand-written YAML file per recipe under the repo-root `recipes/`
 * directory — no pipeline, no images yet. Reads like developer
 * documentation: a metadata row, ingredients, optional instructions in the
 * author's own words, short notes, and a version/date footer treating the
 * recipe as a living document rather than a one-off post.
 */
export interface Recipe {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly prepTime: string;
  readonly cookTime: string;
  readonly totalTime: string;
  readonly servings: string;
  readonly difficulty: string;
  /** May contain `**bold**` for quantities/measurements — see markup.ts. */
  readonly ingredients: readonly string[];
  readonly optionalIngredients: readonly string[];
  readonly instructions: readonly string[];
  readonly notes: readonly string[];
  /** Products the author uses, kept out of the ingredient lines: "Wheat noodles: A-Sha". */
  readonly brands: readonly string[];
  readonly version: string;
  readonly created: string;
  readonly updated: string;
  /** This recipe's own choices among the vegan options (vegan.ts), if it makes any. */
  readonly veganChoices: VeganChoices | null;
  /** Lowercase subject words ("tofu", "air-fryer"); written by the Reel importer, optional by hand. */
  readonly tags: readonly string[];
  /** Where an imported recipe came from, credited on its page; null for the author's own. */
  readonly source: RecipeSource | null;
}

/** The credit for a recipe adapted from someone else's post (tools/recipes writes it). */
export interface RecipeSource {
  readonly platform: string;
  /** Always https — anything else in the file is ignored rather than linked. */
  readonly url: string;
  /** "@handle", or "" when unknown. */
  readonly creator: string;
  readonly creatorUrl: string;
}

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Could not find the repository root above ${process.cwd()} (looking for pnpm-workspace.yaml). ` +
      'Run the site from inside the repository.',
  );
}

const ROOT = repositoryRoot();
const RECIPE_DIRECTORY = join(ROOT, 'recipes');

interface RecipeFile {
  readonly title?: string;
  readonly description?: string;
  readonly prepTime?: string;
  readonly cookTime?: string;
  readonly totalTime?: string;
  readonly servings?: string;
  readonly difficulty?: string;
  readonly ingredients?: readonly string[];
  readonly optionalIngredients?: readonly string[];
  readonly instructions?: readonly string[];
  readonly notes?: readonly string[];
  readonly brands?: readonly string[];
  readonly version?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly vegan?: { readonly use?: Readonly<Record<string, string>> };
  readonly tags?: readonly string[];
  readonly source?: {
    readonly platform?: string;
    readonly url?: string;
    readonly creator?: string;
    readonly creatorUrl?: string;
  };
}

const httpsOnly = (url: unknown): string =>
  typeof url === 'string' && url.startsWith('https://') ? url : '';

/** A source worth crediting needs at least a link; a missing or non-https one means no credit line. */
export function readSource(source: RecipeFile['source']): RecipeSource | null {
  const url = httpsOnly(source?.url);
  if (url === '') return null;
  return {
    platform: typeof source?.platform === 'string' ? source.platform : '',
    url,
    creator: typeof source?.creator === 'string' ? source.creator : '',
    creatorUrl: httpsOnly(source?.creatorUrl),
  };
}

function readRecipe(slug: string): Recipe {
  const path = join(RECIPE_DIRECTORY, `${slug}.yaml`);
  const data = (parse(readFileSync(path, 'utf8')) ?? {}) as RecipeFile;
  return {
    slug,
    title: data.title ?? slug,
    description: data.description ?? '',
    prepTime: data.prepTime ?? '',
    cookTime: data.cookTime ?? '',
    totalTime: data.totalTime ?? '',
    servings: data.servings ?? '',
    difficulty: data.difficulty ?? '',
    ingredients: data.ingredients ?? [],
    optionalIngredients: data.optionalIngredients ?? [],
    instructions: data.instructions ?? [],
    notes: data.notes ?? [],
    brands: data.brands ?? [],
    version: data.version ?? '',
    created: data.created ?? '',
    updated: data.updated ?? '',
    veganChoices: data.vegan?.use ? { use: data.vegan.use } : null,
    tags: (data.tags ?? []).filter((tag): tag is string => typeof tag === 'string'),
    source: readSource(data.source),
  };
}

/** The vegan substitution library (recipes/substitutions/vegan.yaml), checked. */
export function loadVeganLibrary(): VeganEntry[] {
  const path = join(RECIPE_DIRECTORY, 'substitutions', 'vegan.yaml');
  if (!existsSync(path)) return [];
  return readLibrary(parse(readFileSync(path, 'utf8')));
}

/** Every recipe under `recipes/`, sorted by title. */
export function loadRecipes(): Recipe[] {
  if (!existsSync(RECIPE_DIRECTORY)) return [];
  return readdirSync(RECIPE_DIRECTORY)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => readRecipe(name.slice(0, -'.yaml'.length)))
    .sort((a, b) => a.title.localeCompare(b.title));
}
