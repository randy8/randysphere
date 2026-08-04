import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPhotoEdits,
  scaffoldAlbumMarkdown,
  setPhotoDescription,
  StaleAlbumFileError,
  syncPhotosFile,
  syncRollsFile,
  updateAlbumCover,
} from './album-files.ts';
import type { PhotoRef } from './album-files.ts';
import { writeFileAtomic } from './files.ts';
import { sha256Hex } from './hash.ts';

async function emptyAlbumDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'photo-album-'));
  await mkdir(directory, { recursive: true });
  return directory;
}

/** A deterministic, distinct-per-file sourceId, for tests that don't care what it is, only that it's stable. */
function ref(file: string, sourceId?: string): PhotoRef {
  return { file, sourceId: sourceId ?? file.padEnd(16, '0').slice(0, 16) };
}

function refs(files: readonly string[]): PhotoRef[] {
  return files.map((file) => ref(file));
}

test('a new photos.yaml is created with the given files, empty alt text, and the default tag', async () => {
  const directory = await emptyAlbumDirectory();
  const result = await syncPhotosFile(directory, refs(['001.jpg', '002.jpg']), 'paris-2025');
  assert.equal(result.created, true);
  assert.deepEqual(result.missingAlt, ['001.jpg', '002.jpg']);
  assert.deepEqual(result.tagsBackfilled, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(contents, /tags:\s*\n\s*- paris-2025/);
  assert.match(contents, /file: 001\.jpg\n\s+sourceId: \S+\n/);
});

test('re-running with no changes touches nothing and reports missing alt text', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg']), 'paris-2025');
  const before = await readFile(join(directory, 'photos.yaml'), 'utf8');

  const result = await syncPhotosFile(directory, refs(['001.jpg']), 'paris-2025');

  assert.equal(result.created, false);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.missingAlt, ['001.jpg']);
  assert.deepEqual(result.tagsBackfilled, []);
  assert.deepEqual(result.sourceIdBackfilled, []);
  assert.equal(await readFile(join(directory, 'photos.yaml'), 'utf8'), before);
});

test('an entry written before tags existed is seeded with the default tag exactly once', async () => {
  const directory = await emptyAlbumDirectory();
  // Simulate a photos.yaml from before this feature: no "tags" key at all.
  await writeFileAtomic(
    join(directory, 'photos.yaml'),
    '---\nphotos:\n  - file: 001.jpg\n    alt: ""\n',
  );

  const result = await syncPhotosFile(directory, [ref('001.jpg')], 'paris-2025');

  assert.deepEqual(result.tagsBackfilled, ['001.jpg']);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(contents, /tags:\s*\n\s*- paris-2025/);

  // A second run must not touch it again: the key now exists.
  const again = await syncPhotosFile(directory, [ref('001.jpg')], 'paris-2025');
  assert.deepEqual(again.tagsBackfilled, []);
});

