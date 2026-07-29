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

export interface PhotosFileEntry {
  readonly file: string;
  readonly alt: string;
  readonly caption: string | null;
}

/** Read-only. Used by `pnpm describe` to see what's already written before deciding whether to generate anything. */
export async function readPhotosFile(albumDirectory: string): Promise<PhotosFileEntry[]> {
  const path = join(albumDirectory, PHOTOS_FILE);
  const source = path;
  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }
  const sequence = readPhotosSequence(document, source);
  const items = sequence?.items ?? [];
  return items.map((item, index) => {
    const file = entryFilename(item, source, index);
    const map = item as YAMLMap;
    const alt = map.get('alt');
    const caption = map.get('caption');
    return {
      file,
      alt: typeof alt === 'string' ? alt : '',
      caption: typeof caption === 'string' && caption.length > 0 ? caption : null,
    };
  });
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

  if (document.toString({ lineWidth: 0 }) !== original) {
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

  await writeFileAtomic(path, document.toString({ lineWidth: 0 }));

  const refreshed = parseDocument(await readFile(path, 'utf8'));
  const refreshedItems = readPhotosSequence(refreshed, source)?.items ?? [];
  const missingAlt = refreshedItems
    .map((item, index) => ({ file: entryFilename(item, source, index), ok: hasAltText(item) }))
    .filter((entry) => !entry.ok)
    .map((entry) => entry.file);

  return { created: false, added, removed, missingAlt };
}

const ROLLS_FILE = 'rolls.yaml';

const ROLLS_HEADER = [
  '# Roll-level notes.',
  '#',
  '# `pnpm ingest` maintains which roll ids are listed here and nothing else.',
  '# The order, the fields, and every comment are yours; re-running ingest',
  '# will not touch them.',
  '',
].join('\n');

export interface RollsFileResult {
  readonly created: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function renderNewRollsFile(ids: readonly string[]): string {
  const rolls = ids.map((id) => ({ id, filmStock: '', notes: '' }));
  return `${ROLLS_HEADER}${stringify({ rolls }, { lineWidth: 0 })}`;
}

function readRollsSequence(document: Document, source: string): YAMLSeq | null {
  const node = document.get('rolls', true);
  if (node === undefined || node === null) return null;
  if (!isSeq(node)) {
    throw new PipelineError(`${source}: "rolls" must be a list of entries.`);
  }
  return node;
}

function entryRollId(item: unknown, source: string, index: number): string {
  if (!isMap(item)) {
    throw new PipelineError(
      `${source}: rolls[${index.toString()}] must be a mapping with an "id" key, for example:\n` +
        '  - id: 0827\n    filmStock: Kodak Portra 400',
    );
  }
  const id = (item as YAMLMap).get('id');
  if (typeof id !== 'string' || id.length === 0) {
    throw new PipelineError(`${source}: rolls[${index.toString()}] has no "id" value.`);
  }
  return id;
}

/**
 * Same shape and the same round-trip safety as `syncPhotosFile`, one level up:
 * keeps `rolls.yaml`'s list of roll ids in line with what ingest found,
 * leaving film stock, notes, and comments exactly as the photographer left
 * them.
 */
export async function syncRollsFile(albumDirectory: string, ids: readonly string[]): Promise<RollsFileResult> {
  const path = join(albumDirectory, ROLLS_FILE);
  const source = path;

  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    await writeFileAtomic(path, renderNewRollsFile(ids));
    return { created: true, added: [...ids], removed: [] };
  }

  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }

  const sequence = readRollsSequence(document, source);
  const items = sequence?.items ?? [];
  const listed = items.map((item, index) => entryRollId(item, source, index));
  const wanted = new Set(ids);

  const removed = listed.filter((id) => !wanted.has(id));
  const added = ids.filter((id) => !listed.includes(id));

  if (removed.length === 0 && added.length === 0) {
    return { created: false, added: [], removed: [] };
  }

  if (document.toString({ lineWidth: 0 }) !== original) {
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
      document.set('rolls', document.createNode([]));
      const created = readRollsSequence(document, source);
      if (created === null) throw new PipelineError(`${source}: could not create a "rolls" list.`);
      return created;
    })();

  for (let index = target.items.length - 1; index >= 0; index -= 1) {
    if (removed.includes(listed[index] ?? '')) target.delete(index);
  }
  for (const id of added) {
    target.add(document.createNode({ id, filmStock: '', notes: '' }));
  }

  await writeFileAtomic(path, document.toString({ lineWidth: 0 }));

  return { created: false, added, removed };
}

export interface Description {
  readonly alt: string;
  readonly caption: string | null;
}

/**
 * Fills in `alt` (and `caption`, if given) for one existing `photos.yaml`
 * entry, in place. Used only by `pnpm describe`, and only ever called by a
 * caller that has already decided it's safe to write — this function does not
 * itself check whether the entry already has a description. Every other
 * entry, and every comment, is left exactly as it was.
 */
export async function setPhotoDescription(
  albumDirectory: string,
  file: string,
  description: Description,
): Promise<void> {
  const path = join(albumDirectory, PHOTOS_FILE);
  const source = path;
  const original = await readFile(path, 'utf8');

  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }
  const sequence = readPhotosSequence(document, source);
  const items = sequence?.items ?? [];
  const index = items.findIndex((item, i) => entryFilename(item, source, i) === file);
  if (index === -1) {
    throw new PipelineError(`${source}: no entry for ${JSON.stringify(file)}.`);
  }
  const item = items[index];
  if (!isMap(item)) throw new PipelineError(`${source}: photos[${index.toString()}] is not a mapping.`);
  item.set('alt', description.alt);
  if (description.caption !== null) item.set('caption', description.caption);

  await writeFileAtomic(path, document.toString({ lineWidth: 0 }));
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
