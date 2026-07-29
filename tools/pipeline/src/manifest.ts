import { readFile } from 'node:fs/promises';

import { formatJson, writeFileAtomic } from './files.ts';
import { PipelineError } from './errors.ts';
import type { CameraMetadata } from './camera-metadata.ts';
import { digestOfSet } from './hash.ts';
import { isDerivativeKey } from './recipe.ts';
import type { VariantFormat } from './recipe.ts';

/**
 * Bump when the shape of a generated file changes incompatibly. Readers reject
 * anything they do not recognise rather than guessing, and the pipeline that
 * wrote a file is always the one that can rewrite it: `pnpm ingest` regenerates
 * every manifest from the originals, so there is no migration to run.
 *
 * 2: `file` became a path relative to the album directory instead of a bare
 * filename (needed once an album can hold more than one roll, since filenames
 * are only unique within a roll), and every photo gained a `roll` field.
 */
export const SCHEMA_VERSION = 2;

export interface VariantRecord {
  readonly format: VariantFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /**
   * The object key, stored rather than derived. The website concatenates a base
   * URL and this string and constructs nothing. That is what lets the key
   * scheme change without invalidating manifests written by older pipelines.
   */
  readonly key: string;
}

export interface PhotoRecord {
  /**
   * Path to the photograph relative to the album's originals directory,
   * forward-slash separated (e.g. "0827/001.tif", or "001.tif" for a roll that
   * sits directly in the album directory). The join key with `photos.yaml`.
   * A bare filename is not unique across rolls, which is why this is a path
   * rather than just `file` split from `roll`.
   */
  readonly file: string;
  /** The roll this photograph belongs to — `file`'s directory part, `.` for the album root. Matches a `RollRecord.id`. */
  readonly roll: string;
  readonly sourceId: string;
  readonly width: number;
  readonly height: number;
  /** Average colour, for a placeholder that costs seven bytes of markup. */
  readonly color: string;
  readonly lqip: string;
  readonly camera: CameraMetadata | null;
  readonly variants: readonly VariantRecord[];
  readonly og: VariantRecord;
}

export interface RollRecord {
  /** Path from the album directory to this roll. Matches `PhotoRecord.roll`. */
  readonly id: string;
  readonly photoCount: number;
}

export interface AlbumManifest {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly photos: readonly PhotoRecord[];
  /**
   * Rolls are first-class data — every photo knows which one it belongs to,
   * and this is the roll list with its automatically derived metadata (right
   * now just a frame count). Nothing in the site renders a roll as its own
   * page yet; that's a presentation decision, not a data-model one, and this
   * is the data it would need.
   */
  readonly rolls: readonly RollRecord[];
}

export interface RepositoryIndex {
  readonly schemaVersion: number;
  /** The settings that produced the current derivatives, for `doctor`. */
  readonly recipe: unknown;
  readonly albums: readonly string[];
}

export interface PublishedRecord {
  readonly schemaVersion: number;
  /** Which target the digests below were confirmed against. */
  readonly target: string;
  /** Album slug to digest of that album's sorted key set. */
  readonly albums: Readonly<Record<string, string>>;
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSlug(slug: string, source: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new PipelineError(
      `${source}: "${slug}" is not usable as a URL slug. Use lower-case letters, digits, and single hyphens, ` +
        'for example "hokkaido-winter".',
    );
  }
}

export function albumKeys(manifest: AlbumManifest): string[] {
  const keys: string[] = [];
  for (const photo of manifest.photos) {
    for (const variant of photo.variants) keys.push(variant.key);
    keys.push(photo.og.key);
  }
  return keys;
}

export function albumKeyDigest(manifest: AlbumManifest): string {
  return digestOfSet(albumKeys(manifest));
}

// ---------------------------------------------------------------------------
// Validation.
//
// Hand written rather than schema driven, because the messages are the point.
// "photos[3].variants[7].key is not a valid derivative key" locates the problem
// in a 300 KB file; "expected string" does not.
// ---------------------------------------------------------------------------

function invalid(source: string, path: string, expectation: string, actual: unknown): never {
  throw new PipelineError(`${source}: ${path} ${expectation}, got ${JSON.stringify(actual) ?? 'undefined'}`);
}

function object(value: unknown, source: string, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(source, path, 'must be an object', value);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, source: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(source, path, 'must be a positive whole number', value);
  }
  return value;
}

function nonEmptyString(value: unknown, source: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(source, path, 'must be a non-empty string', value);
  }
  return value;
}

function checkSchemaVersion(value: unknown, source: string): number {
  const version = positiveInteger(value, source, 'schemaVersion');
  if (version > SCHEMA_VERSION) {
    throw new PipelineError(
      `${source}: written by a newer pipeline (schema version ${version.toString()}, this one understands ` +
        `${SCHEMA_VERSION.toString()}). Update the pipeline, or regenerate with \`pnpm ingest\`.`,
    );
  }
  if (version < SCHEMA_VERSION) {
    throw new PipelineError(
      `${source}: schema version ${version.toString()} predates this pipeline (${SCHEMA_VERSION.toString()}). ` +
        'Regenerate it with `pnpm ingest`; manifests are always rebuildable from originals/.',
    );
  }
  return version;
}

