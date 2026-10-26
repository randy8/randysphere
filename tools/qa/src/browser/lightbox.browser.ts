/**
 * The lightbox: the right photograph, at once, every time — including the
 * case that flickered before 2026-10-26 (a reused <img> showing its old
 * photograph until the new one arrived) — plus order, keyboard, focus,
 * touch and history.
 */

import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { waitForFirstScreen } from './checks.ts';
import { BASE, browserTest, PHONE } from './harness.ts';

const tiles = (page: Page) => page.locator('[data-grid] > [data-photo-id]');

async function activeLoaded(page: Page, id: string | null): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const active = document.querySelector<HTMLElement>('.lightbox-item.is-active');
      const img = active?.querySelector('img');
      return (
        (want === null || active?.dataset['photoId'] === want) &&
        img?.complete === true &&
        img.naturalWidth > 0
      );
    },
    id,
    { timeout: 30_000 },
  );
}

const activeId = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLElement>('.lightbox-item.is-active')?.dataset['photoId'] ?? null,
  );

browserTest(
  'reopened on a slow connection, it shows the clicked photograph — never the one before',
  async ({ page, context }, t) => {
    if ((process.env['QA_BROWSER'] ?? 'chromium') !== 'chromium')
      return t.skip('network throttling needs Chromium');
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    await tiles(page).nth(0).locator('a').click();
    await activeLoaded(page, await tiles(page).nth(0).getAttribute('data-photo-id'));
    await page.keyboard.press('Escape');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 300,
      downloadThroughput: 150_000,
      uploadThroughput: 75_000,
    });
    const second = tiles(page).nth(5);
    const id = (await second.getAttribute('data-photo-id')) ?? '';
    // Watch every frame from the click on: the active slot's image may be
    // empty or this photograph's, never another's.
    await page.evaluate((want) => {
      const w = window as unknown as { __stale: string[] };
      w.__stale = [];
      const started = performance.now();
      const tick = (): void => {
        const img = document.querySelector<HTMLImageElement>('.lightbox-item.is-active img');
        const src = img?.currentSrc ?? '';
        if (
          !document.querySelector<HTMLElement>('[data-lightbox]')?.hidden &&
          src !== '' &&
          !src.includes(`/p/${want}/`)
        ) {
          w.__stale.push(src);
        }
        if (performance.now() - started < 2500) requestAnimationFrame(tick);
        else (window as unknown as { __staleDone: boolean }).__staleDone = true;
      };
      requestAnimationFrame(tick);
    }, id);
    await second.locator('a').click();
    await page.waitForFunction(
      () => (window as unknown as { __staleDone?: boolean }).__staleDone === true,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { __stale: string[] }).__stale),
      [],
    );
  },
  { seed: 2 },
);

browserTest(
  'arrows follow the grid’s own order and wrap at both ends',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const order = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-grid] > [data-photo-id]'),
        (el) => el.dataset['photoId'] ?? '',
      ),
    );
    await tiles(page).nth(0).locator('a').click();
    await activeLoaded(page, order[0] ?? null);
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeId(page), order[1]);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await activeId(page), order.at(-1));
  },
  { seed: 3 },
);

browserTest(
  'rapid stepping settles on a loaded photograph with both neighbours ready',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    await tiles(page).nth(0).locator('a').click();
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await activeLoaded(page, null);
    const slots = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.lightbox-item'),
        (slot) => slot.dataset['photoId'] ?? '',
      ),
    );
    assert.equal(new Set(slots).size, 3, 'the three slots should hold three different photographs');
    assert.equal(
      await page.locator('.lightbox-item img').count(),
      3,
      'replaced images were left behind',
    );
  },
  { seed: 4 },
);

browserTest(
  'moving between photographs never fills the history: Back leaves the page',
  async ({ page }) => {
    await page.goto(`${BASE}/collections/`);
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    await tiles(page).nth(0).locator('a').click();
    await activeLoaded(page, null);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.goBack();
    assert.equal(new URL(page.url()).pathname, '/collections/');
  },
  { seed: 5 },
);

browserTest(
  'touch: a swipe left steps forward',
  async ({ page, context }, t) => {
    if ((process.env['QA_BROWSER'] ?? 'chromium') !== 'chromium')
      return t.skip('synthetic touch needs Chromium');
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    await tiles(page).nth(0).locator('a').tap();
    await activeLoaded(page, null);
    const before = await activeId(page);
    const cdp = await context.newCDPSession(page);
    const y = 420;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 320, y }],
    });
    for (const x of [280, 230, 170, 110, 60]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(
      (was) =>
        document.querySelector<HTMLElement>('.lightbox-item.is-active')?.dataset['photoId'] !== was,
      before,
    );
  },
  { ...PHONE, seed: 6 },
);

browserTest(
  'the caption names only the film stock, and tapping it opens every photograph on that stock',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    // A photograph whose roll has a stock noted.
    const tile = page
      .locator('[data-grid] > [data-photo-id][data-film-stock]:not([data-film-stock=""])')
      .first();
    const stock = await tile.getAttribute('data-film-stock');
    await tile.locator('a').tap();
    await activeLoaded(page, null);
    const meta = page.locator('.lightbox-item.is-active [data-slot-film]');
    const text = (await meta.innerText()).trim();
    assert.doesNotMatch(text, /frame/i, 'the frame number is shown');
    assert.equal(text, text.toUpperCase());
    assert.ok(text.length > 0 && !text.includes('·'), `unexpected caption "${text}"`);
    await meta.locator('a').tap();
    await page.waitForURL(`**/exposures/film/${stock ?? ''}/`);
    const shown = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-grid] > [data-photo-id]'),
        (f) => f.dataset['photoId'],
      ),
    );
    assert.ok(shown.length > 0, 'the stock page is empty');
  },
  { ...PHONE, seed: 12 },
);
