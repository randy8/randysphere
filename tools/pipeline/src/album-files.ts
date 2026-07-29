import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isMap, isSeq, parseDocument, stringify } from 'yaml';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';

import { writeFileAtomic } from './files.ts';
import { PipelineError } from './errors.ts';
import { sha256Hex } from './hash.ts';

/** Exported so the editor can locate the file directly, e.g. to hash its raw content for the staleness guard. */
export const PHOTOS_FILE = 'photos.yaml';
const ALBUM_FILE = 'album.md';

const HEADER = [
  '# Captions and alt text.',
  '#',
  '# `pnpm ingest` maintains which files are listed here and nothing else.',
  '# The order, the fields, and every comment are yours; re-running ingest will',
  '# not touch them. A photo is identified by its content (`sourceId`) first,',
  '# so moving or renaming a file in originals/ — even into a different roll —',
  '# keeps its entry below, alt text, caption, and tags intact. Only a photo',
  '# actually deleted from originals/ loses its entry.',
  '',
].join('\n');

/** A photo as ingest currently sees it: its content id and where it currently lives. */
export interface PhotoRef {
  readonly file: string;
  readonly sourceId: string;
}

export interface PhotosFileResult {
  readonly created: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** An existing entry matched to its content at a new path — a real move/rename, not an add+remove. */
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  /** Entries present but with nothing written in `alt`. */
  readonly missingAlt: readonly string[];
  /** Entries that had no `tags` key at all and were seeded with `[defaultTag]`. Never fires again once a photo has a `tags` key, even an empty one. */
  readonly tagsBackfilled: readonly string[];
  /** Entries that predate the `sourceId` field and were matched by path (the only option available to them) and given one, once. */
  readonly sourceIdBackfilled: readonly string[];
}

function renderNewFile(photos: readonly PhotoRef[], defaultTag: string): string {
  const entries = photos.map(({ file, sourceId }) => ({
    file,
    sourceId,
    alt: '',
    tags: [defaultTag],
  }));
  return `${HEADER}${stringify({ photos: entries }, { lineWidth: 0 })}`;
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
  const file = item.get('file');
  if (typeof file !== 'string' || file.length === 0) {
    throw new PipelineError(`${source}: photos[${index.toString()}] has no "file" value.`);
  }
  return file;
}

function hasAltText(item: unknown): boolean {
  if (!isMap(item)) return false;
  const alt = item.get('alt');
  return typeof alt === 'string' && alt.trim().length > 0;
}

/** True once a photo has any `tags` key at all, even an empty list — that means a person (or a prior ingest) has already spoken for it, so the default-tag backfill leaves it alone. */
function hasTagsKey(item: unknown): boolean {
  if (!isMap(item)) return false;
  return item.get('tags') !== undefined;
}

/** `null` for a legacy entry written before this field existed — never thrown for, unlike `file`, since its absence is an expected, handled state rather than a malformed file. */
function entrySourceId(item: unknown): string | null {
  if (!isMap(item)) return null;
  const value = item.get('sourceId');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `YAMLMap.get('tags')` returns the raw `YAMLSeq` node, not a plain array —
 * unlike a scalar field (`alt`), a collection value is never unwrapped by
 * `.get()` regardless of its `keepScalar` argument. `.toJSON()` resolves it
 * (and every scalar inside it) down to plain JS.
 */
function readTags(item: YAMLMap): string[] {
  const node = item.get('tags');
  if (!isSeq(node)) return [];
  const values: unknown = node.toJSON();
  return Array.isArray(values)
    ? values.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

export interface PhotosFileEntry {
  readonly file: string;
  /** `null` for an entry written before this field existed; backfilled by the next `syncPhotosFile` call. */
  readonly sourceId: string | null;
  readonly alt: string;
  readonly caption: string | null;
  readonly tags: readonly string[];
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
      sourceId: entrySourceId(map),
      alt: typeof alt === 'string' ? alt : '',
      caption: typeof caption === 'string' && caption.length > 0 ? caption : null,
      tags: readTags(map),
    };
  });
}

/** An existing `photos.yaml` entry as read off disk — unlike `PhotoRef`, its `sourceId` may be `null` (a legacy entry predating the field). */
interface ListedEntry {
  readonly file: string;
  readonly sourceId: string | null;
}

