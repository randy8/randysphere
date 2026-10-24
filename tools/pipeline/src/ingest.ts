import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import {
  readPhotosFile,
  scaffoldAlbumMarkdown,
  syncPhotosFile,
  syncRollsFile,
} from './album-files.ts';
import type { PhotosFileEntry } from './album-files.ts';
import { mapWithConcurrency } from './concurrency.ts';
import type { PipelineConfig } from './config.ts';
import { pathExists, writeFileAtomic } from './files.ts';
import {
  configureSharp,
  encodeLqip,
  encodeVariant,
  inspectDerivative,
  inspectSource,
  normalise,
} from './encode.ts';
import { PipelineError } from './errors.ts';
import { parseExif, selectCameraMetadata } from './exif.ts';
import type { AlbumManifest, PhotoRecord, RollRecord, VariantRecord } from './manifest.ts';
import {
  readAlbumManifest,
  SCHEMA_VERSION,
  writeAlbumManifest,
  writeRepositoryIndex,
} from './manifest.ts';
import type { Rotation } from './orientation.ts';
import { rotatedDimensions } from './orientation.ts';
import { derivativePath } from './paths.ts';
import type { Paths } from './paths.ts';
import { planOpenGraph, planVariants, SOURCE_ID_LENGTH } from './recipe.ts';
import type { VariantPlan } from './recipe.ts';
import { loadSourceHashes } from './source-hashes.ts';
import type { SourceHashes } from './source-hashes.ts';
import { flattenRolls, listAlbumSlugs, listRolls, SOURCE_EXTENSIONS } from './sources.ts';

/** A photograph located during the roll walk, before anything is decoded. */
interface SourcePhoto {
  /** Path relative to the album directory, e.g. "0827/001.tif" or "001.tif" for a root-level roll. */
  readonly relPath: string;
  readonly roll: string;
}

export interface AlbumReport {
  readonly slug: string;
  readonly photos: number;
  readonly encoded: number;
  readonly reused: number;
  readonly newIdentities: number;
  readonly photosFileCreated: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** An existing photos.yaml entry matched to its content at a new path — a real move/rename, not an add+remove. */
  readonly moved: readonly { readonly from: string; readonly to: string }[];
  readonly missingAlt: readonly string[];
  readonly tagsBackfilled: readonly string[];
  /** Entries that predated the `sourceId` field and were given one, once. */
  readonly sourceIdBackfilled: readonly string[];
  readonly albumFileCreated: boolean;
}

export interface IngestReport {
  readonly albums: readonly AlbumReport[];
  /** A batch that no longer has an originals/<slug>/ directory — its manifest and albums/<slug>/ (including hand-written captions and tags) were deleted this run. */
  readonly removedAlbums: readonly string[];
}

function toVariantRecord(
  plan: VariantPlan,
  width: number,
  height: number,
  bytes: number,
): VariantRecord {
  return { format: plan.format, width, height, bytes, key: plan.key };
}

/**
 * The previous record's variants for exactly these plans, in plan order, or
 * null if it doesn't cover every one of them. A record carrying *extra*
 * variants (a format or width since dropped from the recipe) still counts:
 * the extras are simply left out, so trimming the recipe rewrites manifests
 * without decoding a single original.
 */
export function reusableVariants(
  record: PhotoRecord,
  sourceId: string,
  plans: readonly VariantPlan[],
  ogKey: string,
): VariantRecord[] | null {
  if (record.sourceId !== sourceId) return null;
  if (record.og.key !== ogKey) return null;
  const byKey = new Map(record.variants.map((variant) => [variant.key, variant]));
  const variants = plans.map((plan) => byKey.get(plan.key));
  return variants.every((variant) => variant !== undefined) ? variants : null;
}

interface PhotoOutcome {
  readonly record: PhotoRecord;
  readonly encoded: number;
  readonly reused: boolean;
  readonly newIdentity: boolean;
}

/** The previous manifest, indexed two ways so a moved-but-unchanged photo can still be found. */
export interface PreviousRecords {
  readonly byPath: ReadonlyMap<string, PhotoRecord>;
  readonly bySourceId: ReadonlyMap<string, PhotoRecord>;
}

