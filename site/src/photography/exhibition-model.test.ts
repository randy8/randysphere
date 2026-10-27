import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadArchive, selectedWork } from './archive.ts';
import { exhibitionData } from './exhibition-data.ts';
import {
  DEFAULTS,
  defaultOrder,
  drift,
  fitBox,
  labelOf,
  MOTION_SCALE,
  Playlist,
  readSettings,
  readSource,
  returnHref,
  selectPhotos,
  shuffle,
  titleOf,
  writeSettings,
} from './exhibition-model.ts';
import type { ExhibitionPhoto } from './exhibition-model.ts';
import { encodeIds } from './share-code.ts';

const photo = (id: string, extra: Partial<ExhibitionPhoto> = {}): ExhibitionPhoto => ({
  id,
  avif: null,
  webp: null,
  jpeg: null,
  src: `/p/${id}.jpg`,
  width: 3000,
  height: 2000,
  color: '#000',
  alt: '',
  filmStock: null,
  filmStockName: null,
  frame: 1,
  caption: null,
  camera: null,
  tags: [],
  places: [],
  date: null,
  weight: 1,
  ...extra,
});

const PHOTOS = [
  photo('aaaaaaaa00000001', { tags: ['paris-2025'], filmStock: 'Portra 400' }),
  photo('bbbbbbbb00000002', { tags: ['paris-2025'], filmStock: 'Gold 200' }),
  photo('cccccccc00000003', { tags: ['tokyo'], filmStock: 'Portra 400' }),
];
const ids = (photos: readonly ExhibitionPhoto[]): string[] => photos.map((entry) => entry.id);
const params = (query: string): URLSearchParams => new URLSearchParams(query);

test('no source: everything, in the order given (Selected Work)', () => {
  assert.deepEqual(ids(selectPhotos(PHOTOS, readSource(params('')))), ids(PHOTOS));
});

test('tag and film narrow, and combine', () => {
  assert.deepEqual(ids(selectPhotos(PHOTOS, readSource(params('tag=paris-2025')))), [
    'aaaaaaaa00000001',
    'bbbbbbbb00000002',
  ]);
  assert.deepEqual(ids(selectPhotos(PHOTOS, readSource(params('film=Portra+400')))), [
    'aaaaaaaa00000001',
    'cccccccc00000003',
  ]);
  assert.deepEqual(
    ids(selectPhotos(PHOTOS, readSource(params('tag=paris-2025&film=Portra%20400')))),
    ['aaaaaaaa00000001'],
  );
});

test("a share code plays exactly its photographs, in its sender's order, and wins over tag/film", () => {
  const code = encodeIds(['cccccccc00000003', 'aaaaaaaa00000001']);
  const source = readSource(params(`p=${code}&tag=paris-2025`));
  assert.deepEqual(ids(selectPhotos(PHOTOS, source)), ['cccccccc00000003', 'aaaaaaaa00000001']);
  assert.equal(defaultOrder(source), 'sequence');
  assert.equal(returnHref(source), `/exposures/share/?p=${code}`);
});

test('a share code naming nothing public shows nothing — never the whole archive', () => {
  const source = readSource(params(`p=${encodeIds(['ffffffff00000000'])}`));
  assert.deepEqual(selectPhotos(PHOTOS, source), []);
  assert.deepEqual(selectPhotos(PHOTOS, readSource(params('p=zz'))), []);
  assert.deepEqual(selectPhotos(PHOTOS, readSource(params('p='))), PHOTOS);
});

test('titles and the way back follow the source', () => {
  const titles = { 'paris-2025': 'Paris 2025' };
  assert.equal(titleOf(readSource(params('')), titles), null);
  assert.equal(titleOf(readSource(params('tag=paris-2025')), titles), 'Paris 2025');
  assert.equal(
    titleOf(readSource(params('tag=paris-2025&film=Gold+200')), titles),
    'Paris 2025 · Gold 200',
  );
  assert.equal(returnHref(readSource(params(''))), '/exposures/');
  assert.equal(returnHref(readSource(params('tag=paris-2025'))), '/exposures/paris-2025/');
  assert.equal(returnHref(readSource(params('film=Portra+400'))), '/exposures/film/Portra%20400/');
  assert.equal(returnHref(readSource(params('tag=a&film=b'))), '/exposures/');
});

test('settings: URL over preferences over defaults; anything off the menu is ignored', () => {
  assert.deepEqual(readSettings(params(''), {}, 'shuffle'), { ...DEFAULTS, order: 'shuffle' });
  assert.deepEqual(
    readSettings(
      params('slide=20&motion=0&order=sequence'),
      { slide: 12, fade: 4, info: true },
      'shuffle',
    ),
    { slide: 20, fade: 4, motion: false, info: true, order: 'sequence' },
  );
  const junk = readSettings(params('slide=7&fade=abc&order=sideways'), { slide: 999 }, 'shuffle');
  assert.equal(junk.slide, DEFAULTS.slide);
  assert.equal(junk.fade, DEFAULTS.fade);
  assert.equal(junk.order, 'shuffle');
  // Preferences come from localStorage, so they're as untrusted as the URL.
  const stored = readSettings(params(''), { motion: 'yes' as unknown as boolean }, 'shuffle');
  assert.equal(stored.motion, DEFAULTS.motion);
});

