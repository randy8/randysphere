import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listRolls } from './sources.ts';

async function tempAlbum(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'photo-sources-'));
}

async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '');
}

test('a flat album with no subdirectories is a single roll', async () => {
  const album = await tempAlbum();
  await touch(join(album, '002.jpg'));
  await touch(join(album, '001.jpg'));

  const rolls = await listRolls(album);

  assert.deepEqual(rolls, [{ id: '.', files: ['001.jpg', '002.jpg'] }]);
});

test('one level of roll directories, sorted by id and by filename within each', async () => {
  const album = await tempAlbum();
  await touch(join(album, '0828', '003.tif'));
  await touch(join(album, '0828', '001.tif'));
  await touch(join(album, '0827', '002.tif'));

  const rolls = await listRolls(album);

  assert.deepEqual(rolls, [
    { id: '0827', files: ['002.tif'] },
    { id: '0828', files: ['001.tif', '003.tif'] },
  ]);
});

test('rolls at arbitrary, uneven depth, with nothing hardcoded about how deep', async () => {
  const album = await tempAlbum();
  await touch(join(album, '0827', '001.tif'));
  await touch(join(album, 'europe', 'paris', '0828', '001.tif'));
  await touch(join(album, 'europe', 'paris', 'extra', 'deep', 'roll', '001.tif'));

  const rolls = await listRolls(album);

  assert.deepEqual(
    rolls.map((roll) => roll.id),
    ['0827', 'europe/paris/0828', 'europe/paris/extra/deep/roll'],
  );
});

test('a directory holding both loose files and subdirectories is itself a roll, and its subdirectories are separate rolls', async () => {
  const album = await tempAlbum();
  await touch(join(album, 'cover.jpg'));
  await touch(join(album, '0827', '001.tif'));

  const rolls = await listRolls(album);

  assert.deepEqual(rolls, [
    { id: '.', files: ['cover.jpg'] },
    { id: '0827', files: ['001.tif'] },
  ]);
});

test('a directory with only subdirectories and no images of its own is not a roll', async () => {
  const album = await tempAlbum();
  await touch(join(album, 'europe', 'paris', '001.tif'));

  const rolls = await listRolls(album);

  assert.deepEqual(rolls, [{ id: 'europe/paris', files: ['001.tif'] }]);
  assert.equal(
    rolls.some((roll) => roll.id === 'europe'),
    false,
  );
});

test('non-image files are ignored everywhere in the tree', async () => {
  const album = await tempAlbum();
  await touch(join(album, '0827', '001.tif'));
  await touch(join(album, '0827', '.DS_Store'));
  await touch(join(album, 'notes.txt'));

  const rolls = await listRolls(album);

  assert.deepEqual(rolls, [{ id: '0827', files: ['001.tif'] }]);
});

test('an empty album has no rolls', async () => {
  const album = await tempAlbum();

  assert.deepEqual(await listRolls(album), []);
});
