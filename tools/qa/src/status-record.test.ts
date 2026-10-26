import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicNote, summarise } from './status-record.ts';

test('the public note is the subject up to its first colon, and short', () => {
  assert.equal(publicNote('Loading: deal photo pages once per session'), 'Loading');
  assert.equal(publicNote('Crunchwrap'), 'Crunchwrap');
  assert.equal(publicNote('x'.repeat(80)).length, 60);
});

test('a test report is used only if this deploy wrote it, and reduced to allowlisted fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'status-record-'));
  const path = join(dir, 'report.json');
  await writeFile(
    path,
    JSON.stringify({
      finishedAt: '2026-10-26T17:00:00Z',
      passed: 3,
      failed: 1,
      skipped: 0,
      seconds: 12.5,
      areas: ['exhibition'],
      risk: 'high',
      base: 'http://127.0.0.1:4398',
      tests: [
        { name: 'a step lands', file: 'exhibition.browser.ts', ok: false, error: 'stack trace' },
      ],
    }),
  );
  assert.equal(
    summarise(path, '2026-10-26T18:00:00Z'),
    null,
    'an older report is never attributed to this deploy',
  );
  assert.deepEqual(summarise(path, '2026-10-26T16:00:00Z'), {
    passed: 3,
    failed: 1,
    skipped: 0,
    seconds: 12.5,
    areas: ['exhibition'],
    risk: 'high',
    tests: [{ name: 'a step lands', file: 'exhibition.browser.ts', ok: false }],
  });
  assert.equal(summarise(join(dir, 'missing.json'), ''), null);
});
