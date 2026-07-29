import { mkdir, readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { scaffoldAlbumMarkdown, syncPhotosFile, syncRollsFile } from './album-files.ts';
import { mapWithConcurrency } from './concurrency.ts';
import type { PipelineConfig } from './config.ts';
import { pathExists, writeFileAtomic } from './files.ts';
import { configureSharp, encodeLqip, encodeVariant, inspectSource, normalise } from './encode.ts';
import { PipelineError } from './errors.ts';
import { parseExif, selectCameraMetadata } from './exif.ts';
import { sha256File } from './hash.ts';
import type { AlbumManifest, PhotoRecord, RollRecord, VariantRecord } from './manifest.ts';
import {
  readAlbumManifest,
  SCHEMA_VERSION,
  writeAlbumManifest,
  writeRepositoryIndex,
} from './manifest.ts';
import { derivativePath } from './paths.ts';
import type { Paths } from './paths.ts';
import { planOpenGraph, planVariants, SOURCE_ID_LENGTH } from './recipe.ts';
import type { VariantPlan } from './recipe.ts';
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
  readonly missingAlt: readonly string[];
  readonly albumFileCreated: boolean;
}

export interface IngestReport {
  readonly albums: readonly AlbumReport[];
  readonly orphanManifests: readonly string[];
}

function toVariantRecord(plan: VariantPlan, width: number, height: number, bytes: number): VariantRecord {
  return { format: plan.format, width, height, bytes, key: plan.key };
}

function recordMatchesPlan(record: PhotoRecord, sourceId: string, plans: readonly VariantPlan[], ogKey: string): boolean {
  if (record.sourceId !== sourceId) return false;
  if (record.og.key !== ogKey) return false;
  if (record.variants.length !== plans.length) return false;
  const recorded = new Set(record.variants.map((variant) => variant.key));
  return plans.every((plan) => recorded.has(plan.key));
}

interface PhotoOutcome {
  readonly record: PhotoRecord;
  readonly encoded: number;
  readonly reused: boolean;
  readonly newIdentity: boolean;
}

async function ingestPhoto(
  paths: Paths,
  config: PipelineConfig,
  albumDirectory: string,
  photo: SourcePhoto,
  previous: PhotoRecord | undefined,
): Promise<PhotoOutcome> {
  const sourcePath = join(albumDirectory, photo.relPath);
  const sourceId = (await sha256File(sourcePath)).slice(0, SOURCE_ID_LENGTH);
  const { displayed, exif } = await inspectSource(sourcePath);

  const plans = planVariants(sourceId, displayed, config);
  const openGraph = planOpenGraph(sourceId, config);
  const everyPlan = [...plans, openGraph];

  const missing: VariantPlan[] = [];
  for (const plan of everyPlan) {
    if (!(await pathExists(derivativePath(paths, plan.key)))) missing.push(plan);
  }

  const newIdentity = previous !== undefined && previous.sourceId !== sourceId;

  // Nothing to encode and the previous record still describes exactly these
  // derivatives, so the photograph never has to be decoded at all. This is the
  // path a rerun over an unchanged collection takes for every single file.
  if (missing.length === 0 && previous !== undefined && recordMatchesPlan(previous, sourceId, plans, openGraph.key)) {
    return { record: previous, encoded: 0, reused: true, newIdentity: false };
  }

  const widest = plans.reduce((maximum, plan) => Math.max(maximum, plan.width), 0);
  const base = await normalise(sourcePath, config, Math.max(widest, config.og.width));

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
    const recorded = previous?.variants.find((variant) => variant.key === plan.key);
    if (recorded !== undefined) {
      variants.push(recorded);
      continue;
    }
    const bytes = (await readFile(derivativePath(paths, plan.key))).byteLength;
    variants.push(toVariantRecord(plan, plan.width, plan.height, bytes));
  }

  const ogEncoded = encodedByKey.get(openGraph.key);
  const og =
    ogEncoded !== undefined
      ? toVariantRecord(openGraph, ogEncoded.width, ogEncoded.height, ogEncoded.bytes)
      : (previous?.og.key === openGraph.key
          ? previous.og
          : toVariantRecord(
              openGraph,
              openGraph.width,
              openGraph.height,
              (await readFile(derivativePath(paths, openGraph.key))).byteLength,
            ));

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

async function readPreviousRecords(manifestPath: string): Promise<Map<string, PhotoRecord>> {
  if (!(await pathExists(manifestPath))) return new Map();
  try {
    const manifest = await readAlbumManifest(manifestPath);
    return new Map(manifest.photos.map((photo) => [photo.file, photo]));
  } catch {
    // An unreadable manifest is not a reason to refuse to rebuild one. It is
    // regenerated from originals/ in full, which is the whole point of keeping
    // originals/ authoritative.
    return new Map();
  }
}

export interface IngestOptions {
  readonly paths: Paths;
  readonly config: PipelineConfig;
  readonly onlyAlbums: readonly string[] | null;
  readonly concurrency: number;
}

export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const { paths, config, onlyAlbums, concurrency } = options;
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
  const slugs = onlyAlbums === null ? allSlugs : allSlugs.filter((slug) => onlyAlbums.includes(slug));

  await mkdir(paths.manifests, { recursive: true });
  const reports: AlbumReport[] = [];

  for (const slug of slugs) {
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

    const outcomes = await mapWithConcurrency(photos, concurrency, (photo) =>
      ingestPhoto(paths, config, albumOriginals, photo, previous.get(photo.relPath)),
    );

    const rollRecords: RollRecord[] = rolls.map((roll) => ({ id: roll.id, photoCount: roll.files.length }));
    const manifest: AlbumManifest = {
      schemaVersion: SCHEMA_VERSION,
      slug,
      photos: outcomes.map((outcome) => outcome.record),
      rolls: rollRecords,
    };
    await writeAlbumManifest(manifestPath, manifest);

    const albumDirectory = join(paths.albums, slug);
    await mkdir(albumDirectory, { recursive: true });
    const files = photos.map((photo) => photo.relPath);
    const photosFile = await syncPhotosFile(albumDirectory, files);
    await syncRollsFile(albumDirectory, rolls.map((roll) => roll.id));
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
      missingAlt: photosFile.missingAlt,
      albumFileCreated,
    });
  }

  await writeRepositoryIndex(paths.indexFile, {
    schemaVersion: SCHEMA_VERSION,
    recipe: config,
    albums: allSlugs,
  });

  const manifestFiles = await readdir(paths.manifests).catch(() => []);
  const orphanManifests = manifestFiles
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((slug) => !allSlugs.includes(slug));

  return { albums: reports, orphanManifests };
}

export function defaultConcurrency(): number {
  // Half the cores: libvips holds a decoded frame per photograph in flight, and
  // a 2400 x 3600 raw buffer is 26 MB. Saturating every core on a large machine
  // buys little and can cost a lot of memory.
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

