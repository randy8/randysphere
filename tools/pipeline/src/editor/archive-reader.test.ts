import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { syncPhotosFile } from '../album-files.ts';
import { formatJson, writeFileAtomic } from '../files.ts';
import type { AlbumManifest, PhotoRecord, VariantRecord } from '../manifest.ts';
import type { Paths } from '../paths.ts';
import { resolvePaths } from '../paths.ts';
import { loadEditorArchive, tagCounts } from './archive-reader.ts';

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

function photo(file: string, roll: string, sourceId: string): PhotoRecord {
  return {
    file,
    roll,
    sourceId,
    width: 1600,
    height: 1200,
    color: '#808080',
    lqip: 'data:image/webp;base64,AA==',
    camera: null,
    variants: [variant(400), variant(800), variant(1600)],
    og: ogVariant(),
  };
}

function manifest(slug: string, photos: PhotoRecord[], rolls: string[]): AlbumManifest {
  return {
    schemaVersion: 2,
    slug,
    photos,
    rolls: rolls.map((id) => ({ id, photoCount: photos.filter((p) => p.roll === id).length })),
  };
}

async function fixtureRoot(): Promise<Paths> {
  const root = await mkdtemp(join(tmpdir(), 'photo-editor-'));
  const paths = resolvePaths(root);
  await mkdir(paths.manifests, { recursive: true });
  await mkdir(paths.albums, { recursive: true });
  return paths;
}

test('loadEditorArchive joins one album manifest with its photos.yaml', async () => {
  const paths = await fixtureRoot();
  const albumManifest = manifest(
    'paris-2025',
    [photo('0827/001.jpg', '0827', 'aaaaaaaaaaaaaaaa')],
    ['0827'],
  );
  await writeFileAtomic(join(paths.manifests, 'paris-2025.json'), formatJson(albumManifest));
  await mkdir(join(paths.albums, 'paris-2025'), { recursive: true });
  await syncPhotosFile(
    join(paths.albums, 'paris-2025'),
    [{ file: '0827/001.jpg', sourceId: 'aaaaaaaaaaaaaaaa' }],
    'paris-2025',
  );

  const archive = await loadEditorArchive(paths);

  assert.equal(archive.photos.length, 1);
  const [entry] = archive.photos;
  assert.equal(entry?.album, 'paris-2025');
  assert.equal(entry?.file, '0827/001.jpg');
  assert.equal(entry?.sourceId, 'aaaaaaaaaaaaaaaa');
  assert.equal(entry?.roll, '0827');
  assert.deepEqual(entry?.tags, ['paris-2025']);
  assert.equal(entry?.alt, '');
  assert.equal(entry?.caption, null);
  assert.equal(entry?.thumbnailKey, 'p/0123456789abcdef/400-01234567.webp');
  assert.equal(entry?.previewKey, 'p/0123456789abcdef/1600-01234567.webp');
  assert.ok(archive.albumVersions['paris-2025']);
});

test('loadEditorArchive merges multiple albums into one flat list', async () => {
  const paths = await fixtureRoot();
  for (const slug of ['paris-2025', 'tokyo-2024']) {
    const sourceId = `${slug}sourceid00000000`.slice(0, 16);
    const albumManifest = manifest(slug, [photo('001.jpg', '.', sourceId)], ['.']);
    await writeFileAtomic(join(paths.manifests, `${slug}.json`), formatJson(albumManifest));
    await mkdir(join(paths.albums, slug), { recursive: true });
    await syncPhotosFile(join(paths.albums, slug), [{ file: '001.jpg', sourceId }], slug);
  }

  const archive = await loadEditorArchive(paths);

  assert.equal(archive.photos.length, 2);
  assert.deepEqual(archive.photos.map((p) => p.album).sort(), ['paris-2025', 'tokyo-2024']);
  assert.equal(Object.keys(archive.albumVersions).length, 2);
});

test('loadEditorArchive still includes a manifest photo missing from photos.yaml, with empty defaults', async () => {
  const paths = await fixtureRoot();
  const albumManifest = manifest(
    'paris-2025',
    [photo('001.jpg', '.', 'aaaaaaaaaaaaaaaa'), photo('002.jpg', '.', 'bbbbbbbbbbbbbbbb')],
    ['.'],
  );
  await writeFileAtomic(join(paths.manifests, 'paris-2025.json'), formatJson(albumManifest));
  await mkdir(join(paths.albums, 'paris-2025'), { recursive: true });
  // Only 001.jpg has been ingested into photos.yaml; 002.jpg is not listed there.
  await syncPhotosFile(
    join(paths.albums, 'paris-2025'),
    [{ file: '001.jpg', sourceId: 'aaaaaaaaaaaaaaaa' }],
    'paris-2025',
  );

  const archive = await loadEditorArchive(paths);

  const second = archive.photos.find((p) => p.file === '002.jpg');
  assert.ok(second);
  assert.equal(second?.alt, '');
  assert.equal(second?.caption, null);
  assert.deepEqual(second?.tags, []);
});

test('tagCounts aggregates and sorts by count, then alphabetically', async () => {
  const paths = await fixtureRoot();
  const albumManifest = manifest(
    'paris-2025',
    [
      photo('001.jpg', '.', 'aaaaaaaaaaaaaaaa'),
      photo('002.jpg', '.', 'bbbbbbbbbbbbbbbb'),
      photo('003.jpg', '.', 'cccccccccccccccc'),
    ],
    ['.'],
  );
  await writeFileAtomic(join(paths.manifests, 'paris-2025.json'), formatJson(albumManifest));
  const albumDirectory = join(paths.albums, 'paris-2025');
  await mkdir(albumDirectory, { recursive: true });
  await syncPhotosFile(
    albumDirectory,
    [
      { file: '001.jpg', sourceId: 'aaaaaaaaaaaaaaaa' },
      { file: '002.jpg', sourceId: 'bbbbbbbbbbbbbbbb' },
      { file: '003.jpg', sourceId: 'cccccccccccccccc' },
    ],
    'paris-2025',
  );
  const { applyPhotoEdits } = await import('../album-files.ts');
  await applyPhotoEdits(
    albumDirectory,
    [
      { file: '001.jpg', addTags: ['street'] },
      { file: '002.jpg', addTags: ['street', 'night'] },
    ],
    null,
  );

  const archive = await loadEditorArchive(paths);
  const counts = tagCounts(archive);

  assert.deepEqual(counts, [
    { tag: 'paris-2025', count: 3 },
    { tag: 'street', count: 2 },
    { tag: 'night', count: 1 },
  ]);
});
