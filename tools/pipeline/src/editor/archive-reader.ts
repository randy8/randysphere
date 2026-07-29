import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PHOTOS_FILE, readPhotosFile } from '../album-files.ts';
import { sha256Hex } from '../hash.ts';
import type { PhotoRecord, VariantRecord } from '../manifest.ts';
import type { Paths } from '../paths.ts';
import { readAllManifests } from '../publish.ts';

/**
 * The editor's own flat, read-side join of every album's manifest with its
 * `photos.yaml` — the pipeline-native equivalent of `site/src/lib/archive.ts`.
 * It cannot import that module (the pipeline↔site boundary is type-only, see
 * docs/decisions.md), and it needs different fields anyway: derivative keys
 * for direct on-disk serving, and an album version hash for the write path's
 * staleness guard, neither of which the site's read-only view needs.
 */
export interface EditorPhoto {
  readonly album: string;
  /** Path relative to the album directory — the join key with `photos.yaml`, and this photo's identity within its album. */
  readonly file: string;
  readonly sourceId: string;
  readonly roll: string;
  readonly width: number;
  readonly height: number;
  readonly thumbnailKey: string;
  readonly previewKey: string;
  readonly alt: string;
  readonly caption: string | null;
  readonly tags: readonly string[];
}

export interface EditorArchive {
  readonly photos: readonly EditorPhoto[];
  /** Album slug -> sha256 of its current `photos.yaml` content, handed to the client for the write path's staleness guard. */
  readonly albumVersions: Readonly<Record<string, string>>;
}

function variantsOf(photo: PhotoRecord, format: VariantRecord['format']): VariantRecord[] {
  return photo.variants
    .filter((variant) => variant.format === format)
    .sort((a, b) => a.width - b.width);
}

/**
 * webp specifically (not avif) for both thumbnail and preview: this is an
 * always-local editing tool, not the public site, so there's no payload-size
 * pressure worth trading for avif's narrower decode support — boring and
 * reliable beats marginally smaller here.
 */
function thumbnailKey(photo: PhotoRecord): string {
  return (variantsOf(photo, 'webp')[0] ?? photo.og).key;
}

function previewKey(photo: PhotoRecord): string {
  const webp = variantsOf(photo, 'webp');
  return (webp.find((variant) => variant.width >= 1200) ?? webp.at(-1) ?? photo.og).key;
}

/** Reads every manifest and every album's `photos.yaml`, joined into one flat, editable list. */
export async function loadEditorArchive(paths: Paths): Promise<EditorArchive> {
  const manifests = await readAllManifests(paths);
  const photos: EditorPhoto[] = [];
  const albumVersions: Record<string, string> = {};

  for (const manifest of manifests) {
    const albumDirectory = join(paths.albums, manifest.slug);
    const entries = await readPhotosFile(albumDirectory);
    const byFile = new Map(entries.map((entry) => [entry.file, entry]));

    const photosYaml = await readFile(join(albumDirectory, PHOTOS_FILE), 'utf8');
    albumVersions[manifest.slug] = sha256Hex(photosYaml);

    for (const photo of manifest.photos) {
      const entry = byFile.get(photo.file);
      photos.push({
        album: manifest.slug,
        file: photo.file,
        sourceId: photo.sourceId,
        roll: photo.roll,
        width: photo.width,
        height: photo.height,
        thumbnailKey: thumbnailKey(photo),
        previewKey: previewKey(photo),
        alt: entry?.alt ?? '',
        caption: entry?.caption ?? null,
        tags: entry?.tags ?? [],
      });
    }
  }

  return { photos, albumVersions };
}

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

/** The global tag vocabulary, most-used first, for autocomplete ranking. */
export function tagCounts(archive: EditorArchive): TagCount[] {
  const counts = new Map<string, number>();
  for (const photo of archive.photos) {
    for (const tag of photo.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
