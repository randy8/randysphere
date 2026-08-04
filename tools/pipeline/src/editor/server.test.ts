import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { syncPhotosFile } from '../album-files.ts';
import { formatJson, writeFileAtomic } from '../files.ts';
import type { AlbumManifest, PhotoRecord, VariantRecord } from '../manifest.ts';
import type { Paths } from '../paths.ts';
import { derivativePath, resolvePaths } from '../paths.ts';
import { createEditorServer, isSafeRelativePath } from './server.ts';

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

function photo(file: string): PhotoRecord {
  return {
    file,
    roll: '.',
    sourceId: 'aaaaaaaaaaaaaaaa',
    width: 1600,
    height: 1200,
    color: '#808080',
    lqip: 'data:image/webp;base64,AA==',
    camera: null,
    variants: [variant(400), variant(1600)],
    og: ogVariant(),
  };
}

let paths: Paths;
let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'photo-editor-server-'));
  paths = resolvePaths(root);
  await mkdir(paths.manifests, { recursive: true });
  const albumDirectory = join(paths.albums, 'paris-2025');
  await mkdir(albumDirectory, { recursive: true });
  const manifest: AlbumManifest = {
    schemaVersion: 2,
    slug: 'paris-2025',
    photos: [photo('001.jpg')],
    rolls: [{ id: '.', photoCount: 1 }],
  };
  await writeFileAtomic(join(paths.manifests, 'paris-2025.json'), formatJson(manifest));
  await syncPhotosFile(
    albumDirectory,
    [{ file: '001.jpg', sourceId: 'aaaaaaaaaaaaaaaa' }],
    'paris-2025',
  );

  const derivative = derivativePath(paths, 'p/0123456789abcdef/400-01234567.webp');
  await mkdir(join(derivative, '..'), { recursive: true });
  await writeFile(derivative, 'fake-webp-bytes');

  const server = createEditorServer(paths);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

after(async () => {
  await close();
});

test('GET /api/photos returns the joined photo list', async () => {
  const response = await fetch(`${baseUrl}/api/photos`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { photos: { file: string; tags: string[] }[] };
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0]?.file, '001.jpg');
  assert.deepEqual(body.photos[0]?.tags, ['paris-2025']);
});

test('POST /api/cover sets the album cover and GET /api/photos reflects it', async () => {
  await writeFileAtomic(
    join(paths.albums, 'paris-2025', 'album.md'),
    "---\ntitle: Paris 2025\ndate: '2025-01-01'\nlocation: ''\ndescription: ''\nfeatured: false\ncover: 001.jpg\n---\n",
  );

  const response = await fetch(`${baseUrl}/api/cover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ album: 'paris-2025', file: '001.jpg' }),
  });
  assert.equal(response.status, 200);

  const photosResponse = await fetch(`${baseUrl}/api/photos`);
  const { photos } = (await photosResponse.json()) as {
    photos: { file: string; cover: boolean }[];
  };
  assert.equal(photos.find((p) => p.file === '001.jpg')?.cover, true);
});

test('GET /api/tags returns the tag vocabulary', async () => {
  const response = await fetch(`${baseUrl}/api/tags`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { tags: { tag: string; count: number }[] };
  assert.deepEqual(body.tags, [{ tag: 'paris-2025', count: 1 }]);
});

test('POST /api/edits applies a batch edit and returns 200', async () => {
  const photosResponse = await fetch(`${baseUrl}/api/photos`);
  const { albumVersions } = (await photosResponse.json()) as {
    albumVersions: Record<string, string>;
  };

  const response = await fetch(`${baseUrl}/api/edits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['street'] }],
      expectedVersions: albumVersions,
    }),
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test('POST /api/edits returns 409 with a conflict when the version is stale', async () => {
  const photosResponse = await fetch(`${baseUrl}/api/photos`);
  const { albumVersions } = (await photosResponse.json()) as {
    albumVersions: Record<string, string>;
  };

  // Apply once to move the album's real version forward...
  await fetch(`${baseUrl}/api/edits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['night'] }],
      expectedVersions: albumVersions,
    }),
  });

  // ...then retry with the now-stale version captured before that call.
  const response = await fetch(`${baseUrl}/api/edits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      edits: [{ album: 'paris-2025', file: '001.jpg', addTags: ['dawn'] }],
      expectedVersions: albumVersions,
    }),
  });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { ok: boolean; conflicts: { album: string }[] };
  assert.equal(body.ok, false);
  assert.equal(body.conflicts[0]?.album, 'paris-2025');
});

test('GET /media/<key> streams the derivative straight off disk', async () => {
  const response = await fetch(`${baseUrl}/media/p/0123456789abcdef/400-01234567.webp`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  assert.equal(await response.text(), 'fake-webp-bytes');
});

test('isSafeRelativePath rejects any ".." segment and accepts an ordinary relative path', () => {
  // `fetch()` itself collapses dot-segments before a request is ever sent
  // (per the WHATWG URL Standard), so this guard can't be exercised through
  // an actual HTTP round trip — it's tested directly instead.
  assert.equal(isSafeRelativePath('../etc/passwd'), false);
  assert.equal(isSafeRelativePath('p/0123456789abcdef/..'), false);
  assert.equal(isSafeRelativePath(''), false);
  assert.equal(isSafeRelativePath('p/0123456789abcdef/400-01234567.webp'), true);
});

test('GET / serves the static index page', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
});

test('an unknown route returns 404', async () => {
  const response = await fetch(`${baseUrl}/nope`);
  assert.equal(response.status, 404);
});
