import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatPostedAt, loadTracks, toEmbed } from './music.ts';

test('toEmbed rewrites a Spotify track link to its embed URL', () => {
  assert.deepEqual(toEmbed('https://open.spotify.com/track/1DwscornXpj8fmOmYVlqZt'), {
    platform: 'spotify',
    embedUrl: 'https://open.spotify.com/embed/track/1DwscornXpj8fmOmYVlqZt',
  });
});

test('toEmbed ignores a Spotify link query string (e.g. ?si=...)', () => {
  assert.deepEqual(toEmbed('https://open.spotify.com/track/abc123?si=xyz'), {
    platform: 'spotify',
    embedUrl: 'https://open.spotify.com/embed/track/abc123',
  });
});

test('toEmbed rewrites a Spotify playlist link', () => {
  assert.deepEqual(toEmbed('https://open.spotify.com/playlist/0m7tRdL2elzHLDFjhPGbAx'), {
    platform: 'spotify',
    embedUrl: 'https://open.spotify.com/embed/playlist/0m7tRdL2elzHLDFjhPGbAx',
  });
});

test('toEmbed rewrites a youtube.com watch link', () => {
  assert.deepEqual(toEmbed('https://www.youtube.com/watch?v=lIxQe1R5hs0'), {
    platform: 'youtube',
    embedUrl: 'https://www.youtube.com/embed/lIxQe1R5hs0',
  });
});

test('toEmbed rewrites a youtu.be short link', () => {
  assert.deepEqual(toEmbed('https://youtu.be/lIxQe1R5hs0'), {
    platform: 'youtube',
    embedUrl: 'https://www.youtube.com/embed/lIxQe1R5hs0',
  });
});

test('toEmbed rewrites a youtube.com/shorts link', () => {
  assert.deepEqual(toEmbed('https://www.youtube.com/shorts/lIxQe1R5hs0'), {
    platform: 'youtube',
    embedUrl: 'https://www.youtube.com/embed/lIxQe1R5hs0',
  });
});

test('toEmbed returns null for an unrecognized host', () => {
  assert.equal(toEmbed('https://soundcloud.com/someone/a-track'), null);
});

test('toEmbed returns null for a malformed URL', () => {
  assert.equal(toEmbed('not a url'), null);
});

test('formatPostedAt reads a plain ISO date as a short display date', () => {
  assert.equal(formatPostedAt('2026-08-13'), 'Aug 13, 2026');
});

test('formatPostedAt leaves a non-ISO string unchanged', () => {
  assert.equal(formatPostedAt(''), '');
});

test('loadTracks reads the real committed file and every entry has a valid embed', () => {
  const tracks = loadTracks();
  assert.ok(tracks.length > 0, 'expected at least one track in music/tracks.yaml');
  for (const track of tracks) {
    assert.ok(track.url.startsWith('https://'));
    assert.ok(track.embedUrl.startsWith('https://'));
    assert.ok(track.platform === 'spotify' || track.platform === 'youtube');
  }
});