/**
 * Path first, `sourceId` as fallback. Path first is what makes a same-path
 * re-export keep behaving exactly as it always has (a new `sourceId` at an
 * unchanged path is still `newIdentity`, per "the source digest covers file
 * bytes, not pixels" — this function isn't what decides that, it just
 * shouldn't accidentally undo it). The `sourceId` fallback is what's new: a
 * file moved to a different path (a different roll, or flattened out of one
 * entirely) has unchanged bytes, so its previous record is still found, its
 * derivatives are recognised as already on disk, and it never gets flagged as
 * a new identity just because it moved.
 */
export function resolvePriorRecord(
  previous: PreviousRecords,
  relPath: string,
  sourceId: string,
): PhotoRecord | undefined {
  return previous.byPath.get(relPath) ?? previous.bySourceId.get(sourceId);
}

/**
 * Each photo's `rotate:` from photos.yaml, read before encoding because it
 * changes the derivatives' bytes. Looked up the same way photos.yaml entries
 * are matched to photos — content first, path second — so a turn survives
 * a move, and a same-path re-export keeps it too.
 */
export interface Rotations {
  readonly bySourceId: ReadonlyMap<string, Rotation>;
  readonly byPath: ReadonlyMap<string, Rotation>;
}

export function rotationsFrom(entries: readonly PhotosFileEntry[]): Rotations {
  return {
    bySourceId: new Map(
      entries.flatMap((entry) =>
        entry.sourceId === null ? [] : [[entry.sourceId, entry.rotate] as const],
      ),
    ),
    byPath: new Map(entries.map((entry) => [entry.file, entry.rotate])),
  };
}

export function resolveRotation(rotations: Rotations, relPath: string, sourceId: string): Rotation {
  return rotations.bySourceId.get(sourceId) ?? rotations.byPath.get(relPath) ?? 0;
}

async function ingestPhoto(
  paths: Paths,
  config: PipelineConfig,
  albumDirectory: string,
  photo: SourcePhoto,
  previous: PreviousRecords,
  rotations: Rotations,
  hashes: SourceHashes,
): Promise<PhotoOutcome> {
  const sourcePath = join(albumDirectory, photo.relPath);
  const sourceId = (await hashes.hash(sourcePath)).slice(0, SOURCE_ID_LENGTH);
  const priorRecord = resolvePriorRecord(previous, photo.relPath, sourceId);
  const rotate = resolveRotation(rotations, photo.relPath, sourceId);
  const inspection = await inspectSource(sourcePath);
  const displayed = rotatedDimensions(inspection.displayed, rotate);
  const { exif } = inspection;

  const plans = planVariants(sourceId, displayed, config, rotate);
  const openGraph = planOpenGraph(sourceId, config, rotate);
  const everyPlan = [...plans, openGraph];

  const missing: VariantPlan[] = [];
  for (const plan of everyPlan) {
    if (!(await pathExists(derivativePath(paths, plan.key)))) missing.push(plan);
  }

  const newIdentity = priorRecord !== undefined && priorRecord.sourceId !== sourceId;

  // Nothing to encode and the previous record still describes exactly these
  // derivatives, so the photograph never has to be decoded at all. This is the
  // path a rerun over an unchanged collection takes for every single file,
  // and — since `priorRecord` is found by content as well as path — the path
  // a moved-but-unchanged photograph takes too.
  const reusable =
    missing.length === 0 && priorRecord !== undefined
      ? reusableVariants(priorRecord, sourceId, plans, openGraph.key)
      : null;
  if (priorRecord !== undefined && reusable !== null) {
    return {
      record: { ...priorRecord, file: photo.relPath, roll: photo.roll, variants: reusable },
      encoded: 0,
      reused: true,
      newIdentity: false,
    };
  }

  const widest = plans.reduce((maximum, plan) => Math.max(maximum, plan.width), 0);
  const base = await normalise(sourcePath, config, Math.max(widest, config.og.width), rotate);

  const encodedByKey = new Map<string, { width: number; height: number; bytes: number }>();
  for (const plan of missing) {
    const encoded = await encodeVariant(base, plan, config);
    await writeFileAtomic(derivativePath(paths, plan.key), encoded.data);
    encodedByKey.set(plan.key, encoded);
  }

  // A variant that already existed on disk still needs its dimensions and size
  // in the manifest. Reading them back is cheaper than re-encoding, and keeps
  // the manifest describing the bytes that are actually there.
  const variants: VariantRecord[] = [];
  for (const plan of plans) {
    const encoded = encodedByKey.get(plan.key);
    if (encoded !== undefined) {
      variants.push(toVariantRecord(plan, encoded.width, encoded.height, encoded.bytes));
      continue;
    }
    const recorded = priorRecord?.variants.find((variant) => variant.key === plan.key);
    if (recorded !== undefined) {
      variants.push(recorded);
      continue;
    }
    // On disk already, but not from a decode we just did and not in the
    // previous manifest either — plan.width/height is the encode's bounding
    // box, not the real output size (a portrait's real width differs from a
    // square box's side), so read the actual file rather than guess.
    const path = derivativePath(paths, plan.key);
    const [dimensions, bytes] = await Promise.all([
      inspectDerivative(path),
      readFile(path).then((buffer) => buffer.byteLength),
    ]);
    variants.push(toVariantRecord(plan, dimensions.width, dimensions.height, bytes));
  }

  const ogEncoded = encodedByKey.get(openGraph.key);
  const og =
    ogEncoded !== undefined
      ? toVariantRecord(openGraph, ogEncoded.width, ogEncoded.height, ogEncoded.bytes)
      : priorRecord?.og.key === openGraph.key
        ? priorRecord.og
        : toVariantRecord(
            openGraph,
            openGraph.width,
            openGraph.height,
            (await readFile(derivativePath(paths, openGraph.key))).byteLength,
          );

  const record: PhotoRecord = {
    file: photo.relPath,
    roll: photo.roll,
    sourceId,
    width: displayed.width,
    height: displayed.height,
    color: base.color,
    lqip: await encodeLqip(base, config),
    camera: config.cameraMetadata ? selectCameraMetadata(parseExif(exif)) : null,
    variants,
    og,
  };

  return { record, encoded: missing.length, reused: false, newIdentity };
}

