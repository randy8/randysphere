import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allFilmStocks,
  allTags,
  byFilmStock,
  byTag,
  coverPhoto,
  joinBatch,
  joinRolls,
  selectedWork,
  viewForFilmStock,
  viewForTag,
} from './archive.ts';
import type { Archive, ArchivePhoto } from './archive.ts';
import type { AlbumManifest, Photo, Variant } from './manifest.ts';

const VARIANT: Variant = {
  format: 'avif',
  width: 400,
  height: 267,
  bytes: 1000,
  key: 'p/aaaaaaaaaaaaaaaa/400-11111111.avif',
};

function photo(file: string, roll: string, takenAt: string | null = null): Photo {
  return {
    file,
    roll,
    sourceId: file,
    width: 1800,
    height: 1200,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera:
      takenAt === null
        ? null
        : {
            make: null,
            model: null,
            lens: null,
            focalLength: null,
            aperture: null,
            shutterSpeed: null,
            iso: null,
            takenAt,
          },
    variants: [VARIANT],
    og: VARIANT,
  };
}

function manifest(
  photos: readonly Photo[],
  rolls: readonly { id: string; photoCount: number }[],
): AlbumManifest {
  return { schemaVersion: 2, slug: 'test-batch', photos, rolls };
}

test('joinRolls preserves manifest roll order and carries photoCount through', () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0828/001.tif', '0828')],
    [
      { id: '0827', photoCount: 1 },
      { id: '0828', photoCount: 1 },
    ],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  assert.deepEqual(
    rolls.map((r) => r.id),
    ['0827', '0828'],
  );
  assert.equal(rolls[0]?.photoCount, 1);
});

test('joinRolls throws when rolls.yaml references a roll the manifest does not have', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  assert.throws(
    () => joinRolls(m, [{ id: '9999' }], 'test-batch'),
    /rolls\.yaml lists roll "9999"/,
  );
});

test('joinBatch assigns a 1-based frame per roll, derived from manifest order, not stored anywhere', () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0827/002.tif', '0827'), photo('0828/001.tif', '0828')],
    [
      { id: '0827', photoCount: 2 },
      { id: '0828', photoCount: 1 },
    ],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch', null);
  assert.equal(photos.find((p) => p.photo.file === '0827/001.tif')?.frame, 1);
  assert.equal(photos.find((p) => p.photo.file === '0827/002.tif')?.frame, 2);
  assert.equal(photos.find((p) => p.photo.file === '0828/001.tif')?.frame, 1);
});

test('joinBatch carries per-photo tags from photos.yaml through untouched', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(
    m,
    [{ file: '0827/001.tif', tags: ['paris-2025', 'street'] }],
    rolls,
    'test-batch',
    null,
  );
  assert.deepEqual(photos[0]?.tags, ['paris-2025', 'street']);
});

test('joinBatch defaults tags to an empty list when photos.yaml has none for a photo', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch', null);
  assert.deepEqual(photos[0]?.tags, []);
});

test('joinBatch carries per-photo location from photos.yaml through untouched', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(
    m,
    [{ file: '0827/001.tif', location: 'Rue de Bretagne, Paris' }],
    rolls,
    'test-batch',
    null,
  );
  assert.equal(photos[0]?.location, 'Rue de Bretagne, Paris');
});

test('joinBatch defaults location to null when photos.yaml has none for a photo', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch', null);
  assert.equal(photos[0]?.location, null);
});

test('joinBatch throws if a photo belongs to a roll missing from the rolls list', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  assert.throws(
    () => joinBatch(m, [], [], 'test-batch', null),
    /belongs to roll "0827", which is not in the manifest's rolls list/,
  );
});

test('joinBatch reads featured and featuredOrder per photo from photos.yaml, not per batch', () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0827/002.tif', '0827')],
    [{ id: '0827', photoCount: 2 }],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(
    m,
    [{ file: '0827/001.tif', featured: true, featuredOrder: 2 }, { file: '0827/002.tif' }],
    rolls,
    'test-batch',
    null,
  );
  const first = photos.find((p) => p.photo.file === '0827/001.tif');
  const second = photos.find((p) => p.photo.file === '0827/002.tif');
  assert.equal(first?.featured, true);
  assert.equal(first?.featuredOrder, 2);
  assert.equal(second?.featured, false);
  assert.equal(second?.featuredOrder, null);
});

test("joinBatch marks only the photo named by album.md's cover field, presentation order independent of frame order", () => {
  const m = manifest(
    [photo('0827/001.tif', '0827'), photo('0827/002.tif', '0827')],
    [{ id: '0827', photoCount: 2 }],
  );
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch', '0827/002.tif');
  assert.equal(photos.find((p) => p.photo.file === '0827/001.tif')?.cover, false);
  assert.equal(photos.find((p) => p.photo.file === '0827/002.tif')?.cover, true);
});

