import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { readLibrary, veganVersion } from './vegan.ts';
import type { RecipeLines } from './vegan.ts';

const library = readLibrary(
  parse(
    readFileSync(new URL('../../../recipes/substitutions/vegan.yaml', import.meta.url), 'utf8'),
  ),
);

const lines = (
  ingredients: string[],
  instructions: string[] = [],
  optionalIngredients: string[] = [],
): RecipeLines => ({
  ingredients,
  instructions,
  optionalIngredients,
});

const vegan = (line: string): string =>
  veganVersion(lines([line]), library).ingredients[0]?.vegan ?? '';

test('the library is well formed: ids unique, every option explained and classified', () => {
  assert.ok(library.length >= 25);
  for (const entry of library) {
    for (const option of entry.options) {
      assert.ok(option.why.length > 20, `${entry.id}/${option.id}: explain why`);
    }
  }
});

test('a malformed library is refused with the entry named', () => {
  assert.throws(
    () =>
      readLibrary([
        {
          id: 'x',
          matches: ['x'],
          options: [{ id: 'a', use: 'y', confidence: 'maybe', why: 'z' }],
        },
      ]),
    /entry x.*confidence/,
  );
  assert.throws(() => readLibrary([{ id: 'x', matches: ['x'], options: [] }]), /needs options/);
  assert.throws(
    () =>
      readLibrary([
        {
          id: 'x',
          matches: ['x'],
          options: [{ id: 'a', use: 'y', confidence: 'direct', why: 'z' }],
        },
        {
          id: 'x',
          matches: ['y'],
          options: [{ id: 'a', use: 'y', confidence: 'direct', why: 'z' }],
        },
      ]),
    /used twice/,
  );
});

test('swaps keep the quantity and the rest of the line', () => {
  assert.equal(vegan('**½ cup** sour cream'), '**½ cup** plant-based sour cream');
  assert.equal(vegan('**1 cup** nacho cheese sauce'), '**1 cup** vegan nacho cheese sauce');
  assert.equal(vegan('**15 g** butter'), '**15 g** plant-based butter');
  assert.equal(
    vegan('**4** extra-large flour tortillas (burrito size)'),
    '**4** extra-large vegan flour tortillas (burrito size)',
  );
});

test('capitals and plurals follow the original', () => {
  assert.equal(vegan('Butter'), 'Plant-based butter');
  assert.equal(vegan('Other favorite cheeses'), 'Other favorite vegan cheeses');
  assert.equal(vegan('**2** eggs'), '**2** flax eggs');
});

test('what is already plant-based is left alone', () => {
  for (const line of [
    '**½–1** package Abbott’s vegan ground beef (~**140–280 g**)',
    '**1½ cups** dry TVP (or equivalent plant-based ground beef)',
    '**2 tbsp** peanut butter',
    '**1 can** coconut milk',
    '**1 cup** oat milk',
    '**½ tsp** cream of tartar',
    '**1 can** butter beans',
    '**1¼ cups** hot vegetable broth',
    '**1** eggplant',
    '**2 tbsp** dairy-free cream cheese',
    '**100 g** chickpeas',
    '**50 g** dark chocolate',
  ]) {
    assert.equal(vegan(line), line, line);
  }
});

test('a specific ingredient wins over a general one in the same words', () => {
  assert.equal(vegan('**200 g** cream cheese'), '**200 g** plant-based cream cheese');
  assert.equal(vegan('**¼ cup** grated Parmesan'), '**¼ cup** grated vegan parmesan');
  assert.equal(vegan('**1 cup** buttermilk'), '**1 cup** soy milk soured with lemon juice');
});

test('a brand before a product that is not vegan goes with it', () => {
  assert.equal(vegan('**120 g** Seggiano pesto'), '**120 g** vegan pesto');
  assert.equal(vegan("**454 g** Rao's penne"), "**454 g** Rao's penne");
  const steps = veganVersion(
    lines(['**120 g** pesto'], ['Stir into the pesto mixture.', 'The pesto goes last.']),
    library,
  );
  assert.equal(steps.instructions[0]?.vegan, 'Stir into the vegan pesto mixture.');
  assert.equal(steps.instructions[1]?.vegan, 'The vegan pesto goes last.');
});

test('instructions change with the ingredients, and only for what was swapped', () => {
  const version = veganVersion(
    lines(
      ['**½ cup** sour cream'],
      ['Layer the beef, nacho cheese and sour cream.', 'Add the butter.'],
    ),
    library,
  );
  assert.equal(
    version.instructions[0]?.vegan,
    'Layer the beef, nacho cheese and plant-based sour cream.',
  );
  // Butter isn't in this recipe's ingredients, so a stray mention stays.
  assert.equal(version.instructions[1]?.vegan, 'Add the butter.');
});

test('no reliable swap means the line stays, the reason is kept, and the recipe is not offered as vegan', () => {
  const version = veganVersion(lines(['**2 tbsp** gelatin', '**15 g** butter']), library);
  assert.equal(version.status, 'not-adaptable');
  assert.equal(version.ingredients[0]?.vegan, '**2 tbsp** gelatin');
  assert.equal(version.unresolved[0]?.entry.id, 'gelatin');
});

test('a recipe can choose another option for an ingredient', () => {
  const version = veganVersion(lines(['**4** eggs']), library, { use: { egg: 'just-egg' } });
  assert.equal(version.ingredients[0]?.vegan, '**4** JUST Egg');
  assert.throws(
    () => veganVersion(lines(['**4** eggs']), library, { use: { egg: 'nope' } }),
    /no option "nope"/,
  );
});

test('the recipe given is never modified', () => {
  const recipe = lines(['**15 g** butter'], ['Add the butter.']);
  const before = JSON.stringify(recipe);
  veganVersion(recipe, library);
  assert.equal(JSON.stringify(recipe), before);
});

test('status: nothing to change is vegan; every swap reliable is adaptable', () => {
  assert.equal(
    veganVersion(lines(['**3** avocados', 'Juice of **1** lime']), library).status,
    'vegan',
  );
  assert.equal(veganVersion(lines(['**15 g** butter']), library).status, 'adaptable');
});