export async function readPreviousRecords(manifestPath: string): Promise<PreviousRecords> {
  const empty: PreviousRecords = { byPath: new Map(), bySourceId: new Map() };
  if (!(await pathExists(manifestPath))) return empty;
  try {
    const manifest = await readAlbumManifest(manifestPath);
    return {
      byPath: new Map(manifest.photos.map((photo) => [photo.file, photo])),
      // A `sourceId` shared by two previous records (byte-identical content at
      // two paths) collapses to "last one wins" here — harmless, since
      // derivatives are content-addressed by `sourceId`, so either duplicate's
      // record describes the same already-on-disk derivatives correctly.
      bySourceId: new Map(manifest.photos.map((photo) => [photo.sourceId, photo])),
    };
  } catch {
    // An unreadable manifest is not a reason to refuse to rebuild one. It is
    // regenerated from originals/ in full, which is the whole point of keeping
    // originals/ authoritative.
    return empty;
  }
}

/**
 * A batch's manifest and `albums/<slug>/` are only ever written while
 * `originals/<slug>/` exists (see `ingest`'s main loop) — so any manifest
 * file left in `paths.manifests` for a slug outside `currentSlugs` names a
 * batch that has since been renamed or deleted from `originals/`. Its
 * content lives on under whatever slug it moved to (matched by `sourceId`,
 * see `resolvePriorRecord`), or is genuinely gone — either way, nothing
 * currently reads this manifest or album directory, so both are deleted.
 */
export async function removeOrphanAlbums(
  paths: Paths,
  currentSlugs: readonly string[],
): Promise<readonly string[]> {
  const manifestFiles = await readdir(paths.manifests).catch(() => []);
  const orphanSlugs = manifestFiles
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((slug) => !currentSlugs.includes(slug));

  for (const slug of orphanSlugs) {
    await rm(join(paths.manifests, `${slug}.json`), { force: true });
    await rm(join(paths.albums, slug), { recursive: true, force: true });
  }

  return orphanSlugs;
}

export interface IngestProgress {
  readonly slug: string;
  /** 1-based position of this album among the ones being ingested this run. */
  readonly album: number;
  readonly albums: number;
  readonly completed: number;
  readonly total: number;
  /** True if the photograph just finished needed nothing encoded. */
  readonly reused: boolean;
}

export interface IngestOptions {
  readonly paths: Paths;
  readonly config: PipelineConfig;
  readonly onlyAlbums: readonly string[] | null;
  readonly concurrency: number;
  /** Called after each photograph in an album finishes, whether encoded or reused. */
  readonly onProgress?: (event: IngestProgress) => void;
}

