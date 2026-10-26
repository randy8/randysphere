/**
 * Dishes: Make It Vegan — one toggle, the whole recipe changes together
 * (ingredients, steps, the swaps explained), the choice remembered across
 * recipes and visits, the scaler still scaling, and the index's Vegan
 * filter sharing the same choice.
 */

import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { BASE, browserTest, PHONE } from './harness.ts';

const RECIPE = `${BASE}/dishes/vegetarian-crunchwrap-supreme/`;

const visibleText = (page: Page, selector: string) =>
  page.evaluate(
    (s) =>
      Array.from(document.querySelectorAll<HTMLElement>(s))
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.innerText)
        .join('\n'),
    selector,
  );

browserTest('the toggle turns the whole recipe vegan, and back', async ({ page }) => {
  await page.goto(RECIPE);
  await page.locator('[data-version-toggle]').waitFor({ state: 'visible' });
  const before = await visibleText(page, '.recipe-doc-section');
  assert.match(before, /½ cup sour cream/);
  assert.doesNotMatch(before, /plant-based sour cream/);
  await page.getByRole('button', { name: 'Vegan', exact: true }).click();
  const after = await visibleText(page, '.recipe-doc-section');
  assert.match(after, /½ cup plant-based sour cream/);
  assert.match(
    after,
    /layer the seasoned beef, warm vegan nacho cheese/,
    'the steps did not follow the ingredients',
  );
  assert.match(after, /vegan swaps/i);
  assert.match(after, /direct swap/i);
  assert.doesNotMatch(after, /½ cup sour cream\b/);
  await page.getByRole('button', { name: 'Original', exact: true }).click();
  assert.match(await visibleText(page, '.recipe-doc-section'), /½ cup sour cream/);
});

browserTest('the choice is remembered across visits and across recipes', async ({ page }) => {
  await page.goto(RECIPE);
  await page.getByRole('button', { name: 'Vegan', exact: true }).click();
  await page.reload();
  await page.locator('[data-version-toggle]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.recipe-doc').getAttribute('data-version'), 'vegan');
  await page.goto(`${BASE}/dishes/cilantro-lime-rice/`);
  await page.locator('[data-version-toggle]').waitFor({ state: 'visible' });
  assert.match(await visibleText(page, '.recipe-doc-list'), /15 g plant-based butter/);
});

browserTest('scaling scales the vegan version too', async ({ page }) => {
  await page.goto(RECIPE);
  await page.getByRole('button', { name: 'Vegan', exact: true }).click();
  await page.getByRole('button', { name: '2×' }).click();
  assert.match(await visibleText(page, '.recipe-doc-list'), /1 cup plant-based sour cream/);
});

browserTest('a recipe that is vegan as written says so, and offers no toggle', async ({ page }) => {
  await page.goto(`${BASE}/dishes/guacamole/`);
  assert.match(await page.locator('.recipe-doc-meta').innerText(), /VEGAN/i);
  assert.equal(await page.locator('[data-version-toggle]').count(), 0);
});

browserTest(
  'the index labels each recipe, and its Vegan filter is the same choice as the toggle',
  async ({ page }) => {
    await page.goto(`${BASE}/dishes/`);
    await page.locator('[data-diet-filter]').waitFor({ state: 'visible' });
    const labels = await page.locator('.recipe-index-diet').allInnerTexts();
    assert.ok(
      labels.some((l) => /^vegan$/i.test(l.trim())),
      'no recipe labelled vegan',
    );
    assert.ok(
      labels.some((l) => /can be made vegan/i.test(l)),
      'no recipe labelled adaptable',
    );
    await page.getByRole('button', { name: 'Vegan', exact: true }).click();
    const shown = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-diet]'))
        .filter((li) => !li.hidden)
        .map((li) => li.dataset['diet']),
    );
    assert.ok(shown.length > 0 && shown.every((d) => d === 'vegan' || d === 'adaptable'));
    await page.locator('a[href="/dishes/vegetarian-crunchwrap-supreme/"]').click();
    await page.locator('[data-version-toggle]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.recipe-doc').getAttribute('data-version'), 'vegan');
  },
  PHONE,
);

browserTest(
  'without JavaScript the recipe reads as written, with no toggle and nothing doubled',
  async ({ page }) => {
    await page.goto(RECIPE);
    const text = await visibleText(page, '.recipe-doc-section');
    assert.match(text, /½ cup sour cream/);
    assert.doesNotMatch(text, /plant-based sour cream|vegan swaps/i);
    assert.equal(await page.locator('[data-version-toggle]').isVisible(), false);
  },
  { javaScriptEnabled: false },
);
