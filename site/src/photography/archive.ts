import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import type { AlbumManifest, Photo } from './manifest.ts';
import { readManifest } from './manifest.ts';

/**
 * The canonical archive is a single flat list of photographs. A "trip" like
 * `paris-2025` is not a structural concept here — it is a tag, exactly like a
 * place or a subject would be. Pages are query results over this one list,
 * never a second copy of it: a photo tagged twice appears in two views but
 * exists once, as the same object.
 */
export interface ArchiveRoll {
  /** Path from its batch's originals directory to this roll. Matches `Photo.roll`. */
  readonly id: string;
  readonly photoCount: number;
  readonly filmStock: string;
  readonly notes: string;
  /** Earliest EXIF capture date among the roll's photos (YYYY-MM-DD), or null if none carry one. */
  readonly date: string | null;
}

export interface ArchivePhoto {
  readonly photo: Photo;
  /**
   * Which `originals/<batch>/` this photograph was scanned from. Internal
   * provenance only — a filesystem detail of how the archive was ingested,
   * not a public concept. Nothing renders this; use `tags` instead.
   */
  readonly batch: string;
  readonly roll: ArchiveRoll;
  /** 1-based position within its roll, derived from the manifest's already-deterministic order. */
  readonly frame: number;
  readonly tags: readonly string[];
  readonly alt: string;
  readonly caption: string | null;
  /**
   * Hand-picked for Selected Work, from photos.yaml — a photographer's
   * editorial choice, per photo, not derived. See `selectedWork()`.
   */
  readonly featured: boolean;
  /** Manual sequence position within Selected Work; null if unset. See `selectedWork()`. */
  readonly featuredOrder: number | null;
  /**
   * True if this is the photo album.md's `cover:` field names for this
   * batch — presentation order, not archival order. `coverPhoto()` prefers
   * it; the archive's own chronological order (`frame`, `byRollAndFrame`)
   * is untouched either way. See docs/decisions.md, "presentation order is
   * independent from archival order."
   */
  readonly cover: boolean;
}

export interface Archive {
  readonly photos: readonly ArchivePhoto[];
}

/**
 * Walks up from the working directory looking for the workspace marker.
 *
 * Astro is normally started with the site package as its working directory,
 * but it can also be run from the repository root or from an editor task, and
 * `import.meta.url` is not dependable here because these modules are bundled
 * into dist/ during a build.
 */
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
const MANIFEST_DIRECTORY = join(ROOT, 'generated', 'albums');
const ALBUM_DIRECTORY = join(ROOT, 'albums');

interface PhotoEntry {
  readonly file?: string;
  readonly alt?: string;
  readonly caption?: string;
  readonly tags?: string[];
  /** Hand-picked for Selected Work — a photographer's editorial choice, per photo, not derived. */
  readonly featured?: boolean;
  /** Manual sequence position within Selected Work; lower sorts first. Photos without one sort after those with one, by archival order. */
  readonly featuredOrder?: number;
}

function readCaptions(path: string): PhotoEntry[] {
  if (!existsSync(path)) return [];
  const data = (parse(readFileSync(path, 'utf8')) ?? {}) as { photos?: PhotoEntry[] };
  return data.photos ?? [];
}

interface RollEntry {
  readonly id?: string;
  readonly filmStock?: string;
  readonly notes?: string;
}

function readRollNotes(path: string): RollEntry[] {
  if (!existsSync(path)) return [];
  const data = (parse(readFileSync(path, 'utf8')) ?? {}) as { rolls?: RollEntry[] };
  return data.rolls ?? [];
}

/**
 * The manifest decides which rolls exist and in what order, and derives each
 * one's frame count; rolls.yaml decides what is said about them (film stock,
 * notes). A roll listed in rolls.yaml but absent from the manifest is a real
 * inconsistency and stops the build, the same way a stale photos.yaml entry
 * does. A roll's date is not stored anywhere — it is the earliest EXIF capture
 * time among its own photographs, computed here rather than by the pipeline,
 * since it is derived data rather than anything a photographer writes.
 */