export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const { paths, config, onlyAlbums, concurrency, onProgress } = options;
  configureSharp();

  const allSlugs = await listAlbumSlugs(paths.originals);
  if (onlyAlbums !== null) {
    for (const slug of onlyAlbums) {
      if (!allSlugs.includes(slug)) {
        throw new PipelineError(
          `No album called "${slug}" in ${paths.originals}. Found: ${allSlugs.join(', ') || 'nothing'}.`,
        );
      }
    }
  }
  const slugs =
    onlyAlbums === null ? allSlugs : allSlugs.filter((slug) => onlyAlbums.includes(slug));

  await mkdir(paths.manifests, { recursive: true });
  const hashes = await loadSourceHashes(paths.sourceHashesFile);
  const reports: AlbumReport[] = [];

  for (const [albumIndex, slug] of slugs.entries()) {
    const albumOriginals = join(paths.originals, slug);
    const rolls = await listRolls(albumOriginals);
    const photos = flattenRolls(rolls);
    if (photos.length === 0) {
      throw new PipelineError(
        `${albumOriginals} has no photographs in it. Add some, or remove the directory.\n` +
          `Recognised extensions: ${SOURCE_EXTENSIONS.join(', ')}.`,
      );
    }

    const manifestPath = join(paths.manifests, `${slug}.json`);
    const previous = await readPreviousRecords(manifestPath);
    const albumDirectory = join(paths.albums, slug);
    const rotations = rotationsFrom(await readPhotosFile(albumDirectory));

    let completed = 0;
    const outcomes = await mapWithConcurrency(photos, concurrency, async (photo) => {
      const outcome = await ingestPhoto(
        paths,
        config,
        albumOriginals,
        photo,
        previous,
        rotations,
        hashes,
      );
      completed += 1;
      onProgress?.({
        slug,
        album: albumIndex + 1,
        albums: slugs.length,
        completed,
        total: photos.length,
        reused: outcome.reused,
      });
      return outcome;
    });

    const rollRecords: RollRecord[] = rolls.map((roll) => ({
      id: roll.id,
      photoCount: roll.files.length,
    }));
    const manifest: AlbumManifest = {
      schemaVersion: SCHEMA_VERSION,
      slug,
      photos: outcomes.map((outcome) => outcome.record),
      rolls: rollRecords,
    };
    await writeAlbumManifest(manifestPath, manifest);

    await mkdir(albumDirectory, { recursive: true });
    const files = photos.map((photo) => photo.relPath);
    const photoRefs = outcomes.map((outcome) => ({
      file: outcome.record.file,
      sourceId: outcome.record.sourceId,
    }));
    const photosFile = await syncPhotosFile(albumDirectory, photoRefs, slug);
    await syncRollsFile(
      albumDirectory,
      rolls.map((roll) => roll.id),
    );
    const earliest = outcomes
      .map((outcome) => outcome.record.camera?.takenAt ?? null)
      .filter((value): value is string => value !== null)
      .sort()[0];
    const albumFileCreated = await scaffoldAlbumMarkdown(
      albumDirectory,
      slug,
      earliest ?? null,
      files[0] ?? '',
    );

    reports.push({
      slug,
      photos: files.length,
      encoded: outcomes.reduce((total, outcome) => total + outcome.encoded, 0),
      reused: outcomes.filter((outcome) => outcome.reused).length,
      newIdentities: outcomes.filter((outcome) => outcome.newIdentity).length,
      photosFileCreated: photosFile.created,
      added: photosFile.added,
      removed: photosFile.removed,
      moved: photosFile.moved,
      missingAlt: photosFile.missingAlt,
      tagsBackfilled: photosFile.tagsBackfilled,
      sourceIdBackfilled: photosFile.sourceIdBackfilled,
      albumFileCreated,
    });
  }

  await hashes.save();

  await writeRepositoryIndex(paths.indexFile, {
    schemaVersion: SCHEMA_VERSION,
    recipe: config,
    albums: allSlugs,
  });

  const removedAlbums = await removeOrphanAlbums(paths, allSlugs);

  return { albums: reports, removedAlbums };
}

export function defaultConcurrency(): number {
  // Every core. sharp's own thread pool is pinned to 1 (configureSharp), so
  // this is the only parallelism there is — and at half the cores, measured
  // on a 12-core machine, ingest sat at a load of ~4 with most of the CPU
  // idle. Memory is not the limit: a photograph in flight is ~300 MB at
  // worst (a 75 MB TIFF plus a 2560px raw buffer), well under 4 GB at 12.
  return Math.max(1, availableParallelism());
}
