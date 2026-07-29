import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allTags, byTag, joinBatch, joinRolls, viewForTag } from './archive.ts';
import type { Archive, ArchivePhoto } from './archive.ts';
import type { AlbumManifest, Photo, Variant } from './manifest.ts';

const VARIANT: Variant = { format: 'avif', width: 400, height: 267, bytes: 1000, key: 'p/aaaaaaaaaaaaaaaa/400-11111111.avif' };

function photo(file: string, roll: string, takenAt: string | null = null): Photo {
  return {
    file,
    roll,
    sourceId: file,
    width: 1800,
    height: 1200,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera: takenAt === null ? null : { make: null, model: null, lens: null, focalLength: null, aperture: null, shutterSpeed: null, iso: null, takenAt },
    variants: [VARIANT],
    og: VARIANT,
  };
}

function manifest(photos: readonly Photo[], rolls: readonly { id: string; photoCount: number }[]): AlbumManifest {
  return { schemaVersion: 2, slug: 'test-batch', photos, rolls };
}

test('joinRolls preserves manifest roll order and carries photoCount through', () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0828/001.tif', '0828')],
    [{ id: '0827', photoCount: 1 }, { id: '0828', photoCount: 1 }],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  assert.deepEqual(rolls.map((r) => r.id), ['0827', '0828']);
  assert.equal(rolls[0]?.photoCount, 1);
});

test('joinRolls throws when rolls.yaml references a roll the manifest does not have', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  assert.throws(() => joinRolls(m, [{ id: '9999' }], 'test-batch'), /rolls\.yaml lists roll "9999"/);
});

test('joinBatch assigns a 1-based frame per roll, derived from manifest order, not stored anywhere', () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0827/002.tif', '0827'), photo('0828/001.tif', '0828')],
    [{ id: '0827', photoCount: 2 }, { id: '0828', photoCount: 1 }],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch');
  assert.equal(photos.find((p) => p.photo.file === '0827/001.tif')?.frame, 1);
  assert.equal(photos.find((p) => p.photo.file === '0827/002.tif')?.frame, 2);
  assert.equal(photos.find((p) => p.photo.file === '0828/001.tif')?.frame, 1);
});

test('joinBatch carries per-photo tags from photos.yaml through untouched', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [{ file: '0827/001.tif', tags: ['paris-2025', 'street'] }], rolls, 'test-batch');
  assert.deepEqual(photos[0]?.tags, ['paris-2025', 'street']);
});

test('joinBatch defaults tags to an empty list when photos.yaml has none for a photo', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch');
  assert.deepEqual(photos[0]?.tags, []);
});

test('joinBatch throws if a photo belongs to a roll missing from the rolls list', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  assert.throws(() => joinBatch(m, [], [], 'test-batch'), /belongs to roll "0827", which is not in the manifest's rolls list/);
});

function archiveOf(photos: readonly ArchivePhoto[]): Archive {
  return { photos };
}

function stubPhoto(file: string, tags: readonly string[], takenAt: string | null = null): ArchivePhoto {
  return {
    photo: photo(file, '0827', takenAt),
    batch: 'test-batch',
    roll: { id: '0827', photoCount: 1, filmStock: '', notes: '', date: null },
    frame: 1,
    tags,
    alt: '',
    caption: null,
  };
}

test('a photo tagged with multiple values appears in every matching query, as the same record', () => {
  const archive = archiveOf([stubPhoto('001.tif', ['paris-2025', 'street']), stubPhoto('002.tif', ['paris-2025'])]);
  const paris = byTag(archive, 'paris-2025');
  const street = byTag(archive, 'street');
  assert.equal(paris.length, 2);
  assert.equal(street.length, 1);
  // Same underlying photo object in both views — not duplicated.
  assert.equal(paris.find((p) => p.tags.includes('street')), street[0]);
});

test('allTags is the union of every photo\'s tags, deduplicated and sorted, with no separate "trips" list', () => {
  const archive = archiveOf([stubPhoto('001.tif', ['paris-2025', 'street']), stubPhoto('002.tif', ['tokyo-2024'])]);
  assert.deepEqual(allTags(archive), ['paris-2025', 'street', 'tokyo-2024']);
});

test('viewForTag humanizes the tag into a title and derives the earliest date from EXIF, with no authored metadata involved', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', ['paris-2025'], '2025-08-28T10:00:00'),
    stubPhoto('002.tif', ['paris-2025'], '2025-08-27T09:00:00'),
  ]);
  const view = viewForTag(archive, 'paris-2025');
  assert.equal(view.title, 'Paris 2025');
  assert.equal(view.date, '2025-08-27');
  assert.equal(view.photos.length, 2);
});

test('viewForTag throws for a tag nothing carries', () => {
  const archive = archiveOf([stubPhoto('001.tif', ['paris-2025'])]);
  assert.throws(() => viewForTag(archive, 'nowhere'), /No photographs are tagged "nowhere"/);
});
