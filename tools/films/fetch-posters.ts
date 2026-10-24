import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import { parseCsv } from './csv.ts';

/**
 * A separate, explicitly-run enrichment step for the films collection —
 * the same relationship `pnpm describe` has to the photography pipeline.
 * `pnpm ingest` must stay offline; this script is never called by it.
 * Reads `films/ratings.csv`, looks each title up against TMDB's
 * search API, and writes `films/tmdb.json`, a committed cache of poster art
 * and plot text the site reads at build time (`site/src/films/films.ts`) —
 * the site itself never makes a network call, same boundary photography's
 * manifest already draws between an offline build and an online enrichment
 * step. The overview text lets a visitor read what a film is about without
 * leaving the site; the Letterboxd link stays too, as a reference, not the
 * only way to find out what something is.
 *
 * Usage: `pnpm films:posters` (needs TMDB_READ_ACCESS_TOKEN in .env — a
 * free key from https://www.themoviedb.org/settings/api). Resumable: a
 * film already in tmdb.json is skipped unless --regenerate is passed, or
 * --only="Title (Year)" (repeatable) to redo just specific films — the way
 * to pick up a new entry in films/tmdb-corrections.yaml without waiting on
 * all 773. A correction always overrides the search heuristic, even
 * without --regenerate. Uses the TMDB API but is not endorsed or certified
 * by TMDB — attributed on the films page per their terms.
 */

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find the repository root above ${process.cwd()}.`);
}

const ROOT = repositoryRoot();
const RATINGS_FILE = join(ROOT, 'films', 'ratings.csv');
const TMDB_FILE = join(ROOT, 'films', 'tmdb.json');
const CORRECTIONS_FILE = join(ROOT, 'films', 'tmdb-corrections.yaml');
const CONCURRENCY = 4;

interface CorrectionsFile {
  readonly corrections?: Record<string, number>;
}

/** Hand-confirmed TMDB ids that override the search heuristic entirely — see films/tmdb-corrections.yaml. */
function readCorrections(): Record<string, number> {
  if (!existsSync(CORRECTIONS_FILE)) return {};
  const data = (parse(readFileSync(CORRECTIONS_FILE, 'utf8')) ?? {}) as CorrectionsFile;
  return data.corrections ?? {};
}

interface RatingEntry {
  readonly title: string;
  readonly year: number;
}

function readRatings(): RatingEntry[] {
  const [header, ...rows] = parseCsv(readFileSync(RATINGS_FILE, 'utf8'));
  if (header === undefined) return [];
  const nameIndex = header.indexOf('Name');
  const yearIndex = header.indexOf('Year');
  return rows
    .map((cells) => ({
      title: cells[nameIndex] ?? '',
      year: Number.parseInt(cells[yearIndex] ?? '', 10),
    }))
    .filter((entry) => entry.title.length > 0 && !Number.isNaN(entry.year));
}

/** `films.ts`'s `Film` identifies each row by title+year; this is that same key. */
export function posterKey(title: string, year: number): string {
  return `${title} (${String(year)})`;
}

interface TmdbSearchResult {
  readonly poster_path: string | null;
  readonly release_date?: string;
  readonly overview?: string;
  readonly id: number;
}
interface TmdbSearchResponse {
  readonly results: readonly TmdbSearchResult[];
}

export interface TmdbEntry {
  readonly tmdbId: number;
  readonly posterPath: string | null;
  readonly overview: string;
  readonly runtimeMinutes: number | null;
  readonly director: string | null;
  readonly genres: readonly string[];
}

interface TmdbCrewMember {
  readonly job: string;
  readonly name: string;
}
interface TmdbGenre {
  readonly name: string;
}
interface TmdbMovieDetails {
  readonly poster_path: string | null;
  readonly overview?: string;
  readonly runtime: number | null;
  readonly credits?: { readonly crew: readonly TmdbCrewMember[] };
  readonly genres?: readonly TmdbGenre[];
}

/** One call, `append_to_response=credits`, gets everything a `TmdbEntry` needs for a known id. */
async function fetchById(id: number, token: string): Promise<TmdbEntry> {
  const url = new URL(`https://api.themoviedb.org/3/movie/${String(id)}`);
  url.searchParams.set('append_to_response', 'credits');
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`TMDB details for movie ${String(id)} failed: ${String(response.status)}`);
  }
  const data = (await response.json()) as TmdbMovieDetails;
  const director = data.credits?.crew.find((member) => member.job === 'Director')?.name ?? null;
  return {
    tmdbId: id,
    posterPath: data.poster_path,
    overview: data.overview ?? '',
    runtimeMinutes: data.runtime ?? null,
    director,
    genres: data.genres?.map((genre) => genre.name) ?? [],
  };
}

