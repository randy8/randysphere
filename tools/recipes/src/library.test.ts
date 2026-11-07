import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeDraft } from './draft.ts';
import type { Draft } from './draft.ts';
import { findByShortcode, freeSlug, saveDraft } from './library.ts';

function directory(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'recipes-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function draft(shortcode = 'C9xYz_Ab-12', title = 'Sesame Tofu'): Draft {
  return normalizeDraft(
    {
      title,
      ingredients: [{ amount: '1 block', text: 'tofu' }],
      instructions: [{ text: 'Cook it.' }],
    },
    {
      url: `https://www.instagram.com/reel/${shortcode}/`,
      shortcode,
      creator: 'somecook',
      creatorName: '',
      via: 'pasted',
    },
  );
}

test('a Reel already imported is found however its URL was written', () => {
  const dir = directory({
    'mine.yaml': "title: 'Mine'\n",
    'broken.yaml': 'title: [unclosed\n',
    'imported.yaml':
      "title: 'Gochujang Noodles'\nsource:\n  url: 'https://instagram.com/p/C9xYz_Ab-12/?igsh=abc'\n",
  });
  assert.deepEqual(findByShortcode(dir, 'C9xYz_Ab-12'), {
    slug: 'imported',
    title: 'Gochujang Noodles',
  });
  assert.equal(findByShortcode(dir, 'Zz9xYz_Ab-12'), null);
  assert.equal(findByShortcode(join(dir, 'missing'), 'C9xYz_Ab-12'), null);
});

test('freeSlug never reuses a taken name', () => {
  const dir = directory({ 'sesame-tofu.yaml': '', 'sesame-tofu-2.yaml': '' });
  assert.equal(freeSlug(dir, 'Sesame Tofu', 'C9xYz_Ab-12'), 'sesame-tofu-3');
  assert.equal(freeSlug(dir, 'Pesto Penne', 'C9xYz_Ab-12'), 'pesto-penne');
  assert.equal(freeSlug(dir, '🔥', 'C9xYz_Ab-12'), 'reel-c9xyzab12');
});

test('saveDraft writes a new file beside existing recipes and leaves them untouched', () => {
  const dir = directory({ 'sesame-tofu.yaml': "title: 'Sesame Tofu'\n" });
  const result = saveDraft(dir, draft(), new Date(2026, 10, 7));
  assert.deepEqual(result, {
    ok: true,
    slug: 'sesame-tofu-2',
    path: join(dir, 'sesame-tofu-2.yaml'),
  });
  assert.equal(readFileSync(join(dir, 'sesame-tofu.yaml'), 'utf8'), "title: 'Sesame Tofu'\n");
  assert.match(readFileSync(join(dir, 'sesame-tofu-2.yaml'), 'utf8'), /^title: 'Sesame Tofu'$/m);
});

test('saveDraft refuses the same Reel twice, even under a different title', () => {
  const dir = directory();
  assert.equal(saveDraft(dir, draft()).ok, true);
  const again = saveDraft(dir, draft('C9xYz_Ab-12', 'Another Name'));
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, 'duplicate');
  assert.equal(readdirSync(dir).length, 1);
});

test('saveDraft refuses an incomplete draft and writes nothing', () => {
  const dir = directory();
  const result = saveDraft(dir, { ...draft(), title: '', instructions: [] });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason === 'invalid' && result.problems.length, 2);
  assert.deepEqual(readdirSync(dir), []);
});