export function joinRolls(
  manifest: AlbumManifest,
  entries: readonly RollEntry[],
  batch: string,
): ArchiveRoll[] {
  const notesById = new Map(
    entries
      .filter((entry): entry is RollEntry & { id: string } => entry.id !== undefined)
      .map((entry) => [entry.id, entry]),
  );

  const earliestByRoll = new Map<string, string>();
  for (const photo of manifest.photos) {
    const takenAt = photo.camera?.takenAt;
    if (takenAt === null || takenAt === undefined) continue;
    const current = earliestByRoll.get(photo.roll);
    if (current === undefined || takenAt < current) earliestByRoll.set(photo.roll, takenAt);
  }

  const rolls = manifest.rolls.map((roll) => {
    const entry = notesById.get(roll.id);
    notesById.delete(roll.id);
    const takenAt = earliestByRoll.get(roll.id);
    return {
      id: roll.id,
      photoCount: roll.photoCount,
      filmStock: entry?.filmStock?.trim() ?? '',
      notes: entry?.notes?.trim() ?? '',
      date: takenAt !== undefined ? takenAt.slice(0, 10) : null,
    };
  });

  const [orphan] = notesById.keys();
  if (orphan !== undefined) {
    throw new Error(
      `albums/${batch}/rolls.yaml lists roll "${orphan}", which is not in the manifest. Run \`pnpm ingest\`.`,
    );
  }

  return rolls;
}

/**
 * The manifest decides which photographs exist, in the deterministic order
 * ingest found them (roll, then filename); photos.yaml decides the display
 * order and what is said about each one, including tags. A photograph listed
 * in captions but absent from the manifest is a real inconsistency and stops
 * the build.
 */
export function joinBatch(
  manifest: AlbumManifest,
  entries: readonly PhotoEntry[],
  rolls: readonly ArchiveRoll[],
  batch: string,
  coverFile: string | null,
): ArchivePhoto[] {
  const rollsById = new Map(rolls.map((roll) => [roll.id, roll]));

  // Frame is not stored anywhere — it is the 1-based position of a photo
  // within its own roll, taken directly from the manifest's already-sorted
  // order (rolls by id, files by name within each), which is exactly the
  // order `pnpm ingest` guarantees is deterministic.
  const frameByFile = new Map<string, number>();
  const seenPerRoll = new Map<string, number>();
  for (const photo of manifest.photos) {
    const frame = (seenPerRoll.get(photo.roll) ?? 0) + 1;
    seenPerRoll.set(photo.roll, frame);
    frameByFile.set(photo.file, frame);
  }

  function toArchivePhoto(
    photo: Photo,
    alt: string,
    caption: string | null,
    tags: readonly string[],
    featured: boolean,
    featuredOrder: number | null,
  ): ArchivePhoto {
    const roll = rollsById.get(photo.roll);
    if (roll === undefined) {
      throw new Error(
        `${batch}: ${photo.file} belongs to roll "${photo.roll}", which is not in the manifest's rolls list.`,
      );
    }
    const frame = frameByFile.get(photo.file);
    if (frame === undefined) throw new Error(`${batch}: ${photo.file} has no frame position.`);
    return {
      photo,
      batch,
      roll,
      frame,
      tags,
      alt,
      caption,
      featured,
      featuredOrder,
      cover: photo.file === coverFile,
    };
  }

  const byFile = new Map(manifest.photos.map((photo) => [photo.file, photo]));
  const ordered: ArchivePhoto[] = [];

  for (const entry of entries) {
    if (entry.file === undefined) continue;
    const photo = byFile.get(entry.file);
    if (photo === undefined) {
      throw new Error(
        `albums/${batch}/photos.yaml lists ${entry.file}, which is not in the manifest. Run \`pnpm ingest\`.`,
      );
    }
    byFile.delete(entry.file);
    ordered.push(
      toArchivePhoto(
        photo,
        entry.alt?.trim() ?? '',
        entry.caption?.trim() ? entry.caption.trim() : null,
        entry.tags ?? [],
        entry.featured === true,
        typeof entry.featuredOrder === 'number' ? entry.featuredOrder : null,
      ),
    );
  }

  // Anything ingested but not yet listed still appears, at the end, rather
  // than silently vanishing from the archive.
  for (const photo of byFile.values()) {
    ordered.push(toArchivePhoto(photo, '', null, [], false, null));
  }
  return ordered;
}

