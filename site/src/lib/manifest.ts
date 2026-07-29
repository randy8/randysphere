/**
 * The site's own reading of the manifest.
 *
 * Deliberately not shared with the pipeline. A type-only import would be safe,
 * but a runtime one would not: workspace packages are symlinks into
 * node_modules, and the boundary is easier to keep honest if the site simply
 * describes what it needs. The duplication is small, and it is what makes the
 * manifest a contract rather than somebody else's internal structure.
 */
export const SUPPORTED_SCHEMA_VERSION = 2;

export type VariantFormat = 'avif' | 'webp' | 'jpeg';

export interface Variant {
  readonly format: VariantFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly key: string;
}

export interface Camera {
  readonly make: string | null;
  readonly model: string | null;
  readonly lens: string | null;
  readonly focalLength: number | null;
  readonly aperture: number | null;
  readonly shutterSpeed: string | null;
  readonly iso: number | null;
  readonly takenAt: string | null;
}

export interface Photo {
  readonly file: string;
  /** Which roll this photo belongs to — soft metadata, not yet used to render anything. */
  readonly roll: string;
  readonly sourceId: string;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly lqip: string;
  readonly camera: Camera | null;
  readonly variants: readonly Variant[];
  readonly og: Variant;
}

export interface Roll {
  readonly id: string;
  readonly photoCount: number;
}

export interface AlbumManifest {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly photos: readonly Photo[];
  readonly rolls: readonly Roll[];
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

/**
 * Enough validation to turn a corrupt or stale manifest into a build failure
 * that names the file, rather than a page that quietly renders broken images.
 */
export function readManifest(value: unknown, source: string): AlbumManifest {
  if (typeof value !== 'object' || value === null) fail(source, 'is not an object');
  const root = value as Record<string, unknown>;

  if (root['schemaVersion'] !== SUPPORTED_SCHEMA_VERSION) {
    fail(
      source,
      `has schema version ${String(root['schemaVersion'])}, but this site reads ` +
        `${String(SUPPORTED_SCHEMA_VERSION)}. Run \`pnpm ingest\` to regenerate it.`,
    );
  }
  if (typeof root['slug'] !== 'string') fail(source, 'has no slug');
  if (!Array.isArray(root['photos'])) fail(source, 'has no photos array');
  if (!Array.isArray(root['rolls'])) fail(source, 'has no rolls array');

  const photos = root['photos'].map((entry, index) => {
    const photo = entry as Partial<Photo>;
    if (typeof photo.file !== 'string') fail(source, `photos[${String(index)}] has no file`);
    if (typeof photo.roll !== 'string') fail(source, `photos[${String(index)}] (${photo.file}) has no roll`);
    if (typeof photo.width !== 'number' || typeof photo.height !== 'number') {
      fail(source, `photos[${String(index)}] (${photo.file}) has no dimensions`);
    }
    if (!Array.isArray(photo.variants) || photo.variants.length === 0) {
      fail(source, `photos[${String(index)}] (${photo.file}) has no variants`);
    }
    return photo as Photo;
  });

  const rolls = root['rolls'].map((entry, index) => {
    const roll = entry as Partial<Roll>;
    if (typeof roll.id !== 'string') fail(source, `rolls[${String(index)}] has no id`);
    if (typeof roll.photoCount !== 'number') fail(source, `rolls[${String(index)}] (${roll.id}) has no photoCount`);
    return roll as Roll;
  });

  return { schemaVersion: SUPPORTED_SCHEMA_VERSION, slug: root['slug'], photos, rolls };
}