test('an entry written before sourceId existed is given one, once, matched by path', async () => {
  const directory = await emptyAlbumDirectory();
  // Simulate a photos.yaml from before this field existed: no "sourceId" key.
  await writeFileAtomic(
    join(directory, 'photos.yaml'),
    '---\nphotos:\n  - file: 001.jpg\n    alt: ""\n    tags:\n      - paris-2025\n',
  );

  const result = await syncPhotosFile(
    directory,
    [ref('001.jpg', 'aaaaaaaaaaaaaaaa')],
    'paris-2025',
  );

  assert.deepEqual(result.sourceIdBackfilled, ['001.jpg']);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.moved, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  // Appended after the fields that already existed, not repositioned next to
  // `file` — a minor, accepted cosmetic gap, the same one `tags`'s own
  // backfill already has (`YAMLMap.set()` on a brand-new key always appends).
  assert.match(
    contents,
    /file: 001\.jpg\n\s+alt: ""\n\s+tags:\n\s+- paris-2025\n\s+sourceId: aaaaaaaaaaaaaaaa\n/,
  );

  // A second run must not report it again: the entry already has a sourceId
  // that matches, so there is nothing left to backfill.
  const again = await syncPhotosFile(directory, [ref('001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');
  assert.deepEqual(again.sourceIdBackfilled, []);
  assert.deepEqual(again.moved, []);
});

test('a photo moved to a different roll is matched by content, preserving its caption and tags', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, [ref('0827/001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');
  await applyPhotoEdits(
    directory,
    [{ file: '0827/001.jpg', alt: 'A street scene.', addTags: ['street'] }],
    null,
  );

  const result = await syncPhotosFile(
    directory,
    [ref('0828/001.jpg', 'aaaaaaaaaaaaaaaa')],
    'paris-2025',
  );

  assert.deepEqual(result.moved, [{ from: '0827/001.jpg', to: '0828/001.jpg' }]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.doesNotMatch(contents, /0827\/001\.jpg/);
  assert.match(
    contents,
    /file: 0828\/001\.jpg\n\s+sourceId: aaaaaaaaaaaaaaaa\n\s+alt: ["']?A street scene\.?["']?\n\s+tags:\n\s+- paris-2025\n\s+- street/,
  );
});

test('a photo flattened out of its roll into the album root is still matched by content', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, [ref('0827/001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');
  await applyPhotoEdits(directory, [{ file: '0827/001.jpg', alt: 'A street scene.' }], null);

  const result = await syncPhotosFile(
    directory,
    [ref('001.jpg', 'aaaaaaaaaaaaaaaa')],
    'paris-2025',
  );

  assert.deepEqual(result.moved, [{ from: '0827/001.jpg', to: '001.jpg' }]);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(
    contents,
    /file: 001\.jpg\n\s+sourceId: aaaaaaaaaaaaaaaa\n\s+alt: ["']?A street scene\.?["']?/,
  );
});

test('a genuinely new photo is added and a genuinely deleted one is removed, without being confused for a move', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, [ref('001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');
  await applyPhotoEdits(directory, [{ file: '001.jpg', alt: 'Kept.' }], null);

  // 001.jpg is deleted from originals/; 002.jpg is unrelated, different content.
  const result = await syncPhotosFile(
    directory,
    [ref('002.jpg', 'bbbbbbbbbbbbbbbb')],
    'paris-2025',
  );

  assert.deepEqual(result.added, ['002.jpg']);
  assert.deepEqual(result.removed, ['001.jpg']);
  assert.deepEqual(result.moved, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.doesNotMatch(contents, /Kept\./);
  assert.match(contents, /file: 002\.jpg/);
});

test('a same-path re-export keeps its caption via the path fallback, and refreshes its stored sourceId', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, [ref('001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');
  await applyPhotoEdits(directory, [{ file: '001.jpg', alt: 'A hand-written caption.' }], null);

  // Re-exported with different metadata: same path, deliberately a new
  // sourceId (docs/decisions.md, "the source digest covers file bytes, not
  // pixels") — this must not be mistaken for the old photo moving away.
  const result = await syncPhotosFile(
    directory,
    [ref('001.jpg', 'cccccccccccccccc')],
    'paris-2025',
  );

  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(contents, /alt: ["']?A hand-written caption\.?["']?/);
  assert.match(contents, /sourceId: cccccccccccccccc/);
  assert.doesNotMatch(contents, /aaaaaaaaaaaaaaaa/);
});

test('two current photos sharing a sourceId (duplicate content) fall back to path matching for both', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(
    directory,
    [ref('001.jpg', 'dddddddddddddddd'), ref('002.jpg', 'dddddddddddddddd')],
    'paris-2025',
  );
  await applyPhotoEdits(
    directory,
    [
      { file: '001.jpg', alt: 'First copy.' },
      { file: '002.jpg', alt: 'Second copy.' },
    ],
    null,
  );

  // Re-run with the same, still-duplicated content: nothing should move or vanish.
  const result = await syncPhotosFile(
    directory,
    [ref('001.jpg', 'dddddddddddddddd'), ref('002.jpg', 'dddddddddddddddd')],
    'paris-2025',
  );

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.moved, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(contents, /First copy\./);
  assert.match(contents, /Second copy\./);
});

test('the round-trip guard reports a pending move in its refusal message', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, [ref('0827/001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025');

  // Trailing whitespace the library will not reproduce byte-for-byte — a
  // stand-in for any hand-edit our writer can't round-trip safely.
  const withTrailingSpace = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    'file: 0827/001.jpg',
    'file: 0827/001.jpg   ',
  );
  await writeFileAtomic(join(directory, 'photos.yaml'), withTrailingSpace);

  await assert.rejects(
    () => syncPhotosFile(directory, [ref('0828/001.jpg', 'aaaaaaaaaaaaaaaa')], 'paris-2025'),
    /rename:\s+0827\/001\.jpg -> 0828\/001\.jpg/,
  );
});

test('an entry with an existing tags list, even one the photographer emptied, is never backfilled', async () => {
  const directory = await emptyAlbumDirectory();
  await writeFileAtomic(
    join(directory, 'photos.yaml'),
    '---\nphotos:\n  - file: 001.jpg\n    alt: ""\n    tags: []\n',
  );

  const result = await syncPhotosFile(directory, refs(['001.jpg']), 'paris-2025');

  assert.deepEqual(result.tagsBackfilled, []);
  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.doesNotMatch(contents, /paris-2025/);
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
  await syncPhotosFile(directory, [ref('001.jpg')], 'paris-2025');

  const longAlt =
    'A black-and-white photograph of a Paris Métro train stopped at a platform, ' +
    'beneath a riveted, porthole-windowed tunnel ceiling, easily past eighty characters.';
  const withAltText = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    "alt: ''",
    `alt: ${longAlt}`,
  );
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(directory, 'photos.yaml'), withAltText),
  );

  const result = await syncPhotosFile(directory, [ref('001.jpg'), ref('002.jpg')], 'paris-2025');

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
  assert.match(contents, /id: ["']?0827["']?/);
  assert.match(contents, /id: ["']?0828["']?/);
});

test('rolls.yaml gains new roll ids and preserves hand-written fields on existing ones', async () => {
  const directory = await emptyAlbumDirectory();
  await syncRollsFile(directory, ['0827']);
  const withFilmStock = (await readFile(join(directory, 'rolls.yaml'), 'utf8')).replace(
    "filmStock: ''",
    'filmStock: Kodak Portra 400',
  );
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(directory, 'rolls.yaml'), withFilmStock),
  );

  const result = await syncRollsFile(directory, ['0827', '0828']);

  assert.deepEqual(result.added, ['0828']);
  assert.deepEqual(result.removed, []);
  const updated = await readFile(join(directory, 'rolls.yaml'), 'utf8');
  assert.match(updated, /filmStock: Kodak Portra 400/);
  assert.match(updated, /id: ["']?0828["']?/);
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
  await syncPhotosFile(directory, refs(['001.jpg', '002.jpg']), 'paris-2025');
  const withHandwrittenCaption = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    "  - file: 002.jpg\n    sourceId: 002.jpg000000000\n    alt: ''",
    "  - file: 002.jpg\n    sourceId: 002.jpg000000000\n    alt: ''\n    caption: A note the photographer wrote by hand.",
  );
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(directory, 'photos.yaml'), withHandwrittenCaption),
  );

  await setPhotoDescription(directory, '001.jpg', {
    alt: 'A generated description.',
    caption: null,
  });

  const updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(
    updated,
    /file: 001\.jpg\n\s+sourceId: \S+\n\s+alt: ["']?A generated description\.?["']?/,
  );
  assert.match(updated, /A note the photographer wrote by hand\./);
});

test('applyPhotoEdits adds and removes tags across multiple files in a single pass, preserving order', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg', '002.jpg']), 'paris-2025');

  const result = await applyPhotoEdits(
    directory,
    [
      { file: '001.jpg', addTags: ['street', 'night'] },
      { file: '002.jpg', removeTags: ['paris-2025'] },
    ],
    null,
  );

  const contents = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(
    contents,
    /file: 001\.jpg\n\s+sourceId: \S+\n\s+alt: ''\n\s+tags:\n\s+- paris-2025\n\s+- street\n\s+- night/,
  );
  assert.match(contents, /file: 002\.jpg\n\s+sourceId: \S+\n\s+alt: ''\n\s+tags: \[\]/);
  assert.equal(result.version, sha256Hex(contents));

  // Adding a tag that's already present does not duplicate it or reorder existing tags.
  const again = await applyPhotoEdits(
    directory,
    [{ file: '001.jpg', addTags: ['paris-2025', 'dawn'] }],
    null,
  );
  const updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /tags:\n\s+- paris-2025\n\s+- street\n\s+- night\n\s+- dawn/);
  assert.equal(again.version, sha256Hex(updated));
});

test('applyPhotoEdits sets alt and clears caption via null without disturbing other entries', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg', '002.jpg']), 'paris-2025');
  const withHandwrittenCaption = (await readFile(join(directory, 'photos.yaml'), 'utf8')).replace(
    "  - file: 002.jpg\n    sourceId: 002.jpg000000000\n    alt: ''",
    "  - file: 002.jpg\n    sourceId: 002.jpg000000000\n    alt: ''\n    caption: A note the photographer wrote by hand.",
  );
  await writeFileAtomic(join(directory, 'photos.yaml'), withHandwrittenCaption);

  await applyPhotoEdits(directory, [{ file: '001.jpg', alt: 'A street at dusk.' }], null);
  await applyPhotoEdits(directory, [{ file: '002.jpg', caption: null }], null);

  const updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /file: 001\.jpg\n\s+sourceId: \S+\n\s+alt: ["']?A street at dusk\.?["']?/);
  assert.doesNotMatch(updated, /caption:/);
});

test('applyPhotoEdits sets featured and featuredOrder, and null clears featuredOrder', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg', '002.jpg']), 'paris-2025');

  await applyPhotoEdits(directory, [{ file: '001.jpg', featured: true, featuredOrder: 2 }], null);
  let updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /file: 001\.jpg[\s\S]*?featured: true[\s\S]*?featuredOrder: 2/);

  await applyPhotoEdits(directory, [{ file: '001.jpg', featuredOrder: null }], null);
  updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /file: 001\.jpg[\s\S]*?featured: true/);
  assert.doesNotMatch(updated, /featuredOrder/);

  await applyPhotoEdits(directory, [{ file: '001.jpg', featured: false }], null);
  updated = await readFile(join(directory, 'photos.yaml'), 'utf8');
  assert.match(updated, /file: 001\.jpg[\s\S]*?featured: false/);
});

