import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { syncPhotosFile } from '../album-files.ts';
import type { AlbumManifest, PhotoRecord } from '../manifest.ts';
import { SCHEMA_VERSION, writeAlbumManifest } from '../manifest.ts';
import { resolvePaths } from '../paths.ts';
import type { Paths } from '../paths.ts';
import { readDescriptionCache } from './cache.ts';
import { describe } from './describe.ts';
import type { DescriptionProvider, DescriptionRequest } from './provider.ts';

function photo(sourceId: string, file: string, roll = '.'): PhotoRecord {
  return {
    file,
    roll,
    sourceId,
    width: 1800,
    height: 1200,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera: null,
    variants: [{ format: 'jpeg', width: 1200, height: 800, bytes: 1000, key: `p/${sourceId}/1200-aaaaaaaa.jpg` }],
    og: { format: 'jpeg', width: 1200, height: 630, bytes: 1000, key: `p/${sourceId}/og-99887766.jpg` },
  };
}

/** A repository with one album manifest written and photos.yaml scaffolded, as `pnpm ingest` would leave it. */
async function repositoryWith(slug: string, photos: readonly PhotoRecord[]): Promise<Paths> {
  const paths = resolvePaths(await mkdtemp(join(tmpdir(), 'photo-describe-')));
  const manifest: AlbumManifest = {
    schemaVersion: SCHEMA_VERSION,
    slug,
    photos: [...photos],
    rolls: [{ id: '.', photoCount: photos.length }],
  };
  await mkdir(paths.manifests, { recursive: true });
  await writeAlbumManifest(join(paths.manifests, `${slug}.json`), manifest);

  const albumDirectory = join(paths.albums, slug);
  await mkdir(albumDirectory, { recursive: true });
  await syncPhotosFile(
    albumDirectory,
    photos.map((p) => p.file),
  );

  return paths;
}

interface FakeProvider extends DescriptionProvider {
  readonly calls: DescriptionRequest[];
}

function fakeProvider(respond: (request: DescriptionRequest) => { alt: string; caption: string }): FakeProvider {
  const calls: DescriptionRequest[] = [];
  return {
    name: 'fake',
    calls,
    describe: (request) => {
      calls.push(request);
      return Promise.resolve(respond(request));
    },
  };
}

function failingProvider(shouldFail: (request: DescriptionRequest) => boolean): FakeProvider {
  const calls: DescriptionRequest[] = [];
  return {
    name: 'fake',
    calls,
    describe: (request) => {
      calls.push(request);
      if (shouldFail(request)) return Promise.reject(new Error('provider unavailable'));
      return Promise.resolve({ alt: 'Generated alt text.', caption: 'Generated caption.' });
    },
  };
}

