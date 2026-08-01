import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { writeFileAtomic } from './files.ts';
import type { AlbumManifest, PhotoRecord } from './manifest.ts';
import {
  albumKeyDigest,
  SCHEMA_VERSION,
  writeAlbumManifest,
  writePublishedRecord,
} from './manifest.ts';
import { derivativePath, resolvePaths } from './paths.ts';
import type { Paths } from './paths.ts';
import { publish } from './publish.ts';
import { createLocalStorage } from './storage/local.ts';
import type { Storage } from './storage/storage.ts';

const BYTES = 64;

function photo(sourceId: string): PhotoRecord {
  return {
    file: `${sourceId.slice(0, 3)}.jpg`,
    roll: '.',
    sourceId,
    width: 6000,
    height: 4000,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera: null,
    variants: [
      {
        format: 'avif',
        width: 400,
        height: 267,
        bytes: BYTES,
        key: `p/${sourceId}/400-1a2b3c4d.avif`,
      },
      {
        format: 'webp',
        width: 400,
        height: 267,
        bytes: BYTES,
        key: `p/${sourceId}/400-5e6f7a8b.webp`,
      },
    ],
    og: {
      format: 'jpeg',
      width: 1200,
      height: 630,
      bytes: BYTES,
      key: `p/${sourceId}/og-99887766.jpg`,
    },
  };
}

function manifestFor(slug: string, sourceIds: readonly string[]): AlbumManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    slug,
    photos: sourceIds.map(photo),
    rolls: [{ id: '.', photoCount: sourceIds.length }],
  };
}

function keysOf(manifest: AlbumManifest): string[] {
  return manifest.photos.flatMap((entry) => [...entry.variants.map((v) => v.key), entry.og.key]);
}

/** A repository with manifests written and every derivative present locally. */
async function repositoryWith(manifests: readonly AlbumManifest[]): Promise<Paths> {
  const paths = resolvePaths(await mkdtemp(join(tmpdir(), 'photo-publish-')));
  for (const manifest of manifests) {
    await writeAlbumManifest(join(paths.manifests, `${manifest.slug}.json`), manifest);
    for (const key of keysOf(manifest)) {
      await writeFileAtomic(derivativePath(paths, key), Buffer.alloc(BYTES, 1));
    }
  }
  return paths;
}

interface RecordingStorage extends Storage {
  readonly puts: string[];
  readonly objects: Map<string, number>;
}

function recordingStorage(options: { failOnPut?: string } = {}): RecordingStorage {
  const objects = new Map<string, number>();
  const puts: string[] = [];
  return {
    description: 'test:bucket',
    objects,
    puts,
    list: (prefix) =>
      Promise.resolve(new Map([...objects].filter(([key]) => key.startsWith(prefix)))),
    put: (key, body) => {
      if (options.failOnPut === key) return Promise.reject(new Error('network went away'));
      puts.push(key);
      objects.set(key, body.byteLength);
      return Promise.resolve();
    },
  };
}

async function readPublished(paths: Paths): Promise<unknown> {
  return JSON.parse(await readFile(paths.publishedFile, 'utf8'));
}

test('a first publish uploads everything and records the album', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef', 'fedcba9876543210']);
  const paths = await repositoryWith([manifest]);
  const storage = recordingStorage();

  const report = await publish({ paths, storage, concurrency: 4 });

  assert.equal(report.uploaded, 6);
  assert.equal(report.alreadyPresent, 0);
  assert.deepEqual(report.albumsRecorded, ['hokkaido-winter']);
  assert.deepEqual(await readPublished(paths), {
    schemaVersion: SCHEMA_VERSION,
    target: 'test:bucket',
    albums: { 'hokkaido-winter': albumKeyDigest(manifest) },
  });
});

test('publishing the same unchanged inputs again uploads nothing', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);
  const paths = await repositoryWith([manifest]);
  const storage = recordingStorage();

  await publish({ paths, storage, concurrency: 4 });
  const first = await readPublished(paths);
  storage.puts.length = 0;

  const second = await publish({ paths, storage, concurrency: 4 });

  assert.deepEqual(storage.puts, []);
  assert.equal(second.uploaded, 0);
  assert.equal(second.alreadyPresent, 3);
  assert.deepEqual(await readPublished(paths), first);
});

