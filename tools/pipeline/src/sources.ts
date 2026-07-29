import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { PipelineError } from './errors.ts';
import { assertSlug } from './manifest.ts';

/**
 * What sharp reads reliably from a prebuilt binary.
 *
 * HEIC is absent on purpose: decoding it needs libheif, which is not in the
 * prebuilt binaries because of the patent situation around HEVC. Exporting to
 * JPEG or TIFF first is a one-line change in Lightroom and avoids making every
 * contributor build sharp from source.
 */
export const SOURCE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'] as const;

const RECOGNISED = new Set<string>(SOURCE_EXTENSIONS);

export async function listAlbumSlugs(originals: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(originals, { withFileTypes: true });
  } catch (cause) {
    throw new PipelineError(
      `Could not read ${originals}. Create it and put one directory per album inside.`,
      { cause },
    );
  }
  const slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const slug of slugs) assertSlug(slug, originals);
  return slugs.sort();
}

/**
 * Sorted by filename, which is what makes numbering photographs the way to set
 * an album's default sequence.
 */
export async function listSourceFiles(albumDirectory: string): Promise<string[]> {
  const entries = await readdir(albumDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && RECOGNISED.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
}

export function albumOriginalsPath(originals: string, slug: string): string {
  return join(originals, slug);
}
