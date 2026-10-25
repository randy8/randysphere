import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkHealth } from './health.ts';

async function site(): Promise<{
  distDir: string;
  generatedAlbumsDir: string;
  derivativesDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'photo-health-'));
  const paths = {
    distDir: join(root, 'dist'),
    generatedAlbumsDir: join(root, 'albums'),
    derivativesDir: join(root, 'derivatives'),
  };
  await mkdir(join(paths.distDir, 'exposures'), { recursive: true });
  await writeFile(join(paths.distDir, 'exposures', 'index.html'), '<h1>Exposures</h1>');
  await mkdir(paths.generatedAlbumsDir, { recursive: true });
  await writeFile(
    join(paths.generatedAlbumsDir, '0827.json'),
    JSON.stringify({ photos: [{ variants: [{ key: 'p/abc/640-x.avif' }] }] }),
  );
  await mkdir(join(paths.derivativesDir, 'p', 'abc'), { recursive: true });
  await writeFile(join(paths.derivativesDir, 'p', 'abc', '640-x.avif'), 'bytes');
  return paths;
}

test('a complete site is healthy', async () => {
  const health = await checkHealth(await site());
  assert.equal(health.ok, true);
  assert.deepEqual(health.checks, { page: true, manifest: true, image: true });
  assert.equal(health.release, null);
});

test('a missing build is unhealthy, and says which part', async () => {
  const paths = await site();
  await rm(join(paths.distDir, 'exposures', 'index.html'));
  const health = await checkHealth(paths);
  assert.equal(health.ok, false);
  assert.deepEqual(health.checks, { page: false, manifest: true, image: true });
});

test('derivatives that do not match the manifests are unhealthy', async () => {
  const paths = await site();
  await rm(join(paths.derivativesDir, 'p'), { recursive: true });
  const health = await checkHealth(paths);
  assert.equal(health.ok, false);
  assert.equal(health.checks.image, false);
});

test('a malformed manifest is skipped for one that parses', async () => {
  const paths = await site();
  await writeFile(join(paths.generatedAlbumsDir, '0001.json'), '{ not json');
  assert.equal((await checkHealth(paths)).ok, true);
});

test('no manifests at all is unhealthy', async () => {
  const paths = await site();
  await rm(paths.generatedAlbumsDir, { recursive: true });
  const health = await checkHealth(paths);
  assert.equal(health.ok, false);
  assert.equal(health.checks.manifest, false);
});

test('the release comes from the build-info.json a deploy writes', async () => {
  const paths = await site();
  await writeFile(
    join(paths.distDir, 'build-info.json'),
    JSON.stringify({ commit: '6aaa3b3', builtAt: '2026-10-25T16:00:00Z' }),
  );
  assert.deepEqual((await checkHealth(paths)).release, {
    commit: '6aaa3b3',
    builtAt: '2026-10-25T16:00:00Z',
  });
});
