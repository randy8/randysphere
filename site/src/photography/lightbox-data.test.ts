import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArchivePhoto } from './archive.ts';
import { lightboxJson, lightboxPhoto } from './lightbox-data.ts';
import type { Photo, Variant, VariantFormat } from './manifest.ts';

function variant(format: VariantFormat, width: number): Variant {
  return {
    format,
    width,
    height: Math.round(width / 1.5),
    bytes: 1000,
    key: `p/0123456789abcdef/${String(width)}-aaaaaaaa.${format === 'jpeg' ? 'jpg' : format}`,
  };
}

function entry(variants: Variant[], overrides: Partial<ArchivePhoto> = {}): ArchivePhoto {
  const photo: Photo = {
    file: '001.tif',
    roll: '0827',
    sourceId: '0123456789abcdef',
    width: 3000,
    height: 2000,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera: null,
    variants,
    og: variants[0] as Variant,
  };
  return {
    photo,
    batch: 'test-batch',
    roll: { id: '0827', photoCount: 1, filmStock: 'portra400', notes: '', date: null },
    frame: 1,
    tags: [],
    alt: 'A street in the rain',
    caption: 'Rue de Rivoli',
    location: null,
    rating: 1,
    featuredOrder: null,
    cover: false,
    ...overrides,
  };
}

const ALL = [
  variant('avif', 1280),
  variant('avif', 2560),
  variant('webp', 1280),
  variant('webp', 2560),
  variant('jpeg', 1280),
  variant('jpeg', 2560),
];

test('carries every srcset, smallest JPEG as src, and what describes the photograph', () => {
  const data = lightboxPhoto(entry(ALL));
  assert.equal(data.id, '0123456789abcdef');
  assert.match(data.avif ?? '', /1280-aaaaaaaa\.avif 1280w, .*2560-aaaaaaaa\.avif 2560w$/);
  assert.match(data.webp ?? '', /2560w$/);
  assert.match(data.jpeg ?? '', /1280w, .*2560w$/);
  assert.match(data.src, /1280-aaaaaaaa\.jpg$/);
  assert.deepEqual([data.width, data.height, data.color], [3000, 2000, '#6b7a82']);
  assert.deepEqual(
    [data.alt, data.filmStock, data.caption, data.camera],
    ['A street in the rain', 'portra400', 'Rue de Rivoli', null],
  );
});

test('maxWidth drops the larger tier, exactly as Photo.astro does', () => {
  const data = lightboxPhoto(entry(ALL), 1920);
  assert.doesNotMatch(`${data.avif ?? ''} ${data.webp ?? ''} ${data.jpeg ?? ''}`, /2560/);
});

test('a single JPEG width is a src with no srcset, and a missing format is null', () => {
  const data = lightboxPhoto(entry([variant('jpeg', 1280)]));
  assert.equal(data.jpeg, null);
  assert.equal(data.avif, null);
  assert.equal(data.webp, null);
  assert.match(data.src, /1280-aaaaaaaa\.jpg$/);
});

test('no film stock noted is null, not an empty link', () => {
  const data = lightboxPhoto(
    entry(ALL, {
      roll: { id: '0827', photoCount: 1, filmStock: '', notes: '', date: null },
    }),
  );
  assert.equal(data.filmStock, null);
});

test('the JSON can never close its own <script> element', () => {
  const json = lightboxJson([lightboxPhoto(entry(ALL, { caption: '</script><b>x</b>' }))]);
  assert.doesNotMatch(json, /</);
  const [parsed] = JSON.parse(json) as { caption: string }[];
  assert.equal(parsed?.caption, '</script><b>x</b>');
});
