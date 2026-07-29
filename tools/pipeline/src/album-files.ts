import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMap, isSeq, parseDocument, stringify } from 'yaml';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';

import { writeFileAtomic } from './files.ts';
import { PipelineError } from './errors.ts';

const PHOTOS_FILE = 'photos.yaml';
const ALBUM_FILE = 'album.md';

const HEADER = [
  '# Captions and alt text.',
  '#',
  '# `pnpm ingest` maintains which files are listed here and nothing else.',
  '# The order, the fields, and every comment are yours; re-running ingest will',
  '# not touch them. Renaming a photograph in originals/ is a rename, and the',
  '# entry below will be replaced rather than followed.',
  '',
].join('\n');

export interface PhotosFileResult {
  readonly created: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Entries present but with nothing written in `alt`. */
  readonly missingAlt: readonly string[];
}

function renderNewFile(files: readonly string[]): string {
  const photos = files.map((file) => ({ file, alt: '' }));
  return `${HEADER}${stringify({ photos }, { lineWidth: 0 })}`;
}

function readPhotosSequence(document: Document, source: string): YAMLSeq | null {
  const node = document.get('photos', true);
  if (node === undefined || node === null) return null;
  if (!isSeq(node)) {
    throw new PipelineError(`${source}: "photos" must be a list of entries.`);
  }
  return node;
}

function entryFilename(item: unknown, source: string, index: number): string {
  if (!isMap(item)) {
    throw new PipelineError(
      `${source}: photos[${index.toString()}] must be a mapping with a "file" key, for example:\n` +
        '  - file: 001.jpg\n    alt: Snow settling on a shrine roof',
    );
  }
  const file = (item as YAMLMap).get('file');
  if (typeof file !== 'string' || file.length === 0) {
    throw new PipelineError(`${source}: photos[${index.toString()}] has no "file" value.`);
  }
  return file;
}

function hasAltText(item: unknown): boolean {
  if (!isMap(item)) return false;
  const alt = (item as YAMLMap).get('alt');
  return typeof alt === 'string' && alt.trim().length > 0;
}

/**
 * Bring the list of entries into line with what is actually in originals/,
 * changing nothing else.
 *
 * The round-trip check is the important part. Before modifying a file that
 * contains somebody's writing, we re-serialise it unchanged and compare: if the
 * result is not byte-identical, our writer would reformat their file, so we
 * refuse and tell them exactly what to edit instead. It fires rarely — the
 * library is faithful with files it wrote itself — and when it does, printing
 * two short lists is a much better outcome than silently restyling an album's
 * captions.
 */
export async function syncPhotosFile(
  albumDirectory: string,
  files: readonly string[],
): Promise<PhotosFileResult> {
  const path = join(albumDirectory, PHOTOS_FILE);
  const source = path;

  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    await writeFileAtomic(path, renderNewFile(files));
    return { created: true, added: [...files], removed: [], missingAlt: [...files] };
  }

  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }

  const sequence = readPhotosSequence(document, source);
  const items = sequence?.items ?? [];
  const listed = items.map((item, index) => entryFilename(item, source, index));
  const wanted = new Set(files);

  const removed = listed.filter((file) => !wanted.has(file));
  const added = files.filter((file) => !listed.includes(file));

  if (removed.length === 0 && added.length === 0) {
    const missingAlt = items
      .map((item, index) => ({ file: listed[index] ?? '', ok: hasAltText(item) }))
      .filter((entry) => !entry.ok)
      .map((entry) => entry.file);
    return { created: false, added: [], removed: [], missingAlt };
  }

  if (document.toString() !== original) {
    throw new PipelineError(
      `${source} needs updating, but rewriting it would also reformat it, so nothing was changed.\n` +
        'Please edit it by hand:\n' +
        (added.length > 0 ? `  add:    ${added.join(', ')}\n` : '') +
        (removed.length > 0 ? `  remove: ${removed.join(', ')}\n` : '') +
        'Then run ingest again.',
    );
  }

  const target =
    sequence ??
    (() => {
      document.set('photos', document.createNode([]));
      const created = readPhotosSequence(document, source);
      if (created === null) throw new PipelineError(`${source}: could not create a "photos" list.`);
      return created;
    })();

  for (let index = target.items.length - 1; index >= 0; index -= 1) {
    if (removed.includes(listed[index] ?? '')) target.delete(index);
  }
  for (const file of added) {
    target.add(document.createNode({ file, alt: '' }));
  }

  await writeFileAtomic(path, document.toString());

  const refreshed = parseDocument(await readFile(path, 'utf8'));
  const refreshedItems = readPhotosSequence(refreshed, source)?.items ?? [];
  const missingAlt = refreshedItems
    .map((item, index) => ({ file: entryFilename(item, source, index), ok: hasAltText(item) }))
    .filter((entry) => !entry.ok)
    .map((entry) => entry.file);

  return { created: false, added, removed, missingAlt };
}

function titleFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Written once, when an album first appears, and never touched again. Every
 * value is a starting point the photographer is expected to replace; the point
 * is that `pnpm ingest` leaves a file that already parses rather than an error
 * about a missing one.
 */
export async function scaffoldAlbumMarkdown(
  albumDirectory: string,
  slug: string,
  earliestTakenAt: string | null,
  coverFile: string,
): Promise<boolean> {
  const path = join(albumDirectory, ALBUM_FILE);
  try {
    await readFile(path, 'utf8');
    return false;
  } catch {
    // Does not exist, which is the only case in which we write it.
  }

  const date = (earliestTakenAt ?? new Date().toISOString()).slice(0, 10);
  const frontmatter = stringify(
    {
      title: titleFromSlug(slug),
      date,
      location: '',
      description: '',
      featured: false,
      cover: coverFile,
    },
    { lineWidth: 0 },
  );

  await writeFileAtomic(path, `---\n${frontmatter}---\n`);
  return true;
}
