import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assetUrl, largest, smallest, srcset, variantsOf } from './image.ts';
import type { Photo, Variant } from './manifest.ts';

const KEY = 'p/0123456789abcdef/400-1a2b3c4d.avif';

function variant(format: Variant['format'], width: number, key: string): Variant {
  return { format, width, height: Math.round(width * 0.667), bytes: 1000, key };
}

const photo: Photo = {
  file: '001.jpg',
  roll: '.',
  sourceId: '0123456789abcdef',
  width: 1800,
  height: 1200,
  color: '#6b7a82',
  lqip: 'data:image/webp;base64,AAAA',
  camera: null,
  variants: [
    variant('avif', 800, 'p/0123456789abcdef/800-11111111.avif'),
    variant('avif', 400, 'p/0123456789abcdef/400-22222222.avif'),
    variant('jpeg', 1200, 'p/0123456789abcdef/1200-33333333.jpg'),
    variant('jpeg', 400, 'p/0123456789abcdef/400-44444444.jpg'),
  ],
  og: variant('jpeg', 1200, 'p/0123456789abcdef/og-55555555.jpg'),
};

test('an empty base produces a root-relative URL with exactly one slash', () => {
  assert.equal(assetUrl('', KEY), `/${KEY}`);
  assert.equal(assetUrl('', KEY).includes('//'), false);
});

test('a trailing slash on the base never becomes a double slash', () => {
  for (const base of [
    '',
    '/',
    '//',
    '/images',
    '/images/',
    'https://img.example.com',
    'https://img.example.com/',
  ]) {
    const url = assetUrl(base, KEY);
    const withoutScheme = url.replace(/^https?:\/\//, '');
    assert.equal(withoutScheme.includes('//'), false, `${base} -> ${url}`);
    assert.ok(url.endsWith(KEY), `${base} -> ${url}`);
  }
});

test('a leading slash on the key is not doubled either', () => {
  assert.equal(assetUrl('/images', `/${KEY}`), `/images/${KEY}`);
  assert.equal(assetUrl('', `//${KEY}`), `/${KEY}`);
});

test('variants come back sorted by width, per format', () => {
  assert.deepEqual(
    variantsOf(photo, 'avif').map((entry) => entry.width),
    [400, 800],
  );
  assert.deepEqual(
    variantsOf(photo, 'jpeg').map((entry) => entry.width),
    [400, 1200],
  );
  assert.deepEqual(variantsOf(photo, 'webp'), []);
});

test('srcset pairs each URL with its real width descriptor', () => {
  assert.equal(
    srcset('', variantsOf(photo, 'avif')),
    '/p/0123456789abcdef/400-22222222.avif 400w, /p/0123456789abcdef/800-11111111.avif 800w',
  );
});

test('the widest JPEG is what the no-JavaScript link opens', () => {
  assert.equal(largest(photo, 'jpeg')?.width, 1200);
  assert.equal(smallest(photo, 'jpeg')?.width, 400);
  assert.equal(largest(photo, 'webp'), undefined);
});

test('no generated URL ever references an original filename', () => {
  // Originals are addressed by digest and never published. If a filename from
  // originals/ appeared in a URL, the pipeline boundary would have leaked.
  const urls = [
    ...photo.variants.map((entry) => assetUrl('', entry.key)),
    assetUrl('', photo.og.key),
  ];
  for (const url of urls) {
    assert.equal(url.includes(photo.file), false, url);
    assert.ok(url.startsWith('/p/'), url);
  }
});