test('a photo with no alt text and nothing cached gets a description generated and cached', async () => {
  const paths = await repositoryWith('trip', [photo('0000000000000001', '001.jpg')]);
  const provider = fakeProvider(() => ({ alt: 'A generated alt.', caption: 'A generated caption.' }));

  const report = await describe({ paths, onlyAlbums: null, provider, regenerate: false });

  assert.equal(report.generated, 1);
  assert.equal(report.filledFromCache, 0);
  assert.equal(provider.calls.length, 1);

  const photosYaml = await readFile(join(paths.albums, 'trip', 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /A generated alt\./);

  const cache = await readDescriptionCache(paths.descriptionsFile);
  assert.deepEqual(cache['0000000000000001'], {
    alt: 'A generated alt.',
    caption: 'A generated caption.',
    provider: 'fake',
  });
});

test('a second photo sharing a cached sourceId is filled in without calling the provider again', async () => {
  const paths = await repositoryWith('trip', [photo('0000000000000002', '001.jpg')]);
  const seedingProvider = fakeProvider(() => ({ alt: 'Cached alt.', caption: 'Cached caption.' }));
  await describe({ paths, onlyAlbums: null, provider: seedingProvider, regenerate: false });

  // A second photograph with identical bytes (same sourceId, e.g. a duplicate
  // export) joins the album. Its photos.yaml entry starts with empty alt, but
  // the cache already has an answer for that sourceId from the first run.
  const albumDirectory = join(paths.albums, 'trip');
  await syncPhotosFile(albumDirectory, ['001.jpg', '002.jpg']);
  const manifestPath = join(paths.manifests, 'trip.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AlbumManifest;
  await writeAlbumManifest(manifestPath, {
    ...manifest,
    photos: [...manifest.photos, photo('0000000000000002', '002.jpg')],
  });

  const secondProvider = fakeProvider(() => ({ alt: 'Should not be called.', caption: 'Should not be called.' }));
  const report = await describe({ paths, onlyAlbums: null, provider: secondProvider, regenerate: false });

  assert.equal(secondProvider.calls.length, 0);
  assert.equal(report.filledFromCache, 1);
  const photosYaml = await readFile(join(albumDirectory, 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /file: 002\.jpg\n\s+alt: "?Cached alt\.?"?/);
});

test('a hand-written alt text is never overwritten and the provider is never called for it', async () => {
  const paths = await repositoryWith('trip', [photo('0000000000000003', '001.jpg')]);
  const albumDirectory = join(paths.albums, 'trip');
  const handWritten = (await readFile(join(albumDirectory, 'photos.yaml'), 'utf8')).replace(
    'alt: ""',
    'alt: Written by the photographer, not a machine.',
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(albumDirectory, 'photos.yaml'), handWritten));

  const provider = fakeProvider(() => ({ alt: 'Should never appear.', caption: 'Should never appear.' }));
  const report = await describe({ paths, onlyAlbums: null, provider, regenerate: false });

  assert.equal(provider.calls.length, 0);
  assert.equal(report.skipped, 1);
  const photosYaml = await readFile(join(albumDirectory, 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /Written by the photographer, not a machine\./);
});

test('--regenerate refreshes a description that still matches what we generated, but leaves a hand-edit alone', async () => {
  const paths = await repositoryWith('trip', [
    photo('0000000000000004', '001.jpg'),
    photo('0000000000000005', '002.jpg'),
  ]);
  let seedCount = 0;
  const seeding = fakeProvider(() => {
    seedCount += 1;
    return { alt: `Original alt number ${seedCount.toString()}.`, caption: 'Original caption.' };
  });
  await describe({ paths, onlyAlbums: null, provider: seeding, regenerate: false });

  // Hand-edit only photo 002's alt text after the first run (002 was seeded second).
  const albumDirectory = join(paths.albums, 'trip');
  const withHandEdit = (await readFile(join(albumDirectory, 'photos.yaml'), 'utf8')).replace(
    'alt: "Original alt number 2."',
    'alt: Edited by hand after generation.',
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(albumDirectory, 'photos.yaml'), withHandEdit));

  const regenerating = fakeProvider(() => ({ alt: 'Freshly regenerated.', caption: 'Freshly regenerated.' }));
  const report = await describe({ paths, onlyAlbums: null, provider: regenerating, regenerate: true });

  assert.equal(regenerating.calls.length, 1);
  assert.equal(report.generated, 1);
  assert.equal(report.skipped, 1);

  const photosYaml = await readFile(join(albumDirectory, 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /Edited by hand after generation\./);
  assert.match(photosYaml, /Freshly regenerated\./);
});

test('a failed generation is reported but does not stop the rest of the album from being processed', async () => {
  const paths = await repositoryWith('trip', [
    photo('0000000000000006', '001.jpg'),
    photo('0000000000000007', '002.jpg'),
  ]);
  const provider = failingProvider((request) => request.imagePath.includes('0000000000000006'));

  const report = await describe({ paths, onlyAlbums: null, provider, regenerate: false });

  assert.equal(report.generated, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]?.file, '001.jpg');
  assert.match(report.failures[0]?.message ?? '', /provider unavailable/);

  const photosYaml = await readFile(join(paths.albums, 'trip', 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /file: 002\.jpg\n\s+alt: "?Generated alt text\.?"?/);
});

test('a failure on one photo does not prevent a later successful run from resuming (interruption is resumable)', async () => {
  const paths = await repositoryWith('trip', [
    photo('0000000000000008', '001.jpg'),
    photo('0000000000000009', '002.jpg'),
  ]);
  const flaky = failingProvider((request) => request.imagePath.includes('0000000000000008'));
  const first = await describe({ paths, onlyAlbums: null, provider: flaky, regenerate: false });
  assert.equal(first.failures.length, 1);
  assert.equal(first.generated, 1);

  const recovered = fakeProvider(() => ({ alt: 'Recovered on retry.', caption: 'Recovered on retry.' }));
  const second = await describe({ paths, onlyAlbums: null, provider: recovered, regenerate: false });

  // Only the previously-failed photo needed a call; the one that already
  // succeeded is left alone (its alt text is no longer empty).
  assert.equal(recovered.calls.length, 1);
  assert.equal(second.generated, 1);
  const photosYaml = await readFile(join(paths.albums, 'trip', 'photos.yaml'), 'utf8');
  assert.match(photosYaml, /Recovered on retry\./);
  assert.match(photosYaml, /Generated alt text\./);
});
