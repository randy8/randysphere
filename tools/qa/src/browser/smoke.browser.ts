/**
 * The deployment gate: the paths a visitor can't do without, each checked
 * for behaviour and geometry rather than pixels. Runs on every deploy,
 * against the candidate release before it goes live (deploy/deploy.sh), so
 * it must stay fast and must never depend on timing luck: every wait is
 * for a state, never a fixed delay.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE, browserTest, mixedTag, PHONE, publicPhotos } from './harness.ts';
import { exhibitionAtRest, gridGeometry, waitForFirstScreen } from './checks.ts';

browserTest(
  'Exposures: every photograph at its own proportions, none overlapping, the first screen loaded',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const grid = await gridGeometry(page);
    assert.ok(grid.tiles > 0, 'no photographs in the grid');
    assert.ok(grid.firstScreen > 0, 'nothing marked as first-screen');
    assert.deepEqual(grid.distorted, [], 'photographs drawn at the wrong aspect ratio');
    assert.deepEqual(grid.overlapping, [], 'photographs overlapping');
    assert.deepEqual(grid.outside, [], 'photographs outside the grid');
  },
  { seed: 1 },
);

browserTest(
  'Exposures on a phone: two columns, the same guarantees',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const grid = await gridGeometry(page);
    assert.equal(grid.columns, 2);
    assert.deepEqual(grid.distorted, []);
    assert.deepEqual(grid.overlapping, []);
    assert.equal(grid.pageOverflowsX, false, 'the page scrolls sideways');
  },
  { ...PHONE, seed: 1 },
);

browserTest(
  'Lightbox: opens on the clicked photograph, steps, closes back to it',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const tile = page.locator('[data-grid] > [data-photo-id]').first();
    const id = await tile.getAttribute('data-photo-id');
    await tile.locator('a').click();
    await page.waitForFunction(
      (want) => {
        const active = document.querySelector<HTMLElement>('.lightbox-item.is-active');
        const img = active?.querySelector('img');
        return (
          active?.dataset['photoId'] === want && img?.complete === true && img.naturalWidth > 0
        );
      },
      id,
      { timeout: 30_000 },
    );
    assert.equal(new URL(page.url()).hash, `#photo-${id ?? ''}`);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((was) => !location.hash.endsWith(was ?? ''), id);
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>('[data-lightbox]')?.hidden === true,
    );
    assert.equal(new URL(page.url()).hash, '');
    const focused = await page.evaluate(() =>
      document.activeElement?.closest('[data-photo-id]')?.getAttribute('data-photo-id'),
    );
    assert.equal(focused, id, 'focus did not return to the photograph that was opened');
  },
  { seed: 1 },
);

browserTest('A #photo- link opens straight onto that photograph', async ({ page }) => {
  const photos = await publicPhotos();
  const target = photos[Math.floor(photos.length / 2)]!;
  await page.goto(`${BASE}/exposures/#photo-${target.id}`);
  await page.waitForFunction(
    (want) =>
      document.querySelector<HTMLElement>('.lightbox-item.is-active')?.dataset['photoId'] === want,
    target.id,
  );
});

browserTest(
  'Exhibition: the first photograph arrives, a step lands, one photograph at rest, controls clear of it',
  async ({ page }) => {
    const tag = await mixedTag();
    await page.goto(
      `${BASE}/exposures/gallery/?tag=${tag}&order=sequence&slide=30&fade=1&motion=0`,
    );
    await page.waitForFunction(
      () => document.querySelector('[data-position]')?.textContent?.startsWith('1 /'),
      null,
      {
        timeout: 30_000,
      },
    );
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => document.querySelector('[data-position]')?.textContent?.startsWith('2 /'),
      null,
      {
        timeout: 30_000,
      },
    );
    await page.mouse.move(300, 300);
    const state = await exhibitionAtRest(page);
    assert.equal(state.visibleLayers, 1, 'not exactly one photograph on the wall');
    assert.ok(state.loaded, 'the photograph on the wall has not loaded');
    assert.ok(
      Math.abs(state.drawnRatio / state.photoRatio - 1) < 0.01,
      'drawn at the wrong aspect ratio',
    );
    assert.equal(state.overlapsControls, false, 'controls lie over the photograph');
    assert.equal(state.insideViewport, true, 'photograph runs off the screen');
  },
);

browserTest(
  'Save a photograph, share it, and the link shows exactly that photograph',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const tile = page.locator('[data-grid] > [data-photo-id]').first();
    const id = await tile.getAttribute('data-photo-id');
    await tile.hover();
    await tile.locator('[data-tile-save]').click();
    await page.goto(`${BASE}/exposures/saved/`);
    await page.locator('[data-share-all]').click();
    const link = await page.locator('[data-share-url]').inputValue();
    assert.match(link, /\/exposures\/share\/\?p=/);
    await page.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-share-grid] > [data-photo-id]:not([hidden])').length > 0,
    );
    const shown = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-share-grid] > [data-photo-id]:not([hidden])'),
        (el) => el.dataset['photoId'],
      ),
    );
    assert.deepEqual(shown, [id]);
  },
  { seed: 1 },
);

for (const path of [
  '/collections/',
  '/dishes/',
  '/pictures/',
  '/exposures/saved/',
  '/exposures/archive/',
  '/system',
]) {
  browserTest(`${path} renders without errors`, async ({ page }) => {
    const response = await page.goto(`${BASE}${path}`);
    assert.equal(response?.status(), 200);
    await page.waitForLoadState('load');
    assert.ok((await page.locator('h1').count()) > 0, 'no heading');
  });
}

browserTest(
  'Without JavaScript, Exposures is still a grid of photographs that link to the full size',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    const first = page.locator('[data-grid] > [data-photo-id] img').first();
    await first.evaluate((img: HTMLImageElement) =>
      img.complete
        ? undefined
        : new Promise((done) => img.addEventListener('load', done, { once: true })),
    );
    assert.ok(
      await first.evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
      'first photograph did not load',
    );
    const href = await page.locator('[data-grid] > [data-photo-id] a').first().getAttribute('href');
    assert.match(href ?? '', /^\/p\/.+\.jpg$/);
  },
  { javaScriptEnabled: false },
);

void test('/ redirects to /exposures/ with a real redirect', async () => {
  const res = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/exposures/');
});

void test('security: headers on public and private responses; /private is gated and never stored', async () => {
  const expected = {
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
  };
  for (const path of ['/exposures/', '/private']) {
    const res = await fetch(`${BASE}${path}`);
    for (const [name, value] of Object.entries(expected))
      assert.equal(res.headers.get(name), value, `${name} on ${path}`);
  }
  const gate = await fetch(`${BASE}/private`);
  assert.equal(gate.headers.get('cache-control'), 'private, no-store');
  assert.match(await gate.text(), /type="password"/);
  assert.equal((await fetch(`${BASE}/private/photos/anything.jpg`)).status, 401);
  assert.equal((await fetch(`${BASE}/originals/`)).status, 404);
});

browserTest('every page’s footer links to Site status, and it opens', async ({ page }) => {
  for (const path of ['/exposures/', '/pictures/', '/dishes/']) {
    await page.goto(`${BASE}${path}`);
    const link = page.locator('.site-footer a[href="/system"]');
    assert.equal(await link.count(), 1, path);
    assert.match(await link.innerText(), /site status/i);
  }
  const res = await page.goto(`${BASE}/system`);
  assert.equal(res?.status(), 200);
  assert.match(await page.locator('.subtitle').innerText(), /An ongoing record of this website/);
});
