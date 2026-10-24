import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Decodes a share link's `?s=` value back into an ordered list of
 * `sourceId`s — the decode half of site/src/photography/share-code.ts's
 * encodeIds/decodeIds pair, copied rather than imported. tools/serve
 * deliberately depends on neither site nor tools/pipeline (see this
 * workspace's own package.json description, and server.ts's
 * isSafeRelativePath, copied from the pipeline editor for the identical
 * reason) — a ~15-line, dependency-free, DOM-free function is cheaper to
 * duplicate once than to justify a cross-workspace import for.
 */
/** A full id (original `?s=` links). */
export const FULL_ID_BYTES = 8;
/** A 4-byte id prefix (`?p=` links) — see site/src/photography/share-code.ts. */
export const PREFIX_BYTES = 4;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlToBytes(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function decodeIds(encoded: string, bytesPerId = FULL_ID_BYTES): string[] {
  const bytes = base64UrlToBytes(encoded);
  if (bytes === null) return [];
  const ids: string[] = [];
  for (let offset = 0; offset + bytesPerId <= bytes.length; offset += bytesPerId) {
    ids.push(bytesToHex(bytes.subarray(offset, offset + bytesPerId)));
  }
  return ids;
}

interface ManifestImage {
  readonly key: string;
  readonly width: number;
  readonly height: number;
}

interface ManifestVariant extends ManifestImage {
  readonly format: string;
}

interface ManifestPhoto {
  readonly sourceId: string;
  readonly og: ManifestImage;
  readonly variants?: readonly ManifestVariant[];
}

interface Manifest {
  readonly photos: readonly ManifestPhoto[];
}

function isManifestPhoto(value: unknown): value is ManifestPhoto {
  if (typeof value !== 'object' || value === null) return false;
  const photo = value as Record<string, unknown>;
  if (typeof photo['sourceId'] !== 'string') return false;
  const og = photo['og'];
  if (typeof og !== 'object' || og === null) return false;
  const ogRecord = og as Record<string, unknown>;
  return (
    typeof ogRecord['key'] === 'string' &&
    typeof ogRecord['width'] === 'number' &&
    typeof ogRecord['height'] === 'number'
  );
}

/**
 * Every `generated/albums/*.json` file, flattened into one
 * `sourceId -> photo` map. Read fresh on every call rather than cached —
 * a link-preview bot fetches a given URL once, not repeatedly, so this is
 * a handful of small JSON files parsed per share, not a hot path worth the
 * invalidation complexity of caching across `pnpm deploy` restarts.
 */
async function readPhotosById(albumsDir: string): Promise<Map<string, ManifestPhoto>> {
  const byId = new Map<string, ManifestPhoto>();
  let files: string[];
  try {
    files = (await readdir(albumsDir)).filter((file) => file.endsWith('.json'));
  } catch {
    return byId;
  }
  for (const file of files) {
    try {
      const raw = await readFile(join(albumsDir, file), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const photos = (parsed as Partial<Manifest>).photos;
      if (!Array.isArray(photos)) continue;
      for (const photo of photos) {
        if (isManifestPhoto(photo)) byId.set(photo.sourceId, photo);
      }
    } catch {
      // A malformed or unreadable manifest just contributes nothing —
      // never worth failing the whole preview lookup over one bad file.
    }
  }
  return byId;
}

export interface PhotoPreview {
  readonly imagePath: string;
  readonly width: number;
  readonly height: number;
}

export interface SharePreview extends PhotoPreview {
  /** How many of the decoded ids actually resolved to a real photograph. */
  readonly count: number;
}

/** Long edge a link preview is asked to show — sharp in an iMessage bubble, still a light download. */
const PREVIEW_LONG_EDGE = 1200;

/**
 * The photograph itself, uncropped, as a link preview: the smallest JPEG
 * variant whose long edge reaches PREVIEW_LONG_EDGE (JPEG because every
 * preview bot reads it; AVIF isn't safe there). A portrait stays portrait.
 * Falls back to the 1200×630 Open Graph crop only for a photo with no JPEG.
 */
function previewOf(photo: ManifestPhoto): PhotoPreview {
  const jpegs = (photo.variants ?? [])
    .filter((variant) => variant.format === 'jpeg')
    .sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
  const image =
    jpegs.find((variant) => Math.max(variant.width, variant.height) >= PREVIEW_LONG_EDGE) ??
    jpegs.at(-1) ??
    photo.og;
  return { imagePath: `/${image.key}`, width: image.width, height: image.height };
}

/**
 * A single `sourceId` — as named by a Browse page's own `?photo=` query
 * param (browse.ts's replaceHash sets it alongside the #photo-<id> hash
 * it's always kept, specifically so a copied address-bar URL survives a
 * link-preview bot, which never sees the hash at all) — resolved to its
 * own OG crop. null if the id doesn't match any current photograph.
 */
export async function findPhotoPreview(
  albumsDir: string,
  id: string,
): Promise<PhotoPreview | null> {
  const byId = await readPhotosById(albumsDir);
  const photo = byId.get(id);
  return photo === undefined ? null : previewOf(photo);
}

/**
 * The first decoded id that resolves to a real photograph's own OG crop,
 * plus how many of the ids resolved at all — gracefully ignoring ids for
 * photographs since removed from the archive, the same way
 * saved-view.ts/share-view.ts already do client-side. null if nothing in
 * `encoded` resolves (a malformed link, or every photograph it named is
 * gone) — the caller then just serves the page's own default unmodified.
 */
export async function findSharePreview(
  albumsDir: string,
  encoded: string,
  bytesPerId = FULL_ID_BYTES,
): Promise<SharePreview | null> {
  const prefixes = decodeIds(encoded, bytesPerId);
  if (prefixes.length === 0) return null;
  const byId = await readPhotosById(albumsDir);
  const all = [...byId.values()];
  let first: ManifestPhoto | null = null;
  let count = 0;
  for (const prefix of prefixes) {
    // A full id is a prefix that matches itself; an ambiguous one matches nothing.
    const matches = all.filter((photo) => photo.sourceId.startsWith(prefix));
    const photo = matches.length === 1 ? matches[0] : undefined;
    if (photo === undefined) continue;
    count += 1;
    if (first === null) first = photo;
  }
  if (first === null) return null;
  return { ...previewOf(first), count };
}
