/**
 * Exhibition's one rule — exactly one photograph on the wall, except
 * during a crossfade between two of the same frame — under the conditions
 * that broke it before (2026-10-26: rapid steps across portrait/landscape
 * held both on the wall at 1.00/0.84), plus its geometry everywhere it can
 * be shown. The tag used is whichever mixes orientations most.
 */

import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { exhibitionAtRest, wallReport, watchTheWall } from './checks.ts';
import { BASE, browserTest, mixedTag, PHONE, publicPhotos } from './harness.ts';

async function open(page: Page, query: string): Promise<string> {
  const tag = await mixedTag();
  await page.goto(`${BASE}/exposures/gallery/?tag=${tag}&order=sequence&${query}`);
  await atPosition(page, 1);
  await exhibitionAtRest(page);
  return tag;
}

function atPosition(page: Page, n: number): Promise<unknown> {
  return page.waitForFunction(
    (want) =>
      document.querySelector('[data-position]')?.textContent?.startsWith(`${String(want)} /`),
    n,
    { timeout: 30_000 },
  );
}

browserTest(
  'rapid stepping across portrait and landscape never leaves two frames on the wall',
  async ({ page }) => {
    await open(page, 'slide=30&fade=2');
    await watchTheWall(page);
    for (const key of [
      'ArrowRight',
      'ArrowRight',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowLeft',
      'ArrowRight',
    ]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(90); // the pace of a visitor tapping, not a wait for state
    }
    const rest = await exhibitionAtRest(page);
    const wall = await wallReport(page);
    assert.ok(wall.frames > 10, 'the wall was not watched');
    assert.deepEqual(wall.breaches, []);
    assert.equal(rest.visibleLayers, 1);
    assert.ok(rest.loaded);
  },
);

browserTest('paused, every step still lands, and it stays paused', async ({ page }) => {
  await open(page, 'slide=30&fade=1');
  await watchTheWall(page);
  await page.keyboard.press('k');
  for (let n = 2; n <= 5; n++) {
    await page.keyboard.press('ArrowRight');
    await atPosition(page, n);
    const rest = await exhibitionAtRest(page);
    assert.equal(rest.visibleLayers, 1, `after step ${String(n)}`);
    assert.ok(rest.loaded, `after step ${String(n)}`);
  }
  assert.equal(
    await page.evaluate(
      () => document.querySelector<HTMLElement>('[data-exhibition]')?.dataset['paused'],
    ),
    'true',
  );
  assert.deepEqual((await wallReport(page)).breaches, []);
});

browserTest(
  'autoplay advances on its own, each photograph loaded before it fades in',
  async ({ page }) => {
    await open(page, 'slide=5&fade=1&motion=0');
    await watchTheWall(page);
    await atPosition(page, 2);
    await atPosition(page, 3);
    await exhibitionAtRest(page);
    assert.deepEqual((await wallReport(page)).breaches, []);
  },
);

for (const [label, viewport] of [
  ['small phone', { width: 360, height: 640 }],
  ['phone', { width: 390, height: 844 }],
  ['phone on its side', { width: 844, height: 390 }],
  ['tablet', { width: 820, height: 1180 }],
  ['ultrawide', { width: 2560, height: 1080 }],
] as const) {
  browserTest(
    `${label}: each photograph contained, centred and clear of the controls`,
    async ({ page }) => {
      await open(page, 'slide=30&fade=1&motion=0');
      for (let n = 1; n <= 3; n++) {
        if (n > 1) {
          await page.keyboard.press('ArrowRight');
          await atPosition(page, n);
        }
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        const rest = await exhibitionAtRest(page);
        const where = `${label}, photograph ${String(n)}`;
        assert.equal(rest.visibleLayers, 1, where);
        assert.ok(Math.abs(rest.drawnRatio / rest.photoRatio - 1) < 0.01, `${where}: distorted`);
        assert.equal(rest.insideViewport, true, `${where}: off screen`);
        assert.equal(rest.overlapsControls, false, `${where}: under the controls`);
        assert.equal(rest.controlsFit, true, `${where}: a control runs off the screen`);
        const offCentre = await page.evaluate(() => {
          const layer = Array.from(document.querySelectorAll<HTMLElement>('[data-layer]')).find(
            (l) => Number(getComputedStyle(l).opacity) > 0.5,
          );
          const r = layer?.querySelector('img')?.getBoundingClientRect();
          return r ? Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) : Infinity;
        });
        assert.ok(offCentre < 1, `${where}: ${offCentre.toFixed(1)} px off centre`);
      }
    },
    { viewport },
  );
}

browserTest(
  'a phone gets the same guarantees with touch',
  async ({ page }) => {
    await open(page, 'slide=30&fade=1&motion=0');
    const rest = await exhibitionAtRest(page);
    assert.equal(rest.visibleLayers, 1);
    assert.equal(rest.insideViewport, true);
  },
  PHONE,
);

browserTest(
  'reduced motion: no drift, and the settings say why',
  async ({ page }) => {
    await open(page, 'slide=30');
    const state = await page.evaluate(() => ({
      drift: Array.from(document.querySelectorAll('[data-motion]')).flatMap((m) =>
        m.getAnimations(),
      ).length,
      note: document.querySelector<HTMLElement>('[data-reduced-note]')?.hidden === false,
    }));
    assert.equal(state.drift, 0);
    assert.equal(state.note, true);
  },
  { reducedMotion: 'reduce' },
);

browserTest(
  'resizing in the middle of a transition settles on a contained photograph',
  async ({ page }) => {
    await open(page, 'slide=30&fade=2&motion=0');
    await watchTheWall(page);
    await page.keyboard.press('ArrowRight');
    await page.setViewportSize({ width: 800, height: 1000 });
    await atPosition(page, 2);
    const rest = await exhibitionAtRest(page);
    assert.equal(rest.visibleLayers, 1);
    assert.equal(rest.insideViewport, true);
    assert.ok(Math.abs(rest.drawnRatio / rest.photoRatio - 1) < 0.01);
    assert.deepEqual((await wallReport(page)).breaches, []);
  },
);

browserTest(
  'a photograph that will not load is skipped, never shown half-loaded',
  async ({ page }) => {
    const tag = await mixedTag();
    const inTag = (await publicPhotos()).filter((photo) => photo.tags.includes(tag));
    const broken = inTag[1];
    assert.ok(broken !== undefined && inTag.length >= 3);
    await page.route(`**/p/${broken.id}/**`, (route) => route.abort());
    await open(page, 'slide=30&fade=1&motion=0');
    await watchTheWall(page);
    await page.keyboard.press('ArrowRight');
    await atPosition(page, 3);
    const rest = await exhibitionAtRest(page);
    assert.equal(rest.visibleLayers, 1);
    assert.ok(rest.loaded);
    assert.deepEqual((await wallReport(page)).breaches, []);
  },
  { allowErrors: ['Failed to load resource'] },
);
