import assert from 'node:assert/strict';
import { test } from 'node:test';

import { format } from 'prettier';
import { parse } from 'yaml';

import {
  cleanTag,
  cleanText,
  draftProblems,
  flagUngroundedAmounts,
  normalizeDraft,
  numbersIn,
  slugify,
  stepLine,
  toRecipeYaml,
} from './draft.ts';
import type { Draft, DraftSource } from './draft.ts';

const SOURCE: DraftSource = {
  url: 'https://www.instagram.com/reel/C9xYz_Ab-12/',
  shortcode: 'C9xYz_Ab-12',
  creator: 'somecook',
  creatorName: 'Some Cook',
  via: 'caption',
};

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    title: 'Crispy Gochujang Tofu',
    description: 'Air-fried tofu in a sticky gochujang glaze.',
    prepTime: '10 min',
    cookTime: '20 min',
    totalTime: '30 min',
    servings: '2',
    ingredients: [
      { amount: '1 block', text: 'extra-firm tofu, pressed', flag: '' },
      { amount: '2 tbsp', text: 'gochujang', flag: '' },
      { amount: '', text: "Baker's salt, to taste", flag: '' },
    ],
    optionalIngredients: [{ amount: '', text: 'Sesame seeds', flag: '' }],
    instructions: [
      { text: 'Air fry the tofu at 400°F for 15–20 minutes.', flag: '' },
      { text: 'Toss in the glaze.', flag: '' },
    ],
    notes: [],
    tags: ['korean', 'tofu'],
    source: SOURCE,
    warnings: [],
    ...overrides,
  };
}

