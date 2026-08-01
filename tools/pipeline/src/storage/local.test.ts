import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLocalStorage } from './local.ts';

const KEY = 'p/0123456789abcdef/400-1a2b3c4d.avif';

async function storageInTempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'photo-local-'));
  return { directory, storage: createLocalStorage(directory) };
}

test('listing a target that does not exist yet is empty, not an error', async () => {
  const { storage } = await storageInTempDirectory();
  assert.equal((await storage.list('p/')).size, 0);
});

test('what is written is what is listed, with its size', async () => {
  const { directory, storage } = await storageInTempDirectory();
  await storage.put(KEY, new Uint8Array([1, 2, 3, 4]), 'image/avif');

  const listed = await storage.list('p/');
  assert.deepEqual([...listed], [[KEY, 4]]);
  assert.deepEqual([...(await readFile(join(directory, ...KEY.split('/'))))], [1, 2, 3, 4]);
});

test('writing the same key twice is harmless', async () => {
  const { storage } = await storageInTempDirectory();
  await storage.put(KEY, new Uint8Array([1]), 'image/avif');
  await storage.put(KEY, new Uint8Array([1]), 'image/avif');
  assert.equal((await storage.list('p/')).size, 1);
});

test('a key that is not a derivative key is refused', async () => {
  const { storage } = await storageInTempDirectory();
  for (const key of ['../../etc/passwd', 'p/0123456789abcdef/../../x.avif', 'notes.txt', '']) {
    await assert.rejects(
      () => storage.put(key, new Uint8Array([1]), 'image/avif'),
      /not a valid derivative key/,
    );
  }
});
