import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadNotes } from './notes.ts';

test('a missing notes file reads as no entries, not an error', () => {
  assert.deepEqual(loadNotes('/nonexistent/notes.yaml'), []);
});

test('entries sort newest first by date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'photo-notes-'));
  const path = join(dir, 'notes.yaml');
  await writeFile(
    path,
    `entries:
  - date: '2026-08-01'
    text: older
  - date: '2026-08-08'
    text: newer
  - date: '2026-08-05'
    text: middle
`,
  );
  const notes = loadNotes(path);
  assert.deepEqual(
    notes.map((n) => n.text),
    ['newer', 'middle', 'older'],
  );
});

test('joy and photo default to false/null when omitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'photo-notes-'));
  const path = join(dir, 'notes.yaml');
  await writeFile(path, `entries:\n  - date: '2026-08-08'\n    text: plain\n`);
  const [note] = loadNotes(path);
  assert.equal(note?.joy, false);
  assert.equal(note?.photo, null);
});

test('joy and photo round-trip when present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'photo-notes-'));
  const path = join(dir, 'notes.yaml');
  await writeFile(
    path,
    `entries:\n  - date: '2026-08-08'\n    text: with extras\n    joy: true\n    photo: fence.jpg\n`,
  );
  const [note] = loadNotes(path);
  assert.equal(note?.joy, true);
  assert.equal(note?.photo, 'fence.jpg');
});

test('an entry missing date or text is dropped rather than crashing the page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'photo-notes-'));
  const path = join(dir, 'notes.yaml');
  await writeFile(
    path,
    `entries:\n  - date: '2026-08-08'\n  - text: no date\n  - date: '2026-08-08'\n    text: valid\n`,
  );
  const notes = loadNotes(path);
  assert.deepEqual(
    notes.map((n) => n.text),
    ['valid'],
  );
});