async function searchFilm(title: string, year: number, token: string): Promise<TmdbEntry | null> {
  const url = new URL('https://api.themoviedb.org/3/search/movie');
  url.searchParams.set('query', title);
  url.searchParams.set('year', String(year));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(
      `TMDB search for "${title}" (${String(year)}) failed: ${String(response.status)}`,
    );
  }
  const data = (await response.json()) as TmdbSearchResponse;

  // Prefer a result whose release year matches exactly — TMDB's own
  // relevance ranking sometimes puts a same-titled remake or a TV movie
  // first. Falls back to the top result if nothing matches the year, since
  // a slightly-off match still beats no entry at all. This is imperfect:
  // it weighs year over title similarity, so a film TMDB dates differently
  // than Letterboxd (a festival year vs. a wide-release year, most often)
  // can lose to an unrelated same-year film that merely shares a word of
  // the title — see films/tmdb-corrections.yaml for the deliberate escape
  // hatch when that happens.
  const exact = data.results.find((result) => result.release_date?.startsWith(String(year)));
  const best = exact ?? data.results[0];
  if (best === undefined) return null;
  return fetchById(best.id, token);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function main(): Promise<void> {
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const token = process.env['TMDB_READ_ACCESS_TOKEN'];
  // Optional enrichment, run by every `pnpm sync`/`pnpm deploy`: without a
  // token, new films simply show without a poster — never a failed deploy.
  if (token === undefined || token.length === 0) {
    console.warn(
      'films: TMDB_READ_ACCESS_TOKEN is not set in .env, skipping poster lookup. ' +
        'Get a free key at https://www.themoviedb.org/settings/api.',
    );
    return;
  }

  const regenerate = process.argv.includes('--regenerate');
  const only = process.argv
    .filter((arg) => arg.startsWith('--only='))
    .map((arg) => arg.slice('--only='.length));
  const ratings = readRatings();
  const corrections = readCorrections();
  const cache: Record<string, TmdbEntry | null> = existsSync(TMDB_FILE)
    ? (JSON.parse(readFileSync(TMDB_FILE, 'utf8')) as typeof cache)
    : {};

  const pending = ratings.filter((entry) => {
    const key = posterKey(entry.title, entry.year);
    if (only.length > 0) return only.includes(key);
    return regenerate || key in corrections || !(key in cache);
  });
  console.log(`${String(ratings.length)} films rated, ${String(pending.length)} to look up.`);

  let completed = 0;
  let matched = 0;
  let withPoster = 0;
  await mapWithConcurrency(pending, CONCURRENCY, async (entry) => {
    const key = posterKey(entry.title, entry.year);
    try {
      const correctedId = corrections[key];
      // Refreshing a film that's already matched (e.g. --regenerate after
      // adding a new field to TmdbEntry) re-fetches its known id rather
      // than searching again — search is a heuristic (see searchFilm's own
      // comment) and re-running it risks landing on a different film than
      // last time for no reason. Only a film with no cached match yet, or
      // a title/year --only run, goes through search.
      const knownId = correctedId ?? cache[key]?.tmdbId;
      const result =
        knownId === undefined
          ? await searchFilm(entry.title, entry.year, token)
          : await fetchById(knownId, token);
      cache[key] = result;
      if (result !== null) {
        matched += 1;
        if (result.posterPath !== null) withPoster += 1;
      }
    } catch (error) {
      console.error(`  ${key}: ${error instanceof Error ? error.message : String(error)}`);
      cache[key] = null;
    }
    completed += 1;
    if (completed % 50 === 0 || completed === pending.length) {
      console.log(
        `  ${String(completed)}/${String(pending.length)} looked up, ${String(matched)} matched, ${String(withPoster)} with a poster`,
      );
    }
  });

  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  // Every deploy runs this; with nothing new it must leave the committed
  // file byte-for-byte alone, not dirty the working tree.
  if (existsSync(TMDB_FILE) && readFileSync(TMDB_FILE, 'utf8') === text) {
    console.log('films: nothing new from TMDB.');
    return;
  }
  writeFileSync(TMDB_FILE, text);

  const unmatched = Object.values(cache).filter((entry) => entry === null).length;
  console.log(
    `Wrote ${TMDB_FILE}. ${String(unmatched)} of ${String(ratings.length)} films had no TMDB match.`,
  );
}

await main();
