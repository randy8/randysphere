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
const ID_BYTES = 8;

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

export function decodeIds(encoded: string): string[] {
  const bytes = base64UrlToBytes(encoded);
  if (bytes === null) return [];
  const ids: string[] = [];
  for (let offset = 0; offset + ID_BYTES <= bytes.length; offset += ID_BYTES) {
    ids.push(bytesToHex(bytes.subarray(offset, offset + ID_BYTES)));
  }
  return ids;
}

interface ManifestPhoto {
  readonly sourceId: string;
  readonly og: { readonly key: string; readonly width: number; readonly height: number };
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

function previewOf(photo: ManifestPhoto): PhotoPreview {
  return { imagePath: `/${photo.og.key}`, width: photo.og.width, height: photo.og.height };
}

/**
 * A single `sourceId` — as named by a Browse page's own `?photo=` query
 * param (browse.ts's replaceHash sets it alongside the #photo-<id> hash
 * it's always kept, specifically so a copied address-bar URL survives a
 * link-preview bot, which never sees the hash at all) — resolved to its
 * own OG crop. null if the id doesn't match any current photograph.
 */
export async function findPhotoPreview(albumsDir: string, id: string): Promise<PhotoPreview | null> {
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
): Promise<SharePreview | null> {
  const ids = decodeIds(encoded);
  if (ids.length === 0) return null;
  const byId = await readPhotosById(albumsDir);
  let first: ManifestPhoto | null = null;
  let count = 0;
  for (const id of ids) {
    const photo = byId.get(id);
    if (photo === undefined) continue;
    count += 1;
    if (first === null) first = photo;
  }
  if (first === null) return null;
  return { ...previewOf(first), count };
}
