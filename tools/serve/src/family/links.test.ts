import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanText,
  cleanUrl,
  decodeEntities,
  findLinks,
  previewable,
  previewableLinks,
} from './links.ts';

test('links are found as the page finds them, trailing punctuation left out', () => {
  assert.deepEqual(
    findLinks('看 https://example.com/a. and (www.example.org)，好吗').map((l) => [l.raw, l.url]),
    [
      ['https://example.com/a', 'https://example.com/a'],
      ['www.example.org', 'https://www.example.org/'],
    ],
  );
  assert.deepEqual(findLinks('no links here, javascript:alert(1)'), []);
});

test('tracking parameters are taken out; everything else is kept, and shown as written', () => {
  assert.equal(
    cleanUrl('https://example.com/p?id=7&utm_source=x&fbclid=y#top'),
    'https://example.com/p?id=7#top',
  );
  assert.equal(cleanUrl('https://youtu.be/abc?si=xyz&t=42'), 'https://youtu.be/abc?t=42');
  assert.equal(cleanUrl('https://x.com/a/status/1?s=20&t=abc'), 'https://x.com/a/status/1');
  // t on another site is meaningful (YouTube's start time), and kept.
  assert.equal(cleanUrl('ftp://example.com/'), null);
  // Shown as written unless something was taken out.
  const [plain, tracked] = findLinks('www.example.com and www.example.com/?gclid=1');
  assert.equal(plain?.text, 'www.example.com');
  assert.equal(tracked?.text, 'www.example.com/');
});

test('Spotify links of every kind become their canonical address, whatever the share decoration', () => {
  for (const kind of ['track', 'album', 'playlist', 'artist', 'episode', 'show']) {
    const item = previewable(
      cleanUrl(`https://open.spotify.com/intl-zh-CN/${kind}/4cOdK2wGLETKBW3PvgPWqT?si=a1b2`) ?? '',
    );
    assert.deepEqual(item, {
      provider: 'spotify',
      kind,
      url: `https://open.spotify.com/${kind}/4cOdK2wGLETKBW3PvgPWqT`,
    });
  }
  assert.equal(previewable('https://open.spotify.com/user/spotify'), null);
  assert.equal(previewable('https://open.spotify.com/track/short'), null);
  assert.equal(
    previewable('https://open.spotify.com.evil.example/track/4cOdK2wGLETKBW3PvgPWqT'),
    null,
  );
  assert.equal(previewable('https://example.com/'), null);
});

test('a message previews each link once, at most four', () => {
  const id = (n: number): string => `${String(n)}`.padStart(22, 'a');
  const body = [1, 1, 2, 3, 4, 5].map((n) => `https://open.spotify.com/track/${id(n)}`).join(' ');
  assert.deepEqual(
    previewableLinks(body).map((item) => item.url.slice(-1)),
    ['1', '2', '3', '4'],
  );
});

test('metadata from another site is made plain text: entities decoded, controls gone, length bounded', () => {
  assert.equal(
    decodeEntities('Tom &amp; Jerry &#x27;s &#39;1&#39; &bogus; &#0;'),
    "Tom & Jerry 's '1' &bogus; ",
  );
  assert.equal(cleanText('  a‮b\u0000c\n\nd  '), 'abc d');
  assert.equal(cleanText('👨‍👩‍👧 family'), '👨‍👩‍👧 family');
  assert.equal(cleanText('x'.repeat(300), 10), `${'x'.repeat(9)}…`);
  assert.equal(cleanText(42), '');
});

test('a long link is shown shortened; its href stays whole', () => {
  const [link] = findLinks('https://example.com/a/very/long/path/that/goes/on/and/on?id=1');
  assert.equal(link?.url, 'https://example.com/a/very/long/path/that/goes/on/and/on?id=1');
  assert.equal(link?.text, 'example.com/a/very/long/path/that/goes/…');
  assert.equal([...(link?.text ?? '')].length, 40);
});