test('applyPhotoEdits throws StaleAlbumFileError when the file changed since expectedVersion was captured', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg']), 'paris-2025');
  const staleVersion = sha256Hex(await readFile(join(directory, 'photos.yaml'), 'utf8'));

  // Something else (another tab, `pnpm ingest`, a hand-edit) changes the file.
  await applyPhotoEdits(directory, [{ file: '001.jpg', addTags: ['street'] }], null);

  await assert.rejects(
    () => applyPhotoEdits(directory, [{ file: '001.jpg', addTags: ['night'] }], staleVersion),
    StaleAlbumFileError,
  );
  // And is not thrown when the version still matches, or when the check is skipped with null.
  const currentVersion = sha256Hex(await readFile(join(directory, 'photos.yaml'), 'utf8'));
  await applyPhotoEdits(directory, [{ file: '001.jpg', addTags: ['night'] }], currentVersion);
  await applyPhotoEdits(directory, [{ file: '001.jpg', addTags: ['dusk'] }], null);
});

test('applyPhotoEdits throws when a file has no matching entry', async () => {
  const directory = await emptyAlbumDirectory();
  await syncPhotosFile(directory, refs(['001.jpg']), 'paris-2025');

  await assert.rejects(() =>
    applyPhotoEdits(directory, [{ file: 'missing.jpg', addTags: ['street'] }], null),
  );
});

