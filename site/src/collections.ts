import { loadFilms } from './films/films.ts';
import { films } from './films/config.ts';
import { loadTracks } from './music/music.ts';
import { music } from './music/config.ts';
import { allFilmStocks, allTags, loadArchive } from './photography/archive.ts';
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
  /** Every public URL this collection owns — its index plus every item page. Read only by sitemap.xml.ts. */
  readonly urls: () => readonly string[];
}

export const collections: readonly Collection[] = [
  {
    slug: 'exposures',
    title: photography.title,
    // Read from photography/config.ts, not duplicated here — a second copy
    // of the same string is exactly how "I edited it and nothing changed"
    // bugs happen.
    description: photography.description,
    // Straight into Selected Work, not a preview page a visitor has to
    // click through a second time to reach the same photographs — see
    // docs/decisions.md.
    href: '/exposures/',
    stats: () => {
      const archive = loadArchive();
      const photographs = archive.photos.length;
      const tags = allTags(archive).length;
      return `${String(photographs)} photograph${photographs === 1 ? '' : 's'} · ${String(tags)} tag${tags === 1 ? '' : 's'}`;
    },
    urls: () => {
      const archive = loadArchive();
      return [
        '/exposures/',
        // Deliberately not '/exposures/archive/' — it's not linked from
        // any nav either; the route still
        // builds and serves, it's just not advertised to a sitemap crawler.
        ...allTags(archive).map((tag) => `/exposures/${tag}/`),
        ...allFilmStocks(archive).map((stock) => `/exposures/film/${stock}/`),
      ];
    },
  },
  {
    slug: 'dishes',
    title: recipes.title,
    description: recipes.description,
    href: '/dishes/',
    stats: () => {
      const count = loadRecipes().length;
      return `${String(count)} recipe${count === 1 ? '' : 's'}`;
    },
    urls: () => ['/dishes/', ...loadRecipes().map((recipe) => `/dishes/${recipe.slug}/`)],
  },
  {
    slug: 'tunes',
    title: music.title,
    description: music.description,
    href: '/tunes/',
    stats: () => {
      const count = loadTracks().length;
      return `${String(count)} track${count === 1 ? '' : 's'}`;
    },
    urls: () => ['/tunes/'],
  },
  {
    slug: 'pictures',
    title: films.title,
    description: films.description,
    href: '/pictures/',
    stats: () => {
      const count = loadFilms().length;
      return `${String(count)} film${count === 1 ? '' : 's'}`;
    },
    urls: () => ['/pictures/'],
  },
];
