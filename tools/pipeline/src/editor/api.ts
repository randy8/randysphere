import { join } from 'node:path';

import { applyPhotoEdits, StaleAlbumFileError, updateAlbumCover } from '../album-files.ts';
import type { PhotoEdit } from '../album-files.ts';
import { PipelineError } from '../errors.ts';
import type { Paths } from '../paths.ts';
import { loadEditorArchive, tagCounts } from './archive-reader.ts';
import { withAlbumLock } from './lock.ts';

function mediaUrl(key: string): string {
  return `/media/${key}`;
}

export interface EditorPhotoView {
  readonly album: string;
  readonly file: string;
  readonly sourceId: string;
  readonly roll: string;
  readonly width: number;
  readonly height: number;
  readonly thumbnailUrl: string;
  readonly previewUrl: string;
  readonly alt: string;
  readonly caption: string | null;
  readonly tags: readonly string[];
  readonly featured: boolean;
  readonly featuredOrder: number | null;
  readonly cover: boolean;
}

export interface ListPhotosResponse {
  readonly photos: readonly EditorPhotoView[];
  readonly albumVersions: Readonly<Record<string, string>>;
}

/** Everything the grid, inspector, and batch bar need, joined across every album. */
export async function listPhotos(paths: Paths): Promise<ListPhotosResponse> {
  const archive = await loadEditorArchive(paths);
  return {
    photos: archive.photos.map((photo) => ({
      album: photo.album,
      file: photo.file,
      sourceId: photo.sourceId,
      roll: photo.roll,
      width: photo.width,
      height: photo.height,
      thumbnailUrl: mediaUrl(photo.thumbnailKey),
      previewUrl: mediaUrl(photo.previewKey),
      alt: photo.alt,
      caption: photo.caption,
      tags: photo.tags,
      featured: photo.featured,
      featuredOrder: photo.featuredOrder,
      cover: photo.cover,
    })),
    albumVersions: archive.albumVersions,
  };
}

export interface ListTagsResponse {
  readonly tags: readonly { tag: string; count: number }[];
}

/** The global tag vocabulary, most-used first, for autocomplete. */
export async function listTags(paths: Paths): Promise<ListTagsResponse> {
  const archive = await loadEditorArchive(paths);
  return { tags: tagCounts(archive) };
}

export interface EditConflict {
  readonly album: string;
  readonly message: string;
}

interface FlatEdit extends PhotoEdit {
  readonly album: string;
}

/**
 * Applies edits grouped by album, one `applyPhotoEdits` call (one write) per
 * album regardless of how many photos in it were edited. Only a staleness
 * conflict is caught and reported back as data — every other failure (a
 * malformed edit referencing a file with no `photos.yaml` entry, a YAML
 * parse error) is a real bug or a corrupt repo state and propagates, for
 * `server.ts` to map to a 400/500.
 */
async function writeGroupedEdits(
  paths: Paths,
  edits: readonly FlatEdit[],
  expectedVersions: Readonly<Record<string, string>> | null,
): Promise<{ albumVersions: Record<string, string>; conflicts: EditConflict[] }> {
  const byAlbum = new Map<string, PhotoEdit[]>();
  for (const { album, ...edit } of edits) {
    const list = byAlbum.get(album) ?? [];
    list.push(edit);
    byAlbum.set(album, list);
  }

  const albumVersions: Record<string, string> = {};
  const conflicts: EditConflict[] = [];
  for (const [album, albumEdits] of byAlbum) {
    const albumDirectory = join(paths.albums, album);
    const expectedVersion = expectedVersions?.[album] ?? null;
    try {
      const result = await withAlbumLock(albumDirectory, () =>
        applyPhotoEdits(albumDirectory, albumEdits, expectedVersion),
      );
      albumVersions[album] = result.version;
    } catch (error) {
      if (error instanceof StaleAlbumFileError) {
        conflicts.push({ album, message: error.message });
      } else {
        throw error;
      }
    }
  }
  return { albumVersions, conflicts };
}

export interface ApplyEditsRequest {
  readonly edits: readonly FlatEdit[];
  readonly expectedVersions: Readonly<Record<string, string>>;
}

export interface ApplyEditsResponse {
  readonly ok: boolean;
  readonly albumVersions: Readonly<Record<string, string>>;
  readonly conflicts: readonly EditConflict[];
}

export async function applyEdits(
  paths: Paths,
  request: ApplyEditsRequest,
): Promise<ApplyEditsResponse> {
  const { albumVersions, conflicts } = await writeGroupedEdits(
    paths,
    request.edits,
    request.expectedVersions,
  );
  return { ok: conflicts.length === 0, albumVersions, conflicts };
}

export interface SetCoverRequest {
  readonly album: string;
  readonly file: string;
}

/** Sets an album's cover photo (album.md's `cover:`) — a separate file from photos.yaml, so a separate write path from applyEdits, under the same per-album lock. */
export async function setCover(paths: Paths, request: SetCoverRequest): Promise<void> {
  const albumDirectory = join(paths.albums, request.album);
  await withAlbumLock(albumDirectory, () => updateAlbumCover(albumDirectory, request.file));
}

export interface TagMaintenanceResponse {
  readonly albumVersions: Readonly<Record<string, string>>;
  readonly affected: number;
}

/** Finds every photo carrying `from` across the whole archive and swaps it for `to`, one write per affected album. */
export async function renameTagEverywhere(
  paths: Paths,
  from: string,
  to: string,
): Promise<TagMaintenanceResponse> {
  if (from.trim().length === 0 || to.trim().length === 0) {
    throw new PipelineError('Both the current and new tag name are required.');
  }
  if (from === to)
    throw new PipelineError('The new tag name must be different from the current one.');

  const archive = await loadEditorArchive(paths);
  const edits: FlatEdit[] = archive.photos
    .filter((photo) => photo.tags.includes(from))
    .map((photo) => ({ album: photo.album, file: photo.file, addTags: [to], removeTags: [from] }));

  const { albumVersions } = await writeGroupedEdits(paths, edits, null);
  return { albumVersions, affected: edits.length };
}

/** Finds every photo carrying `tag` across the whole archive and removes it, one write per affected album. */
export async function deleteTagEverywhere(
  paths: Paths,
  tag: string,
): Promise<TagMaintenanceResponse> {
  const archive = await loadEditorArchive(paths);
  const edits: FlatEdit[] = archive.photos
    .filter((photo) => photo.tags.includes(tag))
    .map((photo) => ({ album: photo.album, file: photo.file, removeTags: [tag] }));

  const { albumVersions } = await writeGroupedEdits(paths, edits, null);
  return { albumVersions, affected: edits.length };
}