test('album.md is scaffolded once and never touched again', async () => {
  const directory = await emptyAlbumDirectory();
  const created = await scaffoldAlbumMarkdown(
    directory,
    'sample-album',
    '2024-02-11T00:00:00',
    '001.jpg',
  );
  assert.equal(created, true);

  const first = await readFile(join(directory, 'album.md'), 'utf8');
  assert.match(first, /title: Sample Album/);
  assert.match(first, /date: 2024-02-11/);
  assert.match(first, /cover: 001\.jpg/);

  const createdAgain = await scaffoldAlbumMarkdown(
    directory,
    'sample-album',
    '2099-01-01T00:00:00',
    '999.jpg',
  );
  assert.equal(createdAgain, false);
  assert.equal(await readFile(join(directory, 'album.md'), 'utf8'), first);
});

test('updateAlbumCover changes only cover, leaving every hand-written field untouched', async () => {
  const directory = await emptyAlbumDirectory();
  await scaffoldAlbumMarkdown(directory, 'sample-album', '2024-02-11T00:00:00', '001.jpg');
  await writeFileAtomic(
    join(directory, 'album.md'),
    (await readFile(join(directory, 'album.md'), 'utf8')).replace(
      "location: ''",
      "location: 'Richmond, Virginia'",
    ),
  );

  await updateAlbumCover(directory, '002.jpg');

  const content = await readFile(join(directory, 'album.md'), 'utf8');
  assert.match(content, /cover: 002\.jpg/);
  assert.match(content, /location: 'Richmond, Virginia'/);
  assert.match(content, /title: Sample Album/);
});

test('updateAlbumCover throws rather than reformat a file our own writer would not produce faithfully', async () => {
  const directory = await emptyAlbumDirectory();
  await writeFileAtomic(
    join(directory, 'album.md'),
    '---\ntitle:   Sample Album   # extra spacing\ncover: 001.jpg\n---\n',
  );
  await assert.rejects(
    () => updateAlbumCover(directory, '002.jpg'),
    /needs updating, but rewriting it would also reformat it/,
  );
});

test('updateAlbumCover throws when the file has no frontmatter block', async () => {
  const directory = await emptyAlbumDirectory();
  await writeFileAtomic(join(directory, 'album.md'), 'Just some notes, no frontmatter.\n');
  await assert.rejects(
    () => updateAlbumCover(directory, '002.jpg'),
    /expected to start with a "---" YAML frontmatter block/,
  );
});
