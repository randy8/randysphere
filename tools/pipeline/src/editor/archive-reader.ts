import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PHOTOS_FILE, readAlbumCover, readPhotosFile } from '../album-files.ts';
import type { PipelineConfig } from '../config.ts';
import { sha256Hex } from '../hash.ts';
import type { PhotoRecord, VariantRecord } from '../manifest.ts';
import type { Rotation } from '../orientation.ts';
import { ROTATIONS } from '../orientation.ts';
import type { Paths } from '../paths.ts';
import { planOpenGraph } from '../recipe.ts';
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
  readonly featured: boolean;
  readonly featuredOrder: number | null;
  /** The turn photos.yaml asks for. */
  readonly rotate: Rotation;
  /**
   * The turn the derivatives on disk actually carry — differs from `rotate`
   * until the next `pnpm ingest`, which is what lets the editor preview a
   * pending turn without double-rotating an already-baked thumbnail.
   */
  readonly appliedRotate: Rotation;
  /** True if this photo is its album's current cover (album.md's `cover:`). */
  readonly cover: boolean;
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
 * AVIF for both thumbnail and preview — the only responsive format still
 * encoded (WebP was dropped 2026-10-24), and every browser the editor runs
 * in decodes it. The Open Graph JPEG is the fallback for a photo with none.
 */
function thumbnailKey(photo: PhotoRecord): string {
  return (variantsOf(photo, 'avif')[0] ?? photo.og).key;
}

function previewKey(photo: PhotoRecord): string {
  const avif = variantsOf(photo, 'avif');
  return (avif.find((variant) => variant.width >= 1200) ?? avif.at(-1) ?? photo.og).key;
}

/**
 * Which turn produced the derivatives on disk, recovered without a manifest
 * field: the rotation is part of the Open Graph key's digest, so whichever
 * candidate reproduces the recorded key is the one that was encoded.
 */
export function appliedRotation(photo: PhotoRecord, config: PipelineConfig): Rotation {
  return (
    ROTATIONS.find(
      (rotate) => planOpenGraph(photo.sourceId, config, rotate).key === photo.og.key,
    ) ?? 0
  );
}

/**
 * Reads every manifest and every album's `photos.yaml`, joined into one flat,
 * editable list. `config` is only needed to work out `appliedRotate`; without
 * it (tag maintenance, which never looks), a photo's turn is taken as applied.
 */
export async function loadEditorArchive(
  paths: Paths,
  config?: PipelineConfig,
): Promise<EditorArchive> {
  const manifests = await readAllManifests(paths);
  const photos: EditorPhoto[] = [];
  const albumVersions: Record<string, string> = {};

  for (const manifest of manifests) {
    const albumDirectory = join(paths.albums, manifest.slug);
    const entries = await readPhotosFile(albumDirectory);
    const byFile = new Map(entries.map((entry) => [entry.file, entry]));
    const cover = await readAlbumCover(albumDirectory);

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
        featured: entry?.featured ?? false,
        featuredOrder: entry?.featuredOrder ?? null,
        rotate: entry?.rotate ?? 0,
        appliedRotate: config === undefined ? (entry?.rotate ?? 0) : appliedRotation(photo, config),
        cover: cover === photo.file,
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
