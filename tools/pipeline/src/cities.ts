import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

/**
 * albums/cities.yaml — tags that name a city, with a display name. The
 * editor offers them as one-click buttons; the site reads the same file
 * itself (site/src/photography/archive.ts), duplicated rather than shared,
 * same as every other file on the pipeline↔site boundary.
 */
export interface City {
  readonly tag: string;
  readonly name: string;
}

export const CITIES_FILE = 'cities.yaml';

/** Missing file means no cities yet, not an error; a malformed entry is skipped. */
export async function readCities(albumsDirectory: string): Promise<City[]> {
  let text: string;
  try {
    text = await readFile(join(albumsDirectory, CITIES_FILE), 'utf8');
  } catch {
    return [];
  }
  const data = parse(text) as { cities?: unknown } | null;
  const entries = Array.isArray(data?.cities) ? (data.cities as unknown[]) : [];
  return entries.flatMap((entry) => {
    const { tag, name } = (entry ?? {}) as { tag?: unknown; name?: unknown };
    return typeof tag === 'string' && tag.length > 0
      ? [{ tag, name: typeof name === 'string' && name.length > 0 ? name : tag }]
      : [];
  });
}
