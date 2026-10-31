/**
 * Tunes: browse while it plays. The room folds into a bar along the bottom,
 * a link from there opens the site in a frame above it, the address bar
 * follows the frame, Back walks the frame and then comes home to Tunes —
 * and through all of it the player is the same iframe, never reloaded.
 * YouTube itself is stubbed: what's under test is this page, not its player.
 */

import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { BASE, browserTest, PHONE } from './harness.ts';

async function stubYouTube(page: Page): Promise<void> {
  await page.route('https://www.youtube.com/**', (route) =>
    route.request().url().includes('/oembed')
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      : route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><title>stub</title>',
        }),
  );
}

/** Opens the first song, marks its player so a reload would show, and folds the room. */
async function playAndDock(page: Page): Promise<void> {
  await stubYouTube(page);
  await page.goto(`${BASE}/tunes/`);
  await page.locator('[data-tune-open]').first().click();
  const viewer = page.locator('[data-tune-viewer]');
  await viewer.waitFor({ state: 'visible' });
  // Once the player has loaded, mark it and count any load after: a moved
  // or replaced iframe reloads, and the song with it.
  await page.waitForFunction(() =>
    document.querySelector('[data-tune-screen] iframe')?.classList.contains('is-loaded'),
  );
  await page.evaluate(() => {
    const player = document.querySelector<HTMLIFrameElement>('[data-tune-screen] iframe')!;
    player.dataset['mark'] = '0';
    player.addEventListener('load', () => {
      player.dataset['mark'] = String(Number(player.dataset['mark']) + 1);
    });
  });
  await page.locator('[data-tune-dock]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-tune-viewer]')?.classList.contains('is-docked'),
  );
}

const samePlayer = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLIFrameElement>('[data-tune-screen] iframe')?.dataset['mark'] ===
      '0',
  );

for (const [label, options] of [
  ['desktop', {}],
  ['phone', PHONE],
] as const) {
  browserTest(
    `${label}: the room folds into a bar, and the list behind it is usable`,
    async ({ page }) => {
      await playAndDock(page);
      const state = await page.evaluate(() => {
        const bar = document.querySelector('[data-tune-viewer]')!.getBoundingClientRect();
        return {
          inert: document.querySelector<HTMLElement>('.wrap')!.inert,
          bottom: Math.round(bar.bottom),
          height: bar.height,
          viewport: window.innerHeight,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert.equal(state.inert, false, 'the list stays inert behind the bar');
      assert.equal(state.bottom, state.viewport, 'the bar is not along the bottom');
      assert.ok(state.height < state.viewport / 4, `the bar is ${String(state.height)}px tall`);
      assert.equal(state.overflowX, false, 'the bar makes the page scroll sideways');
      assert.ok(await samePlayer(page), 'folding the room reloaded the player');
    },
    options,
  );
}

browserTest(
  'a link from the bar opens the site in a frame; Back walks it, then comes home',
  async ({ page }) => {
    await playAndDock(page);
    await page.locator('.nameplate-list a[href="/dishes/"]').click();
    const frame = page.locator('iframe.tune-site');
    await frame.waitFor({ state: 'visible' });
    await page.waitForURL(`${BASE}/dishes/`);
    await page.waitForFunction(() => document.title.startsWith('Dishes'));
    assert.equal(await page.locator('.wrap').isVisible(), false, 'the Tunes list still shows');

    // Inside the frame: on to a recipe, and the address bar follows.
    const inside = page.frameLocator('iframe.tune-site');
    const recipe = inside.locator('a[href^="/dishes/"][href$="/"]:not([href="/dishes/"])').first();
    const href = await recipe.getAttribute('href');
    await recipe.click();
    await page.waitForURL(`${BASE}${href ?? ''}`);
    assert.ok(await samePlayer(page), 'browsing reloaded the player');

    await page.goBack();
    await page.waitForURL(`${BASE}/dishes/`);
    assert.ok(await frame.isVisible(), 'Back left the frame');
    await page.goBack();
    await page.waitForURL(`${BASE}/tunes/`);
    await frame.waitFor({ state: 'hidden' });
    assert.ok(await page.locator('.wrap').isVisible(), 'Back did not bring the Tunes list back');
    assert.ok(await samePlayer(page), 'coming home reloaded the player');

    // Forward shows the frame again, where it was.
    await page.goForward();
    await frame.waitFor({ state: 'visible' });
    await page.waitForURL(`${BASE}/dishes/`);
  },
);

browserTest(
  'the bar opens back into the room, and stop ends the music over the site',
  async ({ page }) => {
    await playAndDock(page);
    await page.locator('[data-tune-expand]').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-tune-viewer]')?.classList.contains('is-docked'),
    );
    assert.ok(await samePlayer(page), 'opening the room reloaded the player');
    await page.locator('[data-tune-dock]').click();
    await page.locator('.nameplate-list a[href="/pictures/"]').click();
    await page.waitForURL(`${BASE}/pictures/`);
    await page.locator('[data-tune-stop]').click();
    await page.locator('[data-tune-viewer]').waitFor({ state: 'hidden' });
    assert.equal(
      await page.locator('[data-tune-screen] iframe').count(),
      0,
      'the player outlived stop',
    );
    assert.ok(
      await page.locator('iframe.tune-site').isVisible(),
      'stopping took the page away too',
    );
  },
);
