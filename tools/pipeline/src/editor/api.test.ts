import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { scaffoldAlbumMarkdown, syncPhotosFile } from '../album-files.ts';
import { formatJson, writeFileAtomic } from '../files.ts';
import type { AlbumManifest, PhotoRecord, VariantRecord } from '../manifest.ts';
import type { Paths } from '../paths.ts';
import { resolvePaths } from '../paths.ts';
import {
  applyEdits,
  deleteTagEverywhere,
  listPhotos,
  listTags,
  renameTagEverywhere,
  setCover,
} from './api.ts';

function variant(width: number): VariantRecord {
  return {
    format: 'webp',
    width,
    height: Math.round((width * 3) / 4),
    bytes: 1000,
    key: `p/0123456789abcdef/${String(width)}-01234567.webp`,
  };
}

function ogVariant(): VariantRecord {
  return {
    format: 'jpeg',
    width: 1200,
    height: 630,
    bytes: 2000,
    key: 'p/0123456789abcdef/og-01234567.jpg',
  };
}

function photo(file: string, sourceId: string): PhotoRecord {
  return {
    file,
    roll: '.',
    sourceId,
    width: 1600,
    height: 1200,
    color: '#808080',
    lqip: 'data:image/webp;base64,AA==',
    camera: null,
    variants: [variant(400), variant(1600)],
    og: ogVariant(),
  };
}

function manifest(slug: string, photos: PhotoRecord[]): AlbumManifest {
  return { schemaVersion: 2, slug, photos, rolls: [{ id: '.', photoCount: photos.length }] };
}

async function fixtureAlbum(slug: string, files: string[]): Promise<Paths> {
  const root = await mkdtemp(join(tmpdir(), 'photo-editor-api-'));
  const paths = resolvePaths(root);
  await mkdir(paths.manifests, { recursive: true });
  const albumDirectory = join(paths.albums, slug);
  await mkdir(albumDirectory, { recursive: true });
  const photos = files.map((file, index) => photo(file, `${slug}${String(index)}`.padEnd(16, '0')));
  await writeFileAtomic(join(paths.manifests, `${slug}.json`), formatJson(manifest(slug, photos)));
  await syncPhotosFile(
    albumDirectory,
    photos.map((p) => ({ file: p.file, sourceId: p.sourceId })),
    slug,
  );
  return paths;
}

test('listPhotos returns joined photos with media URLs and album versions', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg']);

  const response = await listPhotos(paths);

  assert.equal(response.photos.length, 1);
  const [photoView] = response.photos;
  assert.equal(photoView?.thumbnailUrl, '/media/p/0123456789abcdef/400-01234567.webp');
  assert.equal(photoView?.previewUrl, '/media/p/0123456789abcdef/1600-01234567.webp');
  assert.deepEqual(photoView?.tags, ['paris-2025']);
  assert.ok(response.albumVersions['paris-2025']);
});

test('listTags returns the global vocabulary with counts', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);

  const response = await listTags(paths);

  assert.deepEqual(response.tags, [{ tag: 'paris-2025', count: 2 }]);
});

test('applyEdits groups edits by album into one write and reports fresh versions', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);
  const before = await listPhotos(paths);

  const result = await applyEdits(paths, {
    edits: [
      { album: 'paris-2025', file: '001.jpg', addTags: ['street'] },
      { album: 'paris-2025', file: '002.jpg', alt: 'A street at dusk.' },
    ],
    expectedVersions: before.albumVersions,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.conflicts, []);
  assert.notEqual(result.albumVersions['paris-2025'], before.albumVersions['paris-2025']);

  const after = await listPhotos(paths);
  const first = after.photos.find((p) => p.file === '001.jpg');
  const second = after.photos.find((p) => p.file === '002.jpg');
  assert.deepEqual(first?.tags, ['paris-2025', 'street']);
  assert.equal(second?.alt, 'A street at dusk.');
});

test('applyEdits reports a conflict, not a thrown error, when a version is stale', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg']);
  const before = await listPhotos(paths);

  // Something else changes the album first.
  await applyEdits(paths, {
    edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['street'] }],
    expectedVersions: before.albumVersions,
  });

  const result = await applyEdits(paths, {
    edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['night'] }],
    expectedVersions: before.albumVersions,
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.album, 'paris-2025');
});

test('renameTagEverywhere swaps a tag across every affected photo in one pass', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);
  await applyEdits(paths, {
    edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['streeet'] }],
    expectedVersions: (await listPhotos(paths)).albumVersions,
  });

  const result = await renameTagEverywhere(paths, 'streeet', 'street');

  assert.equal(result.affected, 1);
  const after = await listPhotos(paths);
  const first = after.photos.find((p) => p.file === '001.jpg');
  assert.deepEqual(first?.tags, ['paris-2025', 'street']);
});

test('deleteTagEverywhere removes a tag from every photo that carries it', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);

  const result = await deleteTagEverywhere(paths, 'paris-2025');

  assert.equal(result.affected, 2);
  const after = await listPhotos(paths);
  for (const photo of after.photos) assert.deepEqual(photo.tags, []);
});

test('listPhotos reports featured and cover status from photos.yaml and album.md', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);
  await scaffoldAlbumMarkdown(join(paths.albums, 'paris-2025'), 'paris-2025', null, '001.jpg');
  await applyEdits(paths, {
    edits: [{ album: 'paris-2025', file: '002.jpg', featured: true, featuredOrder: 1 }],
    expectedVersions: (await listPhotos(paths)).albumVersions,
  });

  const response = await listPhotos(paths);
  const first = response.photos.find((p) => p.file === '001.jpg');
  const second = response.photos.find((p) => p.file === '002.jpg');
  assert.equal(first?.cover, true);
  assert.equal(second?.cover, false);
  assert.equal(first?.featured, false);
  assert.equal(second?.featured, true);
  assert.equal(second?.featuredOrder, 1);
});

test('setCover changes album.md without touching photos.yaml', async () => {
  const paths = await fixtureAlbum('paris-2025', ['001.jpg', '002.jpg']);
  await scaffoldAlbumMarkdown(join(paths.albums, 'paris-2025'), 'paris-2025', null, '001.jpg');

  await setCover(paths, { album: 'paris-2025', file: '002.jpg' });

  const response = await listPhotos(paths);
  const first = response.photos.find((p) => p.file === '001.jpg');
  const second = response.photos.find((p) => p.file === '002.jpg');
  assert.equal(first?.cover, false);
  assert.equal(second?.cover, true);
});
