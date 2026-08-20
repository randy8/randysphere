import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { decodeIds, findSharePreview } from './share-preview.ts';

const ID_A = '0123456789abcdef';
const ID_B = 'fedcba9876543210';
const ID_MISSING = '1111111111111111';

// Same fixed-width byte-packing scheme site/src/photography/share-code.ts's
// encodeIds uses — reimplemented here (not imported, same cross-workspace
// boundary share-preview.ts itself respects) purely to build test input.
function encodeIdsForTest(ids: readonly string[]): string {
  const bytes = new Uint8Array(ids.length * 8);
  ids.forEach((id, index) => {
    for (let i = 0; i < 8; i += 1) {
      bytes[index * 8 + i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
    }
  });
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fixtureAlbumsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'share-preview-'));
  const albumsDir = join(root, 'albums');
  await mkdir(albumsDir, { recursive: true });
  await writeFile(
    join(albumsDir, 'test.json'),
    JSON.stringify({
      schemaVersion: 2,
      slug: 'test',
      photos: [
        {
          sourceId: ID_A,
          og: { format: 'jpeg', width: 1200, height: 630, bytes: 1000, key: `p/${ID_A}/og-1.jpg` },
        },
        {
          sourceId: ID_B,
          og: { format: 'jpeg', width: 1200, height: 630, bytes: 1000, key: `p/${ID_B}/og-2.jpg` },
        },
      ],
    }),
  );
  return albumsDir;
}

test('decodeIds round-trips a list encoded the same way share-code.ts does', () => {
  assert.deepEqual(decodeIds(encodeIdsForTest([ID_A, ID_B])), [ID_A, ID_B]);
});

test('a link naming one real photograph resolves to its own OG crop', async () => {
  const albumsDir = await fixtureAlbumsDir();
  const preview = await findSharePreview(albumsDir, encodeIdsForTest([ID_A]));
  assert.deepEqual(preview, { imagePath: `/p/${ID_A}/og-1.jpg`, width: 1200, height: 630, count: 1 });
});

test('the first valid id wins when several are shared, in order', async () => {
  const albumsDir = await fixtureAlbumsDir();
  const preview = await findSharePreview(albumsDir, encodeIdsForTest([ID_B, ID_A]));
  assert.equal(preview?.imagePath, `/p/${ID_B}/og-2.jpg`);
  assert.equal(preview?.count, 2);
});

test('a bogus id among valid ones is skipped, but still counted out of the total', async () => {
  const albumsDir = await fixtureAlbumsDir();
  const preview = await findSharePreview(albumsDir, encodeIdsForTest([ID_MISSING, ID_A]));
  assert.equal(preview?.imagePath, `/p/${ID_A}/og-1.jpg`);
  assert.equal(preview?.count, 1);
});

test('an all-bogus link resolves to null', async () => {
  const albumsDir = await fixtureAlbumsDir();
  const preview = await findSharePreview(albumsDir, encodeIdsForTest([ID_MISSING]));
  assert.equal(preview, null);
});

test('an empty or garbage ?s= resolves to null without throwing', async () => {
  const albumsDir = await fixtureAlbumsDir();
  assert.equal(await findSharePreview(albumsDir, ''), null);
  assert.equal(await findSharePreview(albumsDir, 'not valid base64url!!!'), null);
});

test('a missing albums directory resolves to null rather than throwing', async () => {
  const preview = await findSharePreview('/nonexistent/albums/dir', encodeIdsForTest([ID_A]));
  assert.equal(preview, null);
});
