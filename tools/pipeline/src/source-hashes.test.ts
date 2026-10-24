import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { sha256File } from './hash.ts';
import { loadSourceHashes } from './source-hashes.ts';

test('a cached hash is reused while size and mtime hold, and recomputed once either changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-hashes-'));
  const cacheFile = join(directory, 'source-hashes.json');
  const photo = join(directory, '001.tif');
  await writeFile(photo, 'first bytes');

  const first = await loadSourceHashes(cacheFile);
  assert.equal(await first.hash(photo), await sha256File(photo));
  await first.save();

  // Poison the cached value: a hit must come from the cache, not the file.
  const cache = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, { sha256: string }>;
  const entry = cache[photo];
  assert.ok(entry !== undefined);
  entry.sha256 = 'from-cache';
  await writeFile(cacheFile, JSON.stringify(cache));
  assert.equal(await (await loadSourceHashes(cacheFile)).hash(photo), 'from-cache');

  // Same size, new mtime — a re-export — hashes for real.
  const later = new Date(Date.now() + 60_000);
  await utimes(photo, later, later);
  assert.equal(await (await loadSourceHashes(cacheFile)).hash(photo), await sha256File(photo));
});

test('saving merges with entries from batches not seen this run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-hashes-'));
  const cacheFile = join(directory, 'source-hashes.json');
  const a = join(directory, 'a.tif');
  const b = join(directory, 'b.tif');
  await writeFile(a, 'a');
  await writeFile(b, 'b');

  const first = await loadSourceHashes(cacheFile);
  await first.hash(a);
  await first.save();
  const second = await loadSourceHashes(cacheFile);
  await second.hash(b);
  await second.save();

  const cache = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(cache).sort(), [a, b].sort());
});
