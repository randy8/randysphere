/**
 * The photo grid: geometry at every column count, layout stability, a
 * failed photograph, the tag and film pages, and the main-thread budget
 * that the 2026-10-26 layout loop broke (2.9 s of a throttled phone's main
 * thread, from 251 forced style passes).
 */

import assert from 'node:assert/strict';
import { gridGeometry, waitForFirstScreen } from './checks.ts';
import { BASE, browserTest, mixedTag, publicPhotos } from './harness.ts';

for (const [width, height, columns] of [
  [390, 844, 2],
  [820, 1180, 3],
  [1440, 900, 4],
  [2560, 1440, 4],
] as const) {
  browserTest(
    `${String(width)}×${String(height)}: ${String(columns)} columns, nothing distorted, overlapping or overflowing`,
    async ({ page }) => {
      await page.goto(`${BASE}/exposures/`);
      await waitForFirstScreen(page);
      const grid = await gridGeometry(page);
      assert.equal(grid.columns, columns);
      assert.deepEqual(grid.distorted, []);
      assert.deepEqual(grid.overlapping, []);
      assert.deepEqual(grid.outside, []);
      assert.equal(grid.pageOverflowsX, false);
    },
    { viewport: { width, height }, seed: 7 },
  );
}

browserTest(
  'loading the page shifts its layout by less than 0.05',
  async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        })[]) {
          if (!entry.hadRecentInput) w.__cls += entry.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    await page.evaluate(() => document.fonts.ready);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    assert.ok(cls < 0.05, `CLS ${cls.toFixed(3)}`);
  },
  { seed: 8 },
);

browserTest(
  'the grid script stays within budget on a 4×-throttled phone',
  async ({ page, context }, t) => {
    if ((process.env['QA_BROWSER'] ?? 'chromium') !== 'chromium')
      return t.skip('CPU throttling needs Chromium');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const call = 'placeGrid(document.currentScript.previousElementSibling, true);';
    await page.route(`${BASE}/exposures/`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      assert.ok(body.includes(call), 'the inline grid call has changed shape; update this test');
      await route.fulfill({
        response,
        body: body.replace(
          call,
          `performance.mark('grid-start');${call}performance.mark('grid-end');`,
        ),
      });
    });
    await page.goto(`${BASE}/exposures/`);
    const ms = await page.evaluate(
      () => performance.measure('grid', 'grid-start', 'grid-end').duration,
    );
    // ~0.95 s on the development machine at 4× (2026-10-26); the broken
    // version took 2.9 s. The margin absorbs machine noise, not a regression.
    assert.ok(ms < 1800, `the grid script held the main thread for ${ms.toFixed(0)} ms`);
  },
  { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, seed: 9 },
);

browserTest(
  'a photograph that fails to load keeps its place; the grid around it is untouched',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    const id = await page
      .locator('[data-grid] > [data-photo-id]')
      .first()
      .getAttribute('data-photo-id');
    await page.route(`**/p/${id ?? ''}/**`, (route) => route.abort());
    await page.reload();
    await page.waitForFunction(
      () => {
        const eager = Array.from(
          document.querySelectorAll<HTMLImageElement>('[data-grid] img'),
        ).filter((img) => img.loading === 'eager');
        return eager.length > 0 && eager.every((img) => img.complete);
      },
      null,
      { timeout: 45_000 },
    );
    const grid = await gridGeometry(page);
    assert.deepEqual(grid.overlapping, []);
    assert.deepEqual(grid.distorted, []);
  },
  { seed: 10, allowErrors: ['Failed to load resource'] },
);

browserTest('a tag page and a film-stock page are the same grid', async ({ page }) => {
  const tag = await mixedTag();
  const film = (await publicPhotos())
    .map((photo) => (photo as unknown as { filmStock: string | null }).filmStock)
    .find((stock) => stock !== null);
  for (const path of [`/exposures/${tag}/`, ...(film ? [`/exposures/film/${film}/`] : [])]) {
    await page.goto(`${BASE}${path}`);
    await waitForFirstScreen(page);
    const grid = await gridGeometry(page);
    assert.ok(grid.tiles > 0, `${path}: empty`);
    assert.deepEqual(grid.overlapping, [], path);
    assert.deepEqual(grid.distorted, [], path);
  }
});

