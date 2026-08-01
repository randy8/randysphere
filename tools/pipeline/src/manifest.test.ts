import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  albumKeyDigest,
  albumKeys,
  readAlbumManifest,
  SCHEMA_VERSION,
  validateAlbumManifest,
  writeAlbumManifest,
} from './manifest.ts';
import type { AlbumManifest } from './manifest.ts';

const KEY = 'p/0123456789abcdef/1200-1a2b3c4d.avif';
const OG_KEY = 'p/0123456789abcdef/og-99887766.jpg';

const manifest: AlbumManifest = {
  schemaVersion: SCHEMA_VERSION,
  slug: 'hokkaido-winter',
  photos: [
    {
      file: '001.jpg',
      roll: '.',
      sourceId: '0123456789abcdef',
      width: 6000,
      height: 4000,
      color: '#6b7a82',
      lqip: 'data:image/webp;base64,AAAA',
      camera: null,
      variants: [{ format: 'avif', width: 1200, height: 800, bytes: 40_000, key: KEY }],
      og: { format: 'jpeg', width: 1200, height: 630, bytes: 90_000, key: OG_KEY },
    },
  ],
  rolls: [{ id: '.', photoCount: 1 }],
};

test('a valid manifest round-trips through disk unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-manifest-'));
  const path = join(directory, 'hokkaido-winter.json');
  await writeAlbumManifest(path, manifest);
  assert.deepEqual(await readAlbumManifest(path), manifest);
});

test('validation names the exact path of the problem', () => {
  const broken = structuredClone(manifest) as unknown as {
    photos: { variants: { key: string }[] }[];
  };
  broken.photos[0]!.variants[0]!.key = 'p/nope/1200.avif';
  assert.throws(
    () => validateAlbumManifest(broken, 'generated/albums/hokkaido-winter.json'),
    /photos\[0\]\.variants\[0\]\.key is not a valid derivative key/,
  );
});

test('a manifest from a newer pipeline is refused rather than guessed at', () => {
  assert.throws(
    () => validateAlbumManifest({ ...manifest, schemaVersion: 99 }, 'x.json'),
    /written by a newer pipeline/,
  );
});

test('a manifest from an older schema is refused with instructions', () => {
  assert.throws(
    () => validateAlbumManifest({ ...manifest, schemaVersion: 0 }, 'x.json'),
    /must be a positive/,
  );
});

test('a slug that would not survive a URL is refused', () => {
  assert.throws(
    () => validateAlbumManifest({ ...manifest, slug: 'Hokkaido Winter' }, 'x.json'),
    /URL slug/,
  );
  assert.throws(() => validateAlbumManifest({ ...manifest, slug: '../etc' }, 'x.json'), /URL slug/);
});

test('key digests cover every variant and the open graph crop', () => {
  assert.deepEqual(albumKeys(manifest).sort(), [KEY, OG_KEY].sort());

  const changed = structuredClone(manifest) as unknown as { photos: { og: { key: string } }[] };
  changed.photos[0]!.og.key = 'p/0123456789abcdef/og-11111111.jpg';
  assert.notEqual(albumKeyDigest(manifest), albumKeyDigest(changed as unknown as AlbumManifest));
});

test('the digest ignores the order photographs happen to be in', () => {
  const reversed: AlbumManifest = { ...manifest, photos: [...manifest.photos].reverse() };
  assert.equal(albumKeyDigest(manifest), albumKeyDigest(reversed));
});

test('a photo naming a roll that is not in the top-level roll list still validates (rolls are metadata, not a foreign key)', () => {
  assert.doesNotThrow(() => validateAlbumManifest(manifest, 'x.json'));
});

test('rolls must be an array', () => {
  const broken = { ...manifest, rolls: undefined };
  assert.throws(() => validateAlbumManifest(broken, 'x.json'), /rolls must be an array/);
});

test('a roll missing photoCount names the exact path', () => {
  const broken = { ...manifest, rolls: [{ id: '.' }] };
  assert.throws(() => validateAlbumManifest(broken, 'x.json'), /rolls\[0\]\.photoCount/);
});
