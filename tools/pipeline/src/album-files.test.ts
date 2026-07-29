import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { scaffoldAlbumMarkdown, setPhotoDescription, syncPhotosFile, syncRollsFile } from './album-files.ts';

async function emptyAlbumDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'photo-album-'));
  await mkdir(directory, { recursive: true });
  return directory;
}

test('a new photos.yaml is created with the given files and empty alt text', async () => {
  const directory = await emptyAlbumDirectory();
  const result = await syncPhotosFile(directory, ['001.jpg', '002.jpg']);
  assert.equal(result.created, true);
  assert.deepEqual(result.missingAlt, ['001.jpg', '002.jpg']);
});

test('re-running with no changes touches nothing and reports missing alt text', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, ['001.jpg']);
  const before = await readFile(join(directory, 'photos.yaml'), 'utf8');

  const result = await syncPhotosFile(directory, ['001.jpg']);

  assert.equal(result.created, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.missingAlt, ['001.jpg']);
  assert.equal(await readFile(join(directory, 'photos.yaml'), 'utf8'), before);
});

/**
 * Regression test: a long, single-line alt text (entirely normal — accessible
 * alt text is a full sentence, easily past 80 characters) used to make the
 * round-trip guard fire on every later ingest, because the guard compared
 * against the library's default 80-column wrapping while every writer in this
 * file uses `lineWidth: 0`. The mismatch was between two serialisations of our
 * own making, not a sign of a hand-edited file, so it must not fire here.
 */
test('a long alt text line does not trip the round-trip guard when a photo is added', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, ['001.jpg']);

  const longAlt =
    'A black-and-white photograph of a Paris Métro train stopped at a platform, ' +
    'beneath a riveted, porthole-windowed tunnel ceiling, easily past eighty characters.';
  const withAltText = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    'alt: ""',
    `alt: ${longAlt}`,
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(directory, 'photos.yaml'), withAltText));

  const result = await syncPhotosFile(directory, ['001.jpg', '002.jpg']);

  assert.equal(result.created, false);
  assert.deepEqual(result.added, ['002.jpg']);
  const updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, new RegExp(`alt: ${longAlt}\\n`));
});

test('a new rolls.yaml is created with the given ids', async () => {
  const directory = await emptyAlbumDirectory();
  const result = await syncRollsFile(directory, ['0827', '0828']);
  assert.equal(result.created, true);
  assert.deepEqual(result.added, ['0827', '0828']);
  const contents = await readFile(join(directory, 'rolls.yaml'), 'utf8');
  assert.match(contents, /id: "?0827"?/);
  assert.match(contents, /id: "?0828"?/);
});

test('rolls.yaml gains new roll ids and preserves hand-written fields on existing ones', async () => {
  const directory = await emptyAlbumDirectory();
  await syncRollsFile(directory, ['0827']);
  const withFilmStock = (await readFile(join(directory, 'rolls.yaml'), 'utf8')).replace(
    'filmStock: ""',
    'filmStock: Kodak Portra 400',
  );
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(directory, 'rolls.yaml'), withFilmStock));

  const result = await syncRollsFile(directory, ['0827', '0828']);

  assert.deepEqual(result.added, ['0828']);
  assert.deepEqual(result.removed, []);
  const updated = await readFile(join(directory, 'rolls.yaml'), 'utf8');
  assert.match(updated, /filmStock: Kodak Portra 400/);
  assert.match(updated, /id: "?0828"?/);
});

test('rolls.yaml drops a roll id that no longer exists in originals/', async () => {
  const directory = await emptyAlbumDirectory();
  await syncRollsFile(directory, ['0827', '0828']);

  const result = await syncRollsFile(directory, ['0828']);

  assert.deepEqual(result.removed, ['0827']);
  const updated = await readFile(join(directory, 'rolls.yaml'), 'utf8');
  assert.doesNotMatch(updated, /id: 0827/);
});

test('setPhotoDescription fills in alt and caption for one entry without disturbing others', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, ['001.jpg', '002.jpg']);
  const withHandwrittenCaption = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    '  - file: 002.jpg\n    alt: ""',
    '  - file: 002.jpg\n    alt: ""\n    caption: A note the photographer wrote by hand.',
  );
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(directory, 'photos.yaml'), withHandwrittenCaption),
  );

  await setPhotoDescription(directory, '001.jpg', { alt: 'A generated description.', caption: null });

  const updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /file: 001\.jpg\n\s+alt: "?A generated description\.?"?/);
  assert.match(updated, /A note the photographer wrote by hand\./);
});

test('album.md is scaffolded once and never touched again', async () => {
  const directory = await emptyAlbumDirectory();
  const created = await scaffoldAlbumMarkdown(directory, 'sample-album', '2024-02-11T00:00:00', '001.jpg');
  assert.equal(created, true);

  const first = await readFile(join(directory, 'album.md'), 'utf8');
  assert.match(first, /title: Sample Album/);
  assert.match(first, /date: 2024-02-11/);
  assert.match(first, /cover: 001\.jpg/);

  const createdAgain = await scaffoldAlbumMarkdown(directory, 'sample-album', '2099-01-01T00:00:00', '999.jpg');
  assert.equal(createdAgain, false);
  assert.equal(await readFile(join(directory, 'album.md'), 'utf8'), first);
});