test('joinBatch leaves every photo uncovered when album.md names a file that no longer matches one (stale, not a build error)', () => {
  const m = manifest([photo('0827/001.tif', '0827')], [{ id: '0827', photoCount: 1 }]);
  const rolls = joinRolls(m, [], 'test-batch');
  const photos = joinBatch(m, [], rolls, 'test-batch', '0827/999.tif');
  assert.equal(photos[0]?.cover, false);
});

function archiveOf(photos: readonly ArchivePhoto[]): Archive {
  return { photos };
}

function stubPhoto(
  file: string,
  tags: readonly string[],
  takenAt: string | null = null,
  featured = false,
  rollId = '0827',
  cover = false,
  frame = 1,
  featuredOrder: number | null = null,
  filmStock = '',
): ArchivePhoto {
  return {
    photo: photo(file, rollId, takenAt),
    batch: 'test-batch',
    roll: { id: rollId, photoCount: 1, filmStock, notes: '', date: null },
    frame,
    tags,
    alt: '',
    caption: null,
    location: null,
    featured,
    featuredOrder,
    cover,
  };
}

test('a photo tagged with multiple values appears in every matching query, as the same record', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', ['paris-2025', 'street']),
    stubPhoto('002.tif', ['paris-2025']),
  ]);
  const paris = byTag(archive, 'paris-2025');
  const street = byTag(archive, 'street');
  assert.equal(paris.length, 2);
  assert.equal(street.length, 1);
  // Same underlying photo object in both views — not duplicated.
  assert.equal(
    paris.find((p) => p.tags.includes('street')),
    street[0],
  );
});

test('allTags is the union of every photo\'s tags, deduplicated and sorted, with no separate "trips" list', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', ['paris-2025', 'street']),
    stubPhoto('002.tif', ['tokyo-2024']),
  ]);
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

test('byFilmStock queries roll-level film stock, not a tag', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', [], null, false, '0827', false, 1, null, 'portra400'),
    stubPhoto('002.tif', [], null, false, '0828', false, 1, null, 'ektar100'),
  ]);
  assert.deepEqual(
    byFilmStock(archive, 'portra400').map((p) => p.photo.file),
    ['001.tif'],
  );
});

test('allFilmStocks excludes rolls with no film stock noted yet, rather than listing ""', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', [], null, false, '0827', false, 1, null, 'portra400'),
    stubPhoto('002.tif', [], null, false, '0828', false, 1, null, ''),
  ]);
  assert.deepEqual(allFilmStocks(archive), ['portra400']);
});

test('viewForFilmStock throws for a stock nothing was shot on', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', [], null, false, '0827', false, 1, null, 'portra400'),
  ]);
  assert.throws(() => viewForFilmStock(archive, 'nowhere'), /No photographs are shot on "nowhere"/);
});

test('coverPhoto defaults to the chronologically first photo — presentation order falls back to archival order', () => {
  const first = stubPhoto('001.tif', [], null, false, '0827', false, 1);
  const second = stubPhoto('002.tif', [], null, false, '0827', false, 2);
  assert.equal(coverPhoto([first, second]), first);
});

test('coverPhoto prefers a manually chosen cover over the chronologically first photo — presentation order independent of archival order', () => {
  const first = stubPhoto('001.tif', [], null, false, '0827', false, 1);
  const chosen = stubPhoto('002.tif', [], null, false, '0827', true, 2);
  assert.equal(coverPhoto([first, chosen]), chosen);
});

test('coverPhoto throws for an empty view', () => {
  assert.throws(() => coverPhoto([]), /This view has no photographs/);
});

test('selectedWork includes only photos marked featured, archive-wide, regardless of tag', () => {
  const archive = archiveOf([
    stubPhoto('001.tif', ['paris-2025'], null, true),
    stubPhoto('002.tif', ['tokyo-2024'], null, false),
    stubPhoto('003.tif', [], null, true),
  ]);
  assert.deepEqual(
    selectedWork(archive).map((p) => p.photo.file),
    ['001.tif', '003.tif'],
  );
});

test('selectedWork sorts by featuredOrder, a deliberate sequence rather than chronology', () => {
  const early = stubPhoto('early.tif', [], '2025-01-01', true, '0827', false, 1, 2);
  const late = stubPhoto('late.tif', [], '2025-12-01', true, '0827', false, 2, 1);
  const archive = archiveOf([early, late]);
  assert.deepEqual(
    selectedWork(archive).map((p) => p.photo.file),
    ['late.tif', 'early.tif'],
  );
});

test('selectedWork places photos with no featuredOrder after every ordered one, in archival order', () => {
  const ordered = stubPhoto('ordered.tif', [], null, true, '0827', false, 2, 1);
  const unordered = stubPhoto('unordered.tif', [], null, true, '0827', false, 1, null);
  const archive = archiveOf([unordered, ordered]);
  assert.deepEqual(
    selectedWork(archive).map((p) => p.photo.file),
    ['ordered.tif', 'unordered.tif'],
  );
});