/**
 * `album.md`'s frontmatter, YAML between the opening and closing `---`
 * lines. A hand-set editorial choice, not derived — `pnpm ingest` only ever
 * scaffolds this file once (with `cover` defaulted to whatever photo was
 * first at scaffold time) and never touches it again (see docs/decisions.md).
 * `cover` is presentation order, deliberately independent of the archive's
 * chronological order: a stale or malformed value (renamed file, typo) just
 * falls back to `coverPhoto`'s chronological default rather than failing the
 * build — unlike photos.yaml/rolls.yaml, album.md is never validated against
 * the manifest.
 */
function readAlbumCover(path: string): string | null {
  if (!existsSync(path)) return null;
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'));
  if (match?.[1] === undefined) return null;
  const data = (parse(match[1]) ?? {}) as { cover?: string };
  return typeof data.cover === 'string' && data.cover.length > 0 ? data.cover : null;
}

function loadBatch(slug: string): ArchivePhoto[] {
  const manifestPath = join(MANIFEST_DIRECTORY, `${slug}.json`);
  const manifest = readManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  const captions = readCaptions(join(ALBUM_DIRECTORY, slug, 'photos.yaml'));
  const rollNotes = readRollNotes(join(ALBUM_DIRECTORY, slug, 'rolls.yaml'));
  const cover = readAlbumCover(join(ALBUM_DIRECTORY, slug, 'album.md'));
  const rolls = joinRolls(manifest, rollNotes, slug);
  return joinBatch(manifest, captions, rolls, slug, cover);
}