browserTest(
  'every film-stock option shows exactly that stock’s photographs, under its printed name',
  async ({ page }) => {
    await page.goto(`${BASE}/exposures/`);
    await waitForFirstScreen(page);
    const options = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLOptionElement>('[data-film-filter] option'),
        (o) => ({ value: o.value, text: o.text }),
      ),
    );
    assert.equal(options[0]?.text, 'SELECT FILM STOCK');
    const stocks = options.slice(1);
    assert.ok(stocks.length > 0, 'no film stocks offered');
    const inData = await page.evaluate(() =>
      [
        ...new Set(
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-grid] > [data-photo-id]'),
            (f) => f.dataset['filmStock'] ?? '',
          ),
        ),
      ]
        .filter((s) => s !== '')
        .sort(),
    );
    assert.deepEqual(
      stocks.map((o) => o.value).sort(),
      inData,
      'the options are not the stocks the photographs carry',
    );
    for (const { value, text } of stocks) {
      assert.equal(text, text.toUpperCase(), `${value}: not uppercase`);
      assert.notEqual(text, value.toUpperCase(), `${value}: shown as its identifier`);
      await page.selectOption('[data-film-filter]', value);
      const shown = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-grid] > [data-photo-id]'))
          .filter((f) => !f.hidden && f.getBoundingClientRect().height > 0)
          .map((f) => f.dataset['filmStock']),
      );
      const expected = await page.evaluate(
        (v) => document.querySelectorAll(`[data-grid] > [data-film-stock="${v}"]`).length,
        value,
      );
      assert.ok(shown.length > 0, `${text}: nothing shown`);
      assert.ok(
        shown.every((stock) => stock === value),
        `${text}: shows other stocks`,
      );
      assert.equal(shown.length, expected, `${text}: missing some of its photographs`);
    }
    await page.selectOption('[data-film-filter]', '');
  },
);

for (const width of [360, 375, 390, 430]) {
  browserTest(
    `${String(width)}px phone: two columns, the toolbar on one row under the title, nothing orphaned`,
    async ({ page }) => {
      await page.goto(`${BASE}/exposures/`);
      await waitForFirstScreen(page);
      const g = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.selected-toolbar');
        const tops = Array.from(bar?.children ?? [], (el) =>
          Math.round(el.getBoundingClientRect().top),
        );
        const nav = Array.from(document.querySelectorAll('.nameplate-list li'), (li) =>
          Math.round(li.getBoundingClientRect().top),
        );
        const title = document.querySelector('h1')?.getBoundingClientRect();
        return {
          rows: new Set(tops).size,
          navRows: new Set(nav).size,
          alignedLeft: Math.abs((bar?.getBoundingClientRect().left ?? 0) - (title?.left ?? -1)) < 1,
          gridTop: document.querySelector('[data-grid]')?.getBoundingClientRect().top ?? 0,
        };
      });
      const grid = await gridGeometry(page);
      assert.equal(grid.columns, 2);
      assert.equal(g.rows, 1, 'the toolbar wrapped');
      assert.equal(g.navRows, 1, 'the navigation wrapped');
      assert.ok(g.alignedLeft, 'the toolbar is not aligned to the title');
      assert.ok(g.gridTop < 260, `photographs start ${String(Math.round(g.gridTop))}px down`);
    },
    {
      viewport: { width, height: 800 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      seed: 11,
    },
  );
}

browserTest(
  'a refresh keeps the arrangement; a new session deals a new one',
  async ({ page, context }) => {
    const order = (p: typeof page) =>
      p.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>('[data-grid] > [data-photo-id]'),
          (f) => f.dataset['photoId'],
        ).join(','),
      );
    await page.goto(`${BASE}/exposures/`);
    const first = await order(page);
    await page.reload();
    assert.equal(await order(page), first, 'a refresh reshuffled the page');
    await page.goto(`${BASE}/collections/`);
    await page.goto(`${BASE}/exposures/`);
    assert.equal(await order(page), first, 'coming back reshuffled the page');
    const other = await context.browser()?.newContext();
    assert.ok(other);
    const fresh = await other.newPage();
    await fresh.goto(`${BASE}/exposures/`);
    assert.notEqual(await order(fresh), first, 'a new session did not reshuffle');
    await other.close();
  },
);