test('settings round-trip through the URL, writing only what differs from the defaults', () => {
  const url = new URL('https://example.test/exposures/exhibition/?tag=paris-2025');
  writeSettings(url, { ...DEFAULTS, order: 'shuffle' }, 'shuffle');
  assert.equal(url.search, '?tag=paris-2025');
  const custom = { slide: 30, fade: 4, motion: false, info: true, order: 'sequence' as const };
  writeSettings(url, custom, 'shuffle');
  assert.deepEqual(readSettings(url.searchParams, {}, 'shuffle'), custom);
  assert.equal(url.searchParams.get('tag'), 'paris-2025');
});

test('in sequence, the playlist loops in order and steps back', () => {
  const list = new Playlist([1, 1, 1], 'sequence');
  assert.equal(list.current, 0);
  assert.equal(list.peek(), 1);
  assert.deepEqual([list.next(), list.next(), list.next()], [1, 2, 0]);
  assert.equal(list.previous(), 2);
  list.seek(1);
  assert.equal(list.current, 1);
});

test('shuffled, every photograph shows once per round, and a round never opens on the one before it', () => {
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const list = new Playlist([1, 1.5, 2, 3, 1], 'shuffle', random);
  for (let round = 0; round < 50; round += 1) {
    const seen = [list.current];
    for (let i = 1; i < 5; i += 1) seen.push(list.next());
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
    const last = list.current;
    const peeked = list.peek();
    assert.notEqual(peeked, last);
    assert.equal(list.next(), peeked, 'peek names the photograph next() moves to');
  }
});

test('a weighted shuffle favours the heavier photograph in proportion, never always', () => {
  let seed = 11;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  // Two photographs, 3× against 1×: the heavier leads 3/4 of the time.
  let heavierFirst = 0;
  const runs = 4000;
  for (let run = 0; run < runs; run += 1) {
    const [first] = shuffle(['great', 'unrated'], (item) => (item === 'great' ? 3 : 1), random);
    if (first === 'great') heavierFirst += 1;
  }
  assert.ok(
    Math.abs(heavierFirst / runs - 0.75) < 0.03,
    `${String(heavierFirst)} of ${String(runs)}`,
  );
});

test('a single photograph is its own next', () => {
  const list = new Playlist([1], 'shuffle');
  assert.equal(list.peek(), 0);
  assert.equal(list.next(), 0);
});

test('fitBox contains, never crops', () => {
  assert.deepEqual(fitBox(3000, 2000, 1600, 900), { width: 1350, height: 900 });
  assert.deepEqual(fitBox(2000, 3000, 1600, 900), { width: 600, height: 900 });
  assert.deepEqual(fitBox(6000, 1000, 1600, 900), { width: 1600, height: 266 });
});

test('the drift stays within its scale, about an origin near the middle', () => {
  for (let i = 0; i < 200; i += 1) {
    const path = drift();
    assert.ok(
      path.from >= 1 && path.from <= MOTION_SCALE && path.to >= 1 && path.to <= MOTION_SCALE,
    );
    assert.notEqual(path.from, path.to);
    assert.ok(path.x >= 30 && path.x <= 70 && path.y >= 30 && path.y <= 70);
    // The most it grows on any one side, as a share of the frame — the
    // margin in exhibition.css (6vw/6vh) must stay wider than this.
    assert.ok((MOTION_SCALE - 1) * (Math.max(path.x, path.y) / 100) < 0.06);
  }
});

test('the wall label lists only what a photograph has', () => {
  const format = (iso: string): string => `[${iso}]`;
  assert.deepEqual(
    labelOf(photo('a', { filmStock: 'Portra 400', places: ['Paris'], date: '2025-08-27' }), format),
    ['Portra 400', 'Paris', '[2025-08-27]'],
  );
  assert.deepEqual(labelOf(photo('a'), format), []);
});

test('the real payload carries only public photographs, in Selected Work order, with every tag titled', () => {
  const archive = loadArchive();
  const data = exhibitionData(archive, selectedWork(archive));
  assert.deepEqual(
    data.photos.map((entry) => entry.id),
    selectedWork(archive).map((entry) => entry.photo.sourceId),
  );
  for (const entry of data.photos) {
    for (const tag of entry.tags) assert.ok(data.titles[tag], `${tag} has a title`);
  }
});