test('cleanText strips control, zero-width and bidi characters and the ** markup', () => {
  assert.equal(cleanText('  two\u0000\nlines\t here  '), 'two lines here');
  assert.equal(cleanText('safe‮txt.exe​'), 'safetxt.exe');
  assert.equal(cleanText('**2 cups** flour'), '2 cups flour');
  assert.equal(cleanText(42), '');
  assert.equal(cleanText('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
});

test('cleanTag keeps lowercase words and hyphens and drops the rest', () => {
  assert.equal(cleanTag('#Air Fryer'), 'air-fryer');
  assert.equal(cleanTag('Korean 🇰🇷'), 'korean');
  assert.equal(cleanTag('🔥'), null);
  assert.equal(cleanTag('x'.repeat(40)), null);
});

test('normalizeDraft fills every field, drops junk, and never trusts the posted source URL', () => {
  const normalized = normalizeDraft(
    {
      title: ['not', 'a', 'string'],
      ingredients: [{ amount: 2, text: '  salt ' }, 'junk', { text: '' }, null],
      instructions: 'not a list',
      tags: ['Tofu', 'tofu', '#Weeknight'],
      source: { url: 'https://evil.example/', creator: '@some.cook', via: 'bogus' },
    },
    SOURCE,
  );
  assert.equal(normalized.title, '');
  assert.deepEqual(normalized.ingredients, [{ amount: '', text: 'salt', flag: '' }]);
  assert.deepEqual(normalized.instructions, []);
  assert.deepEqual(normalized.tags, ['tofu', 'weeknight']);
  assert.equal(normalized.source.url, SOURCE.url);
  assert.equal(normalized.source.creator, 'some.cook');
  assert.equal(normalized.source.via, 'caption');
});

test('normalizeDraft drops a creator handle that is not one', () => {
  const normalized = normalizeDraft({ source: { creator: 'javascript:alert(1)' } }, SOURCE);
  assert.equal(normalized.source.creator, '');
});

test('draftProblems names what is missing before a draft can be saved', () => {
  assert.deepEqual(draftProblems(draft()), []);
  assert.equal(draftProblems(draft({ title: '', ingredients: [], instructions: [] })).length, 3);
});

test('numbersIn reads digits, fractions, glyphs and number words', () => {
  assert.deepEqual(numbersIn('1 1/2 cups'), [1, 0.5]);
  assert.deepEqual(numbersIn('1½ tbsp'), [1, 0.5]);
  assert.deepEqual(numbersIn('half a lemon'), [0.5, 1]);
  assert.deepEqual(numbersIn('two 400g tins'), [2, 400]);
  assert.deepEqual(numbersIn('0,5 l'), [0.5]);
});

test('an amount the caption never mentions is flagged; stated ones are not', () => {
  const caption =
    'You need 1 block tofu, 2 tbsp gochujang, 1/2 tsp garlic powder and a pinch of salt';
  const flagged = flagUngroundedAmounts(
    [
      { amount: '1 block', text: 'tofu', flag: '' },
      { amount: '2 tbsp', text: 'gochujang', flag: '' },
      { amount: '½ tsp', text: 'garlic powder', flag: '' },
      { amount: 'a pinch', text: 'salt', flag: '' },
      { amount: '3 tbsp', text: 'soy sauce', flag: '' },
      { amount: '', text: 'oil', flag: '' },
      { amount: '9', text: 'kept', flag: 'Model already flagged this.' },
    ],
    caption,
  );
  assert.deepEqual(
    flagged.map((line) => line.flag !== ''),
    [false, false, false, false, true, false, true],
  );
  assert.equal(flagged[6]?.flag, 'Model already flagged this.');
});

test('slugify makes a file name from a title', () => {
  assert.equal(slugify('Crème Brûlée & Berries!'), 'creme-brulee-and-berries');
  assert.equal(slugify('🔥🔥'), '');
  assert.ok(slugify('word '.repeat(40)).length <= 60);
  assert.ok(!slugify('word '.repeat(40)).endsWith('-'));
});

test('stepLine marks times and temperatures the way the hand-written recipes do', () => {
  assert.equal(
    stepLine({ text: 'Bake at 200 °C for 15–20 minutes, then rest 5 min.', flag: '' }),
    'Bake at **200 °C** for **15–20 minutes**, then rest **5 min**.',
  );
});

test('toRecipeYaml writes the fields the site reads, with amounts in bold, and the credit', () => {
  const text = toRecipeYaml(draft(), new Date(2026, 10, 7));
  const data = parse(text) as Record<string, unknown>;
  assert.equal(data['title'], 'Crispy Gochujang Tofu');
  assert.deepEqual(data['ingredients'], [
    '**1 block** extra-firm tofu, pressed',
    '**2 tbsp** gochujang',
    "Baker's salt, to taste",
  ]);
  assert.deepEqual(data['instructions'], [
    'Air fry the tofu at **400°F** for **15–20 minutes**.',
    'Toss in the glaze.',
  ]);
  assert.deepEqual(data['tags'], ['korean', 'tofu']);
  assert.deepEqual(data['source'], {
    platform: 'Instagram',
    url: SOURCE.url,
    creator: '@somecook',
    creatorUrl: 'https://www.instagram.com/somecook/',
    creatorName: 'Some Cook',
    importedFrom: 'caption',
    imported: '2026-11-07',
  });
  assert.equal(data['created'], 'Nov 2026');
  assert.equal(data['notes'], undefined, 'empty lists are left out, as by hand');
});

test('a line still flagged at save time is published as an Unconfirmed note', () => {
  const text = toRecipeYaml(
    draft({
      ingredients: [{ amount: '3 tbsp', text: 'soy sauce', flag: 'Amount not in the caption.' }],
      instructions: [{ text: 'Cook until done.', flag: 'No time given.' }],
      notes: ['Keeps for 3 days.'],
    }),
    new Date(2026, 10, 7),
  );
  assert.deepEqual((parse(text) as { notes: string[] }).notes, [
    'Keeps for 3 days.',
    'Unconfirmed: soy sauce (Amount not in the caption)',
    'Unconfirmed: Step 1 (No time given)',
  ]);
});

test('the file is written exactly as Prettier would format it, so `pnpm check` passes', async () => {
  const text = toRecipeYaml(
    draft({
      description: 'He said "it\'s the best" — with ½ cup of everything: really.',
      notes: ['# not a comment', 'yes', '- not a list', '"quoted"'],
    }),
    new Date(2026, 10, 7),
  );
  const formatted = await format(text, { parser: 'yaml', singleQuote: true, printWidth: 100 });
  assert.equal(text, formatted);
  // And it round-trips: YAML-significant text stays text.
  const data = parse(text) as { notes: string[]; description: string };
  assert.deepEqual(data.notes, ['# not a comment', 'yes', '- not a list', '"quoted"']);
  assert.equal(data.description, 'He said "it\'s the best" — with ½ cup of everything: really.');
});