/** Reads every batch's manifest and merges them into one canonical, flat archive. */
export function loadArchive(): Archive {
  if (!existsSync(MANIFEST_DIRECTORY)) {
    throw new Error(
      `${MANIFEST_DIRECTORY} does not exist, so there is nothing to show.\n` +
        'Put photographs in originals/<batch>/ and run `pnpm ingest`.',
    );
  }
  const slugs = readdirSync(MANIFEST_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

  if (slugs.length === 0) {
    throw new Error(
      `No manifests in ${MANIFEST_DIRECTORY}.\nPut photographs in originals/<batch>/ and run \`pnpm ingest\`.`,
    );
  }
  return { photos: slugs.flatMap(loadBatch) };
}

function byRollAndFrame(a: ArchivePhoto, b: ArchivePhoto): number {
  if (a.roll.id !== b.roll.id) return a.roll.id.localeCompare(b.roll.id);
  return a.frame - b.frame;
}

/** Every view — a trip, a place, a subject — is this same query, just with a different predicate. Nothing about a tag is special-cased. */
export function query(
  archive: Archive,
  predicate: (photo: ArchivePhoto) => boolean,
): ArchivePhoto[] {
  return archive.photos.filter(predicate).sort(byRollAndFrame);
}

export function byTag(archive: Archive, tag: string): ArchivePhoto[] {
  return query(archive, (photo) => photo.tags.includes(tag));
}

/** Every tag any photograph carries, including trip tags like "paris-2025" — there is no separate list of "known trips". */
export function allTags(archive: Archive): string[] {
  return [...new Set(archive.photos.flatMap((photo) => photo.tags))].sort();
}

/**
 * Film stock is roll-level data (rolls.yaml), not a tag — physically, a roll
 * is loaded with one stock at a time. `byFilmStock` queries it the same way
 * `byTag` queries tags: same `query()`, a different predicate.
 */
export function byFilmStock(archive: Archive, filmStock: string): ArchivePhoto[] {
  return query(archive, (photo) => photo.roll.filmStock === filmStock);
}

/** Every distinct film stock actually in use — rolls with no filmStock noted yet are excluded, not shown as "". */
export function allFilmStocks(archive: Archive): string[] {
  return [
    ...new Set(
      archive.photos.map((photo) => photo.roll.filmStock).filter((stock) => stock.length > 0),
    ),
  ].sort();
}

/**
 * A tag like `paris-2025` is already a name and is humanised as one. A tag
 * that's still a raw batch id (`0827`, all digits — see CLAUDE.md's known
 * limitations) isn't a name yet, so it's labelled honestly as what it
 * actually is — a roll — rather than presented bare, as if "0827" were a
 * considered title.
 */
function titleFromTag(tag: string): string {
  if (/^\d+$/.test(tag)) return `Roll ${tag}`;
  return tag
    .split('-')
    .map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

export interface View {
  readonly tag: string;
  readonly title: string;
  /** Earliest EXIF capture date across the view's photos, or null if none carry one. There is no authored title/description yet — see docs/decisions.md. */
  readonly date: string | null;
  readonly photos: readonly ArchivePhoto[];
  /** The roll every photo in the view shares, or null if the view spans more than one — a view isn't always one roll, so this is never assumed. */
  readonly roll: ArchiveRoll | null;
}

function buildView(key: string, title: string, photos: readonly ArchivePhoto[]): View {
  const dates = photos
    .map((photo) => photo.photo.camera?.takenAt)
    .filter((value): value is string => value !== null && value !== undefined)
    .sort();
  const [firstRoll] = photos;
  const roll =
    firstRoll !== undefined && photos.every((photo) => photo.roll.id === firstRoll.roll.id)
      ? firstRoll.roll
      : null;
  return { tag: key, title, date: dates[0]?.slice(0, 10) ?? null, photos, roll };
}

/** A trip page is `viewForTag(archive, "paris-2025")` — the exact same function a place or subject page would call. */
export function viewForTag(archive: Archive, tag: string): View {
  const photos = byTag(archive, tag);
  if (photos.length === 0) throw new Error(`No photographs are tagged "${tag}".`);
  return buildView(tag, titleFromTag(tag), photos);
}

/** A film stock page is the same query and the same View shape as a tag page — see byFilmStock. */
export function viewForFilmStock(archive: Archive, filmStock: string): View {
  const photos = byFilmStock(archive, filmStock);
  if (photos.length === 0) throw new Error(`No photographs are shot on "${filmStock}".`);
  return buildView(filmStock, filmStock, photos);
}

/**
 * Selected Work: a hand-picked, hand-ordered sequence across the whole
 * archive — deliberately not chronological. A photo is included by
 * `photos.yaml`'s per-photo `featured: true`; its position comes from
 * `featuredOrder` (lower first). A photo with `featured: true` but no
 * `featuredOrder` set yet still appears, after every ordered one, in the
 * archive's own chronological order — so marking a photo Selected Work is
 * never blocked on also deciding exactly where it goes.
 */
export function selectedWork(archive: Archive): ArchivePhoto[] {
  return archive.photos
    .filter((photo) => photo.featured)
    .sort((a, b) => {
      if (a.featuredOrder !== null && b.featuredOrder !== null) {
        return a.featuredOrder - b.featuredOrder || byRollAndFrame(a, b);
      }
      if (a.featuredOrder !== null) return -1;
      if (b.featuredOrder !== null) return 1;
      return byRollAndFrame(a, b);
    });
}

/**
 * Presentation order, not archival order: a manually chosen cover
 * (album.md's `cover:`) wins if the view includes one, falling back to the
 * chronologically first photo otherwise. `photos` is expected pre-sorted
 * chronologically (`byRollAndFrame`) — this never reorders it.
 */
export function coverPhoto(photos: readonly ArchivePhoto[]): ArchivePhoto {
  const first = photos[0];
  if (first === undefined) throw new Error('This view has no photographs.');
  return photos.find((photo) => photo.cover) ?? first;
}