interface Correlation {
  readonly match: PhotoRef | null;
  readonly via: 'sourceId' | 'path' | null;
}

/**
 * Matches each existing `photos.yaml` entry to a current photo: by `sourceId`
 * first (survives a move — a directory rename or reorganisation doesn't
 * change a file's bytes), falling back to `file` (survives a same-path
 * re-export, whose `sourceId` deliberately changes — see docs/decisions.md,
 * "the source digest covers file bytes, not pixels"). An entry matching
 * neither is genuinely gone. A `sourceId` shared by more than one current
 * photo (byte-identical duplicate content) can't disambiguate a move, so it's
 * excluded from sourceId matching entirely and falls back to path, same as a
 * legacy entry with no `sourceId` at all.
 */
function correlate(listed: readonly ListedEntry[], photos: readonly PhotoRef[]): Correlation[] {
  const duplicateCounts = new Map<string, number>();
  for (const photo of photos)
    duplicateCounts.set(photo.sourceId, (duplicateCounts.get(photo.sourceId) ?? 0) + 1);
  const bySourceId = new Map(
    photos
      .filter((photo) => duplicateCounts.get(photo.sourceId) === 1)
      .map((photo) => [photo.sourceId, photo]),
  );
  const byPath = new Map(photos.map((photo) => [photo.file, photo]));

  const claimed = new Set<string>();
  return listed.map((entry): Correlation => {
    if (entry.sourceId !== null) {
      const candidate = bySourceId.get(entry.sourceId);
      if (candidate !== undefined && !claimed.has(candidate.file)) {
        claimed.add(candidate.file);
        return { match: candidate, via: 'sourceId' };
      }
    }
    const candidate = byPath.get(entry.file);
    if (candidate !== undefined) {
      claimed.add(candidate.file);
      return { match: candidate, via: 'path' };
    }
    return { match: null, via: null };
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
  photos: readonly PhotoRef[],
  defaultTag: string,
): Promise<PhotosFileResult> {
  const path = join(albumDirectory, PHOTOS_FILE);
  const source = path;

  let original: string;
  try {
    original = await readFile(path, 'utf8');
  } catch {
    await writeFileAtomic(path, renderNewFile(photos, defaultTag));
    return {
      created: true,
      added: photos.map((photo) => photo.file),
      removed: [],
      moved: [],
      missingAlt: photos.map((photo) => photo.file),
      tagsBackfilled: [],
      sourceIdBackfilled: [],
    };
  }

  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }

  const sequence = readPhotosSequence(document, source);
  const items = sequence?.items ?? [];
  const listed: ListedEntry[] = items.map((item, index) => ({
    file: entryFilename(item, source, index),
    sourceId: entrySourceId(item),
  }));

  const correlations = correlate(listed, photos);

  const removed = listed
    .filter((_, index) => correlations[index]?.match === null)
    .map((entry) => entry.file);
  const matchedTargets = new Set(
    correlations.flatMap((correlation) =>
      correlation.match !== null ? [correlation.match.file] : [],
    ),
  );
  const addedPhotos = photos.filter((photo) => !matchedTargets.has(photo.file));
  const added = addedPhotos.map((photo) => photo.file);

  // The single source of truth for what needs rewriting on an existing entry:
  // its `file` and/or `sourceId` no longer match what it was actually matched
  // to. `moved` and `sourceIdBackfilled` below are just labelled views of this
  // for reporting — a real move, and a legacy entry gaining the field it
  // never had, respectively (both can be true of the same entry at once).
  const relinked: { index: number; file: string; sourceId: string }[] = [];
  const moved: { from: string; to: string }[] = [];
  const sourceIdBackfilled: string[] = [];
  correlations.forEach((correlation, index) => {
    if (correlation.match === null) return;
    const entry = listed[index];
    if (entry === undefined) return;
    if (entry.file === correlation.match.file && entry.sourceId === correlation.match.sourceId)
      return;
    relinked.push({ index, file: correlation.match.file, sourceId: correlation.match.sourceId });
    if (correlation.via === 'sourceId' && entry.file !== correlation.match.file) {
      moved.push({ from: entry.file, to: correlation.match.file });
    }
    if (entry.sourceId === null) sourceIdBackfilled.push(correlation.match.file);
  });

  // A one-time upgrade path for photos.yaml files written before tags existed:
  // an entry with no `tags` key at all (not even an empty list) predates the
  // feature and is seeded with the batch's default tag, exactly once. An
  // entry that already has a `tags` key — even `[]` — has been spoken for,
  // by a person or a prior ingest, and is never touched again. Uses each
  // entry's *matched* current file (via `correlations`), not its pre-move
  // one, so a photo that moved and was never tagged is still found below.
  const untagged = items
    .map((item, index) => ({
      file: correlations[index]?.match?.file ?? listed[index]?.file ?? '',
      tagged: hasTagsKey(item),
      survives: correlations[index]?.match !== null,
    }))
    .filter((entry) => !entry.tagged && entry.survives)
    .map((entry) => entry.file);

  if (
    removed.length === 0 &&
    added.length === 0 &&
    untagged.length === 0 &&
    relinked.length === 0
  ) {
    const missingAlt = items
      .map((item, index) => ({ file: listed[index]?.file ?? '', ok: hasAltText(item) }))
      .filter((entry) => !entry.ok)
      .map((entry) => entry.file);
    return {
      created: false,
      added: [],
      removed: [],
      moved: [],
      missingAlt,
      tagsBackfilled: [],
      sourceIdBackfilled: [],
    };
  }

  if (document.toString({ lineWidth: 0 }) !== original) {
    throw new PipelineError(
      `${source} needs updating, but rewriting it would also reformat it, so nothing was changed.\n` +
        'Please edit it by hand:\n' +
        (added.length > 0 ? `  add:    ${added.join(', ')}\n` : '') +
        (removed.length > 0 ? `  remove: ${removed.join(', ')}\n` : '') +
        (moved.length > 0
          ? `  rename: ${moved.map((entry) => `${entry.from} -> ${entry.to}`).join(', ')}\n`
          : '') +
        (untagged.length > 0 ? `  tag with "${defaultTag}": ${untagged.join(', ')}\n` : '') +
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

  // 1. Relink matched entries first, by index, before anything is deleted —
  //    indexes still line up with `listed`/`correlations` at this point.
  for (const entry of relinked) {
    const item = target.items[entry.index];
    if (isMap(item)) {
      item.set('file', entry.file);
      item.set('sourceId', entry.sourceId);
    }
  }
  // 2. Delete removed entries, in reverse order so earlier indexes stay valid.
  for (let index = target.items.length - 1; index >= 0; index -= 1) {
    if (removed.includes(listed[index]?.file ?? '')) target.delete(index);
  }
  // 3. Append genuinely new entries.
  for (const photo of addedPhotos) {
    target.add(
      document.createNode({
        file: photo.file,
        sourceId: photo.sourceId,
        alt: '',
        tags: [defaultTag],
      }),
    );
  }
  // 4. Tags backfill, reading `file` fresh — already reflects step 1's relinking.
  for (const item of target.items) {
    if (isMap(item) && !hasTagsKey(item) && untagged.includes(item.get('file') as string)) {
      item.set('tags', document.createNode([defaultTag]));
    }
  }

  await writeFileAtomic(path, document.toString({ lineWidth: 0 }));

  const refreshed = parseDocument(await readFile(path, 'utf8'));
  const refreshedItems = readPhotosSequence(refreshed, source)?.items ?? [];
  const missingAlt = refreshedItems
    .map((item, index) => ({ file: entryFilename(item, source, index), ok: hasAltText(item) }))
    .filter((entry) => !entry.ok)
    .map((entry) => entry.file);

  return {
    created: false,
    added,
    removed,
    moved,
    missingAlt,
    tagsBackfilled: untagged,
    sourceIdBackfilled,
  };
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
  const id = item.get('id');
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
export async function syncRollsFile(
  albumDirectory: string,
  ids: readonly string[],
): Promise<RollsFileResult> {
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
  if (!isMap(item))
    throw new PipelineError(`${source}: photos[${index.toString()}] is not a mapping.`);
  item.set('alt', description.alt);
  if (description.caption !== null) item.set('caption', description.caption);

  await writeFileAtomic(path, document.toString({ lineWidth: 0 }));
}

/** Thrown by `applyPhotoEdits` when `photos.yaml` changed on disk since the caller last read it. */
export class StaleAlbumFileError extends PipelineError {
  override readonly name = 'StaleAlbumFileError';
}

export interface PhotoEdit {
  readonly file: string;
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  /** Present => replace. Absent => leave untouched. */
  readonly alt?: string;
  /** Present & string => replace. Present & null => delete the key entirely. Absent => leave untouched. */
  readonly caption?: string | null;
}

export interface ApplyPhotoEditsResult {
  /** sha256 of the file's new content — the next call's `expectedVersion`. */
  readonly version: string;
}

/**
 * Applies a batch of edits (tag add/remove, alt, caption) to one album's
 * `photos.yaml` in a single parse-mutate-write pass, for the editor UI. Unlike
 * `setPhotoDescription` — one call, one write, meant for `pnpm describe`'s
 * one-photo-at-a-time loop — this takes every edit destined for this album at
 * once, so tagging hundreds of photos costs one write, not hundreds.
 *
 * `expectedVersion` is a `sha256Hex` of the content the caller last saw
 * (returned by a previous read or write). If the file has changed since —
 * `pnpm ingest` ran, or someone hand-edited it — the hash of what's actually
 * on disk won't match, and this throws `StaleAlbumFileError` instead of
 * silently clobbering the concurrent change. Pass `null` to skip the check
 * (used by the tag-rename/delete maintenance operations, which always
 * re-read fresh immediately beforehand). This is orthogonal to, and layered
 * on top of, the existing round-trip safety net below: that one guards
 * against our own writer reformatting a file it didn't expect to; this one
 * guards against a time-of-check-to-time-of-use race, which only matters
 * once a long-lived process — the editor's browser tab — is holding state
 * across awaits, unlike the one-shot CLI commands that motivated the
 * round-trip check alone.
 */
export async function applyPhotoEdits(
  albumDirectory: string,
  edits: readonly PhotoEdit[],
  expectedVersion: string | null,
): Promise<ApplyPhotoEditsResult> {
  const path = join(albumDirectory, PHOTOS_FILE);
  const source = path;
  const original = await readFile(path, 'utf8');

  if (expectedVersion !== null && sha256Hex(original) !== expectedVersion) {
    throw new StaleAlbumFileError(
      `${source} changed on disk since it was loaded (probably \`pnpm ingest\` or a hand-edit). Reload and reapply.`,
    );
  }

  const document = parseDocument(original);
  if (document.errors.length > 0) {
    const [first] = document.errors;
    throw new PipelineError(`${source}: ${first?.message ?? 'could not be parsed as YAML'}`);
  }

  if (document.toString({ lineWidth: 0 }) !== original) {
    throw new PipelineError(
      `${source} needs updating, but rewriting it would also reformat it. Edit it by hand.`,
    );
  }

  const sequence = readPhotosSequence(document, source);
  const items = sequence?.items ?? [];

  for (const edit of edits) {
    const index = items.findIndex((item, i) => entryFilename(item, source, i) === edit.file);
    if (index === -1) {
      throw new PipelineError(`${source}: no entry for ${JSON.stringify(edit.file)}.`);
    }
    const item = items[index];
    if (!isMap(item))
      throw new PipelineError(`${source}: photos[${index.toString()}] is not a mapping.`);

    if (edit.alt !== undefined) item.set('alt', edit.alt);
    if (edit.caption !== undefined) {
      if (edit.caption === null) item.delete('caption');
      else item.set('caption', edit.caption);
    }
    if (edit.addTags !== undefined || edit.removeTags !== undefined) {
      const existing = readTags(item);
      const remove = new Set(edit.removeTags ?? []);
      const kept = existing.filter((tag) => !remove.has(tag));
      for (const tag of edit.addTags ?? []) {
        if (!kept.includes(tag)) kept.push(tag);
      }
      item.set('tags', document.createNode(kept));
    }
  }

  const rendered = document.toString({ lineWidth: 0 });
  await writeFileAtomic(path, rendered);
  return { version: sha256Hex(rendered) };
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
