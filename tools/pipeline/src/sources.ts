import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { PipelineError } from './errors.ts';
import { assertSlug } from './manifest.ts';

export interface Roll {
  /** Path from the album directory to this roll, forward-slash separated (e.g. "0827" or "europe/paris/0827"). */
  readonly id: string;
  /** Filenames directly inside this roll, sorted. */
  readonly files: readonly string[];
}

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

export function albumOriginalsPath(originals: string, slug: string): string {
  return join(originals, slug);
}

/**
 * Recursively finds every "roll": a directory that directly contains at least
 * one recognised image file, at any depth. Nothing is hardcoded about how deep
 * a roll sits or what its parent directories are named — a flat album (files
 * straight in the album directory) is just a roll whose id is `.`, and
 * `originals/<slug>/0827/` or `originals/<slug>/europe/paris/0827/` are found
 * the same way.
 *
 * A directory that contains only subdirectories (no images of its own) is not
 * a roll itself; its descendants are walked instead. Rolls are returned sorted
 * by id, and files within each roll are sorted by filename — the two facts
 * that together make ingest order deterministic and depth-independent.
 */
export async function listRolls(albumDirectory: string): Promise<Roll[]> {
  const rolls: Roll[] = [];

  async function walk(directory: string, id: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && RECOGNISED.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort();
    if (files.length > 0) rolls.push({ id, files });

    const subdirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of subdirectories) {
      await walk(join(directory, name), id === '.' ? name : `${id}/${name}`);
    }
  }

  await walk(albumDirectory, '.');
  return rolls.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Every photo across every roll, as a single path relative to the album
 * directory (e.g. "0827/001.tif", or "001.tif" for a roll at the album root).
 * Rolls are already sorted by id and files by name, so this list is what
 * determines the album's default sequence.
 */
export function flattenRolls(rolls: readonly Roll[]): { relPath: string; roll: string }[] {
  const photos: { relPath: string; roll: string }[] = [];
  for (const roll of rolls) {
    for (const file of roll.files) {
      photos.push({ relPath: roll.id === '.' ? file : `${roll.id}/${file}`, roll: roll.id });
    }
  }
  return photos;
}
