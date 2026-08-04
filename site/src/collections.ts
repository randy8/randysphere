import { allTags, loadArchive } from './photography/archive.ts';
import { photography } from './photography/config.ts';
import { loadRecipes } from './recipes/recipes.ts';
import { recipes } from './recipes/config.ts';

/**
 * The homepage's only job is to introduce these — adding a collection is
 * "add an entry here and create its pages," never a change to the homepage,
 * the layout, or any other collection's code.
 */
export interface Collection {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly href: string;
  /**
   * A short, honestly computed line for the homepage's table of contents —
   * a real count read from the collection's own data every time, never a
   * hand-typed number left to go stale. A function, not a value, so it's
   * only ever computed where it's actually shown.
   */
  readonly stats: () => string;
}

export const collections: readonly Collection[] = [
  {
    slug: 'photography',
    title: photography.title,
    // Read from photography/config.ts, not duplicated here — a second copy
    // of the same string is exactly how "I edited it and nothing changed"
    // bugs happen.
    description: photography.description,
    href: '/photography/',
    stats: () => {
      const archive = loadArchive();
      const photographs = archive.photos.length;
      const tags = allTags(archive).length;
      return `${String(photographs)} photograph${photographs === 1 ? '' : 's'} · ${String(tags)} tag${tags === 1 ? '' : 's'}`;
    },
  },
  {
    slug: 'recipes',
    title: recipes.title,
    description: recipes.description,
    href: '/recipes/',
    stats: () => {
      const count = loadRecipes().length;
      return `${String(count)} recipe${count === 1 ? '' : 's'}`;
    },
  },
];
