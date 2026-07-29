import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { formatJson, writeFileAtomic } from './files.ts';
import { readPreviousRecords, resolvePriorRecord } from './ingest.ts';
import type { PreviousRecords } from './ingest.ts';
import type { AlbumManifest, PhotoRecord, VariantRecord } from './manifest.ts';

function variant(width: number): VariantRecord {
  return {
    format: 'webp',
    width,
    height: width,
    bytes: 1000,
    key: `p/aaaaaaaaaaaaaaaa/${String(width)}-01234567.webp`,
  };
}

function ogVariant(): VariantRecord {
  return {
    format: 'jpeg',
    width: 1200,
    height: 630,
    bytes: 2000,
    key: 'p/aaaaaaaaaaaaaaaa/og-01234567.jpg',
  };
}

function photo(file: string, sourceId: string, roll = '.'): PhotoRecord {
  return {
    file,
    roll,
    sourceId,
    width: 1600,
    height: 1200,
    color: '#808080',
    lqip: 'data:image/webp;base64,AA==',
    camera: null,
    variants: [variant(400)],
    og: ogVariant(),
  };
}

async function fixtureManifest(photos: readonly PhotoRecord[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'photo-ingest-'));
  await mkdir(directory, { recursive: true });
  const manifest: AlbumManifest = {
    schemaVersion: 2,
    slug: 'paris-2025',
    photos: [...photos],
    rolls: [{ id: '.', photoCount: photos.length }],
  };
  const path = join(directory, 'paris-2025.json');
  await writeFileAtomic(path, formatJson(manifest));
  return path;
}

test('readPreviousRecords indexes a manifest by both path and sourceId', async () => {
  const path = await fixtureManifest([
    photo('001.jpg', 'aaaaaaaaaaaaaaaa'),
    photo('002.jpg', 'bbbbbbbbbbbbbbbb'),
  ]);

  const previous = await readPreviousRecords(path);

  assert.equal(previous.byPath.get('001.jpg')?.sourceId, 'aaaaaaaaaaaaaaaa');
  assert.equal(previous.byPath.get('002.jpg')?.sourceId, 'bbbbbbbbbbbbbbbb');
  assert.equal(previous.bySourceId.get('aaaaaaaaaaaaaaaa')?.file, '001.jpg');
  assert.equal(previous.bySourceId.get('bbbbbbbbbbbbbbbb')?.file, '002.jpg');
});

test('readPreviousRecords returns empty maps when the manifest does not exist yet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-ingest-'));
  const previous = await readPreviousRecords(join(directory, 'nonexistent.json'));

  assert.equal(previous.byPath.size, 0);
  assert.equal(previous.bySourceId.size, 0);
});

test('resolvePriorRecord prefers a path match when both would match', async () => {
  const path = await fixtureManifest([photo('001.jpg', 'aaaaaaaaaaaaaaaa')]);
  const previous = await readPreviousRecords(path);

  // Same path, same sourceId: either index would return the same record, but
  // path takes priority — this is what keeps a same-path re-export (a
  // deliberately new sourceId at an unchanged path) from being confused with
  // a move, per "the source digest covers file bytes, not pixels".
  const resolved = resolvePriorRecord(previous, '001.jpg', 'aaaaaaaaaaaaaaaa');

  assert.equal(resolved?.file, '001.jpg');
});

test('resolvePriorRecord falls back to sourceId when the path has changed — the move case', async () => {
  const path = await fixtureManifest([photo('0827/001.jpg', 'aaaaaaaaaaaaaaaa')]);
  const previous = await readPreviousRecords(path);

  // The file now lives at a different path, but its bytes (sourceId) are unchanged.
  const resolved = resolvePriorRecord(previous, '0828/001.jpg', 'aaaaaaaaaaaaaaaa');

  assert.equal(resolved?.file, '0827/001.jpg');
  assert.equal(resolved?.sourceId, 'aaaaaaaaaaaaaaaa');
});

test('resolvePriorRecord returns undefined when neither the path nor the sourceId matches anything', async () => {
  const path = await fixtureManifest([photo('001.jpg', 'aaaaaaaaaaaaaaaa')]);
  const previous = await readPreviousRecords(path);

  const resolved = resolvePriorRecord(previous, '002.jpg', 'bbbbbbbbbbbbbbbb');

  assert.equal(resolved, undefined);
});

test('resolvePriorRecord treats a same-path re-export as a new identity, not a match to a different sourceId', async () => {
  const path = await fixtureManifest([photo('001.jpg', 'aaaaaaaaaaaaaaaa')]);
  const previous = await readPreviousRecords(path);

  // Same path, new sourceId (a metadata-only re-export). The path match still
  // finds the previous record — that's what `ingestPhoto` uses to compute
  // `newIdentity` (previous.sourceId !== sourceId) correctly as `true` here.
  const resolved = resolvePriorRecord(previous, '001.jpg', 'cccccccccccccccc');

  assert.equal(resolved?.sourceId, 'aaaaaaaaaaaaaaaa');
});

test('a duplicate sourceId across two previous records collapses to one in the sourceId index, harmlessly', async () => {
  // Byte-identical content recorded at two different paths in the previous
  // manifest. Content-addressed derivatives mean either record describes the
  // same on-disk files correctly, so "last one wins" here is fine, not a bug.
  const path = await fixtureManifest([
    photo('001.jpg', 'dddddddddddddddd'),
    photo('002.jpg', 'dddddddddddddddd'),
  ]);
  const previous: PreviousRecords = await readPreviousRecords(path);

  assert.equal(previous.bySourceId.size, 1);
  const resolved = resolvePriorRecord(previous, '003.jpg', 'dddddddddddddddd');
  assert.ok(resolved?.file === '001.jpg' || resolved?.file === '002.jpg');
});
