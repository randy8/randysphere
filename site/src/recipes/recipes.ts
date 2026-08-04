import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

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
  readonly version: string;
  readonly created: string;
  readonly updated: string;
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
  readonly version?: string;
  readonly created?: string;
  readonly updated?: string;
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
    version: data.version ?? '',
    created: data.created ?? '',
    updated: data.updated ?? '',
  };
}

/** Every recipe under `recipes/`, sorted by title. */
export function loadRecipes(): Recipe[] {
  if (!existsSync(RECIPE_DIRECTORY)) return [];
  return readdirSync(RECIPE_DIRECTORY)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => readRecipe(name.slice(0, -'.yaml'.length)))
    .sort((a, b) => a.title.localeCompare(b.title));
}
