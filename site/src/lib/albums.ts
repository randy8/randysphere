import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import type { AlbumManifest, Photo } from './manifest.ts';
import { readManifest } from './manifest.ts';

export interface AlbumMeta {
  readonly title: string;
  readonly date: string;
  readonly location: string;
  readonly description: string;
  readonly featured: boolean;
  readonly cover: string;
}

export interface AlbumPhoto {
  readonly photo: Photo;
  readonly alt: string;
  readonly caption: string | null;
}

export interface Album {
  readonly slug: string;
  readonly meta: AlbumMeta;
  readonly photos: readonly AlbumPhoto[];
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

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function readFrontmatter(path: string, slug: string): AlbumMeta {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. Run \`pnpm ingest\`, which creates it.`);
  }
  const match = FRONTMATTER.exec(readFileSync(path, 'utf8'));
  if (match?.[1] === undefined) {
    throw new Error(`${path} has no frontmatter block. It must start with a line containing only ---`);
  }
  const data = (parse(match[1]) ?? {}) as Partial<AlbumMeta>;
  return {
    title: data.title ?? slug,
    date: String(data.date ?? ''),
    location: data.location ?? '',
    description: data.description ?? '',
    featured: data.featured ?? false,
    cover: data.cover ?? '',
  };
}

interface PhotoEntry {
  readonly file?: string;
  readonly alt?: string;
  readonly caption?: string;
}

function readCaptions(path: string): PhotoEntry[] {
  if (!existsSync(path)) return [];
  const data = (parse(readFileSync(path, 'utf8')) ?? {}) as { photos?: PhotoEntry[] };
  return data.photos ?? [];
}

/**
 * The manifest decides which photographs exist; photos.yaml decides the order
 * they appear in and what is said about them. A photograph listed in captions
 * but absent from the manifest is a real inconsistency and stops the build.
 */
function join_(manifest: AlbumManifest, entries: readonly PhotoEntry[], slug: string): AlbumPhoto[] {
  const byFile = new Map(manifest.photos.map((photo) => [photo.file, photo]));
  const ordered: AlbumPhoto[] = [];

  for (const entry of entries) {
    if (entry.file === undefined) continue;
    const photo = byFile.get(entry.file);
    if (photo === undefined) {
      throw new Error(
        `albums/${slug}/photos.yaml lists ${entry.file}, which is not in the manifest. ` +
          'Run `pnpm ingest`.',
      );
    }
    byFile.delete(entry.file);
    ordered.push({
      photo,
      alt: entry.alt?.trim() ?? '',
      caption: entry.caption?.trim() ? entry.caption.trim() : null,
    });
  }

  // Anything ingested but not yet listed still appears, at the end, rather
  // than silently vanishing from the album.
  for (const photo of byFile.values()) {
    ordered.push({ photo, alt: '', caption: null });
  }
  return ordered;
}

export function loadAlbum(slug: string): Album {
  const manifestPath = join(MANIFEST_DIRECTORY, `${slug}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} does not exist. Run \`pnpm ingest\`.`);
  }
  const manifest = readManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  const meta = readFrontmatter(join(ALBUM_DIRECTORY, slug, 'album.md'), slug);
  const captions = readCaptions(join(ALBUM_DIRECTORY, slug, 'photos.yaml'));
  return { slug, meta, photos: join_(manifest, captions, slug) };
}

export function loadAlbums(): Album[] {
  if (!existsSync(MANIFEST_DIRECTORY)) {
    throw new Error(
      `${MANIFEST_DIRECTORY} does not exist, so there is nothing to show.\n` +
        'Put photographs in originals/<album-slug>/ and run `pnpm ingest`.',
    );
  }
  const slugs = readdirSync(MANIFEST_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

  if (slugs.length === 0) {
    throw new Error(
      `No manifests in ${MANIFEST_DIRECTORY}.\n` +
        'Put photographs in originals/<album-slug>/ and run `pnpm ingest`.',
    );
  }
  return slugs.map(loadAlbum).sort((a, b) => b.meta.date.localeCompare(a.meta.date));
}

export function coverPhoto(album: Album): AlbumPhoto {
  const named = album.photos.find((entry) => entry.photo.file === album.meta.cover);
  const first = album.photos[0];
  if (named === undefined && first === undefined) {
    throw new Error(`Album ${album.slug} has no photographs.`);
  }
  return named ?? (first as AlbumPhoto);
}
