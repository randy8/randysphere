import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readCities } from './cities.ts';

test('readCities reads tag/name pairs in order, defaulting a missing name to the tag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-cities-'));
  await writeFile(
    join(directory, 'cities.yaml'),
    'cities:\n  - tag: nyc\n    name: NYC\n  - tag: paris\n  - name: no tag, skipped\n',
  );
  assert.deepEqual(await readCities(directory), [
    { tag: 'nyc', name: 'NYC' },
    { tag: 'paris', name: 'paris' },
  ]);
});

test('readCities treats a missing file as no cities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-cities-'));
  assert.deepEqual(await readCities(directory), []);
});