function validateVariant(value: unknown, source: string, path: string): VariantRecord {
  const record = object(value, source, path);
  const format = record['format'];
  if (format !== 'avif' && format !== 'webp' && format !== 'jpeg') {
    invalid(source, `${path}.format`, 'must be avif, webp, or jpeg', format);
  }
  const key = nonEmptyString(record['key'], source, `${path}.key`);
  if (!isDerivativeKey(key)) {
    invalid(source, `${path}.key`, 'is not a valid derivative key (expected p/<16 hex>/<width>-<8 hex>.<ext>)', key);
  }
  return {
    format,
    width: positiveInteger(record['width'], source, `${path}.width`),
    height: positiveInteger(record['height'], source, `${path}.height`),
    bytes: positiveInteger(record['bytes'], source, `${path}.bytes`),
    key,
  };
}

function validatePhoto(value: unknown, source: string, path: string): PhotoRecord {
  const record = object(value, source, path);
  const variants = record['variants'];
  if (!Array.isArray(variants) || variants.length === 0) {
    invalid(source, `${path}.variants`, 'must be a non-empty array', variants);
  }
  return {
    file: nonEmptyString(record['file'], source, `${path}.file`),
    roll: nonEmptyString(record['roll'], source, `${path}.roll`),
    sourceId: nonEmptyString(record['sourceId'], source, `${path}.sourceId`),
    width: positiveInteger(record['width'], source, `${path}.width`),
    height: positiveInteger(record['height'], source, `${path}.height`),
    color: nonEmptyString(record['color'], source, `${path}.color`),
    lqip: nonEmptyString(record['lqip'], source, `${path}.lqip`),
    camera: (record['camera'] ?? null) as CameraMetadata | null,
    variants: variants.map((variant, index) => validateVariant(variant, source, `${path}.variants[${index.toString()}]`)),
    og: validateVariant(record['og'], source, `${path}.og`),
  };
}

function validateRoll(value: unknown, source: string, path: string): RollRecord {
  const record = object(value, source, path);
  return {
    id: nonEmptyString(record['id'], source, `${path}.id`),
    photoCount: positiveInteger(record['photoCount'], source, `${path}.photoCount`),
  };
}

export function validateAlbumManifest(value: unknown, source: string): AlbumManifest {
  const root = object(value, source, 'the manifest');
  checkSchemaVersion(root['schemaVersion'], source);
  const slug = nonEmptyString(root['slug'], source, 'slug');
  assertSlug(slug, source);
  const photos = root['photos'];
  if (!Array.isArray(photos)) invalid(source, 'photos', 'must be an array', photos);
  const rolls = root['rolls'];
  if (!Array.isArray(rolls)) invalid(source, 'rolls', 'must be an array', rolls);
  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    photos: photos.map((photo, index) => validatePhoto(photo, source, `photos[${index.toString()}]`)),
    rolls: rolls.map((roll, index) => validateRoll(roll, source, `rolls[${index.toString()}]`)),
  };
}

export function validatePublishedRecord(value: unknown, source: string): PublishedRecord {
  const root = object(value, source, 'the file');
  checkSchemaVersion(root['schemaVersion'], source);
  const albums = object(root['albums'], source, 'albums');
  const entries: Record<string, string> = {};
  for (const [slug, digest] of Object.entries(albums)) {
    entries[slug] = nonEmptyString(digest, source, `albums[${JSON.stringify(slug)}]`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    target: nonEmptyString(root['target'], source, 'target'),
    albums: entries,
  };
}

// ---------------------------------------------------------------------------
// Reading and writing.
// ---------------------------------------------------------------------------

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new PipelineError(`Could not read ${path}. Run \`pnpm ingest\` to generate it.`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new PipelineError(`${path} is not valid JSON. Delete it and run \`pnpm ingest\`.`, { cause });
  }
}

export async function readAlbumManifest(path: string): Promise<AlbumManifest> {
  return validateAlbumManifest(await readJson(path), path);
}

export async function writeAlbumManifest(path: string, manifest: AlbumManifest): Promise<void> {
  await writeFileAtomic(path, formatJson(manifest));
}

export async function readPublishedRecord(path: string): Promise<PublishedRecord | null> {
  try {
    await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return validatePublishedRecord(await readJson(path), path);
}

export async function writePublishedRecord(path: string, record: PublishedRecord): Promise<void> {
  await writeFileAtomic(path, formatJson(record));
}

export async function writeRepositoryIndex(path: string, index: RepositoryIndex): Promise<void> {
  await writeFileAtomic(path, formatJson(index));
}
