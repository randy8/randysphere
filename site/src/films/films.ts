import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

/**
 * One committed CSV — `films/five-star-ratings.csv`, Letterboxd's own
 * "export your data" file, trimmed to ratings and left otherwise
 * untouched — not one file per film the way recipes are. 773 films is not
 * 773 hand-written documents; a single file a spreadsheet or a script can
 * still open is the honest shape for data of this size, same as why
 * photography's manifest is one JSON file per batch rather than one per
 * photo. No pipeline, no live fetching: this reads committed files off
 * disk at build time like every other collection. Poster art, plot text,
 * runtime, and director come from a second committed file, `films/tmdb.json`,
 * written by a separate opt-in enrichment step (`pnpm films:posters`, see
 * tools/films/fetch-posters.ts) — the same relationship `pnpm describe` has
 * to photography's pipeline. A third, hand-maintained file,
 * `films/poster-overrides.yaml`, optionally corrects a specific poster's
 * crop (see PosterFocal below). All three are optional: `loadFilms` still
 * returns every rating with the enriched fields `null` if either file is
 * missing.
 */
export interface PosterFocal {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Film {
  readonly title: string;
  readonly year: number;
  readonly ratedOn: string;
  readonly letterboxdUrl: string;
  readonly posterPath: string | null;
  readonly overview: string | null;
  readonly runtimeMinutes: number | null;
  readonly director: string | null;
  readonly posterFocal: PosterFocal | null;
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
const RATINGS_FILE = join(ROOT, 'films', 'five-star-ratings.csv');
const TMDB_FILE = join(ROOT, 'films', 'tmdb.json');
const OVERRIDES_FILE = join(ROOT, 'films', 'poster-overrides.yaml');

/**
 * A minimal RFC 4180 reader — quoted fields, doubled `""` for a literal
 * quote, commas and newlines inside quotes. Letterboxd's export is exactly
 * this shape (titles like `"Synecdoche, New York"` are why a naive
 * `split(',')` would silently corrupt the file), and it's little enough
 * code that pulling in a CSV package for one file didn't earn its keep.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0) || row.length > 1) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface TmdbCacheEntry {
  readonly posterPath: string | null;
  readonly overview: string;
  readonly runtimeMinutes: number | null;
  readonly director: string | null;
}

/** Same key format `tools/films/fetch-posters.ts`'s `posterKey` writes. */
function tmdbKey(title: string, year: number): string {
  return `${title} (${String(year)})`;
}

function readTmdbCache(): Record<string, TmdbCacheEntry | null> {
  if (!existsSync(TMDB_FILE)) return {};
  return JSON.parse(readFileSync(TMDB_FILE, 'utf8')) as Record<string, TmdbCacheEntry | null>;
}

interface PosterOverridesFile {
  readonly overrides?: Record<
    string,
    { readonly focalX?: number; readonly focalY?: number; readonly zoom?: number }
  >;
}

function readPosterOverrides(): Record<string, PosterFocal> {
  if (!existsSync(OVERRIDES_FILE)) return {};
  const data = (parse(readFileSync(OVERRIDES_FILE, 'utf8')) ?? {}) as PosterOverridesFile;
  const result: Record<string, PosterFocal> = {};
  for (const [key, value] of Object.entries(data.overrides ?? {})) {
    result[key] = { x: value.focalX ?? 50, y: value.focalY ?? 50, zoom: value.zoom ?? 1 };
  }
  return result;
}

/** Every five-star rating, sorted newest-rated first. Empty if the export hasn't been added yet. */
export function loadFilms(): Film[] {
  if (!existsSync(RATINGS_FILE)) return [];
  const [header, ...rows] = parseCsv(readFileSync(RATINGS_FILE, 'utf8'));
  if (header === undefined) return [];

  const dateIndex = header.indexOf('Date');
  const nameIndex = header.indexOf('Name');
  const yearIndex = header.indexOf('Year');
  const uriIndex = header.indexOf('Letterboxd URI');
  const tmdb = readTmdbCache();
  const overrides = readPosterOverrides();

  return rows
    .map((cells): Film => {
      const title = cells[nameIndex] ?? '';
      const year = Number.parseInt(cells[yearIndex] ?? '', 10);
      const key = tmdbKey(title, year);
      const entry = tmdb[key];
      return {
        title,
        year: Number.isNaN(year) ? 0 : year,
        ratedOn: cells[dateIndex] ?? '',
        letterboxdUrl: cells[uriIndex] ?? '',
        posterPath: entry?.posterPath ?? null,
        overview: entry?.overview && entry.overview.length > 0 ? entry.overview : null,
        runtimeMinutes: entry?.runtimeMinutes ?? null,
        director: entry?.director ?? null,
        posterFocal: overrides[key] ?? null,
      };
    })
    .filter((film) => film.title.length > 0)
    .sort((a, b) => b.ratedOn.localeCompare(a.ratedOn));
}

/** `142` -> `"2h 22m"`; under an hour just reads as `"45m"`. */
export function formatRuntime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${String(remainder)}m`;
  return `${String(hours)}h ${String(remainder)}m`;
}

/**
 * Cut to a word boundary rather than mid-word, so a plot summary reads as
 * a deliberately short excerpt rather than text that just ran out. Returns
 * the original string unchanged if it already fits.
 */
export function excerpt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed}…`;
}

export interface FilmYearGroup {
  readonly year: string;
  readonly films: readonly Film[];
}

/** Films grouped by the year they were rated, newest year first — the archive's own rolls, for a viewing log. */
export function filmsByYearRated(films: readonly Film[]): FilmYearGroup[] {
  const groups = new Map<string, Film[]>();
  for (const film of films) {
    const year = film.ratedOn.slice(0, 4) || 'Undated';
    const existing = groups.get(year);
    if (existing) existing.push(film);
    else groups.set(year, [film]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, yearFilms]) => ({ year, films: yearFilms }));
}