test('an object whose size disagrees with the manifest is re-uploaded', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);
  const paths = await repositoryWith([manifest]);
  const storage = recordingStorage();
  await publish({ paths, storage, concurrency: 4 });

  // A truncated upload from an interrupted run.
  const [truncated] = keysOf(manifest);
  storage.objects.set(truncated ?? '', 12);
  storage.puts.length = 0;

  const report = await publish({ paths, storage, concurrency: 4 });

  assert.deepEqual(storage.puts, [truncated]);
  assert.equal(report.replaced, 1);
  assert.equal(storage.objects.get(truncated ?? ''), BYTES);
});

test('a failed upload records nothing, leaving the previous state intact', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);
  const paths = await repositoryWith([manifest]);
  const previous = { schemaVersion: SCHEMA_VERSION, target: 'test:bucket', albums: {} };
  await writePublishedRecord(paths.publishedFile, previous);

  const storage = recordingStorage({ failOnPut: `p/0123456789abcdef/og-99887766.jpg` });
  await assert.rejects(() => publish({ paths, storage, concurrency: 1 }), /network went away/);

  // The critical property: nothing now claims that this album was published.
  assert.deepEqual(await readPublished(paths), previous);
});

test('an interrupted publish resumes without re-uploading what already arrived', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);
  const paths = await repositoryWith([manifest]);
  const failing = recordingStorage({ failOnPut: 'p/0123456789abcdef/og-99887766.jpg' });

  await assert.rejects(() => publish({ paths, storage: failing, concurrency: 1 }));
  const arrived = [...failing.objects.keys()];
  assert.ok(arrived.length > 0 && arrived.length < 3);

  failing.puts.length = 0;
  const resumed = recordingStorage();
  for (const [key, size] of failing.objects) resumed.objects.set(key, size);

  const report = await publish({ paths, storage: resumed, concurrency: 1 });
  assert.equal(report.uploaded, 3 - arrived.length);
  assert.deepEqual(report.albumsRecorded, ['hokkaido-winter']);
});

test('a derivative that needs uploading but is not in the cache fails with instructions', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);
  const paths = resolvePaths(await mkdtemp(join(tmpdir(), 'photo-publish-')));
  await writeAlbumManifest(join(paths.manifests, 'hokkaido-winter.json'), manifest);
  // Manifests written, derivatives never encoded: what a fresh clone looks like.

  await assert.rejects(
    () => publish({ paths, storage: recordingStorage(), concurrency: 1 }),
    /rebuildable cache. Run `pnpm ingest`/,
  );
});

test('one album failing does not record the others as published', async () => {
  const good = manifestFor('lisbon-in-august', ['aaaaaaaaaaaaaaaa']);
  const bad = manifestFor('hokkaido-winter', ['bbbbbbbbbbbbbbbb']);
  const paths = await repositoryWith([good, bad]);

  const storage = recordingStorage({ failOnPut: 'p/bbbbbbbbbbbbbbbb/og-99887766.jpg' });
  await assert.rejects(() => publish({ paths, storage, concurrency: 1 }));

  // published.json is written once, at the end, so a failure anywhere means it
  // is not written at all rather than written half true.
  await assert.rejects(() => readFile(paths.publishedFile, 'utf8'));
});

test('publishing locally and publishing to a bucket produce the same record', async () => {
  const manifest = manifestFor('hokkaido-winter', ['0123456789abcdef']);

  const remotePaths = await repositoryWith([manifest]);
  const remote = recordingStorage();
  await publish({ paths: remotePaths, storage: remote, concurrency: 2 });

  const localPaths = await repositoryWith([manifest]);
  const localDirectory = join(localPaths.root, 'site', 'public');
  await publish({ paths: localPaths, storage: createLocalStorage(localDirectory), concurrency: 2 });

  const remoteRecord = (await readPublished(remotePaths)) as { albums: unknown; target: string };
  const localRecord = (await readPublished(localPaths)) as { albums: unknown; target: string };

  // Same albums, same digests. Only the target differs, which is the point:
  // local mode is the same pipeline pointed somewhere else, not a simulation.
  assert.deepEqual(localRecord.albums, remoteRecord.albums);
  assert.notEqual(localRecord.target, remoteRecord.target);

  const written = await createLocalStorage(localDirectory).list('p/');
  assert.deepEqual([...written.keys()].sort(), [...remote.objects.keys()].sort());
});
