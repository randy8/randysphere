/**
 * Pictures, the film log: the controls never lie over a poster (a floating
 * panel did until 2026-10-26), posters keep their proportions, each card
 * carries its catalogue line, and the year stands beside its films.
 */

import assert from 'node:assert/strict';
import { BASE, browserTest, PHONE } from './harness.ts';

const posterGeometry = () => {
  const controls = document.querySelector('.film-controls')?.getBoundingClientRect();
  const frames = Array.from(document.querySelectorAll<HTMLElement>('.film-poster-frame'))
    .map((f) => f.getBoundingClientRect())
    .filter((r) => r.bottom > 0 && r.top < window.innerHeight);
  const covered = controls
    ? frames.filter((r) => r.top < controls.bottom - 1 && r.bottom > controls.top + 1).length
    : 0;
  const distorted = frames.filter((r) => Math.abs(r.width / r.height - 2 / 3) > 0.01).length;
  return {
    visible: frames.length,
    covered,
    distorted,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
};

for (const [label, options] of [
  ['desktop', {}],
  ['phone', PHONE],
] as const) {
  browserTest(
    `${label}: scrolled anywhere, the controls never cover a poster`,
    async ({ page }) => {
      await page.goto(`${BASE}/pictures/`);
      for (const y of [0, 1200, 4000, 9000]) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForFunction(() => document.fonts.status === 'loaded');
        const g = await page.evaluate(posterGeometry);
        assert.ok(g.visible > 0, `nothing on screen at ${String(y)}`);
        assert.equal(g.covered, 0, `controls over ${String(g.covered)} poster(s) at ${String(y)}`);
        assert.equal(g.distorted, 0, `distorted posters at ${String(y)}`);
        assert.equal(g.overflowX, false, 'page scrolls sideways');
      }
    },
    options,
  );
}

browserTest('each film’s date line is the day it was seen, and nothing else', async ({ page }) => {
  await page.goto(`${BASE}/pictures/`);
  const lines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.film-catalogue'), (line) =>
      (line.textContent ?? '').trim(),
    ),
  );
  assert.ok(lines.length > 0, 'no date lines');
  for (const line of lines) assert.match(line, /^\d{1,2} [A-Za-z]+$/, `"${line}"`);
});

browserTest(
  'one way between years: no year dropdown, small year headings above their films, posters near the top',
  async ({ page }) => {
    await page.goto(`${BASE}/pictures/`);
    const g = await page.evaluate(() => {
      const heading = document.querySelector('.film-year-heading h2');
      const group = document.querySelector('.film-year-group');
      const headingBox = group?.querySelector('.film-year-heading')?.getBoundingClientRect();
      const gridBox = group?.querySelector('.film-grid')?.getBoundingClientRect();
      return {
        dropdown: document.querySelector('[data-film-year-select]') !== null,
        headingPx: heading ? parseFloat(getComputedStyle(heading).fontSize) : 0,
        above: headingBox && gridBox ? headingBox.bottom <= gridBox.top : false,
        firstPosterTop:
          document.querySelector('.film-poster-frame')?.getBoundingClientRect().top ?? 9999,
      };
    });
    assert.equal(g.dropdown, false, 'the year dropdown is back');
    assert.ok(g.headingPx > 0 && g.headingPx <= 24, `year heading is ${String(g.headingPx)}px`);
    assert.ok(g.above, 'the year heading is not above its films');
    assert.ok(
      g.firstPosterTop < 420,
      `first posters start ${String(Math.round(g.firstPosterTop))}px down`,
    );
  },
  { viewport: { width: 1440, height: 900 } },
);

browserTest('the year index marks the year in view as you scroll', async ({ page }) => {
  await page.goto(`${BASE}/pictures/`);
  const years = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-film-year-link]'),
      (a) => a.dataset['filmYearLink'] ?? '',
    ),
  );
  assert.ok(years.length >= 2);
  assert.equal(
    await page.locator(`[data-film-year-link="${years[0] ?? ''}"]`).getAttribute('aria-current'),
    'true',
    'the first year is not marked at load',
  );
  const second = years[1] ?? '';
  await page.evaluate((y) => document.getElementById(`year-${y}`)?.scrollIntoView(), second);
  await page.waitForFunction(
    (y) =>
      document.querySelector(`[data-film-year-link="${y}"]`)?.getAttribute('aria-current') ===
      'true',
    second,
  );
  assert.equal(await page.locator('[data-film-year-link][aria-current]').count(), 1);
});

for (const [label, options] of [
  ['desktop', { viewport: { width: 1440, height: 900 } }],
  ['phone', PHONE],
] as const) {
  browserTest(
    `${label}: Pick for me opens over wherever you are, and every way out returns you exactly there`,
    async ({ page }) => {
      await page.goto(`${BASE}/pictures/`);
      await page.locator('[data-film-pick]').waitFor({ state: 'visible' });
      const titleShown = () => page.locator('[data-film-pick-dialog] .film-title').innerText();
      for (const close of ['escape', 'outside', 'button'] as const) {
        await page.evaluate(() => window.scrollTo(0, 3000));
        const before = await page.evaluate(() => ({
          y: window.scrollY,
          // Something on screen, to prove the page behind holds still.
          top:
            document
              .elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
              ?.closest('.film-card')
              ?.getBoundingClientRect().top ?? null,
        }));
        await page.evaluate(() =>
          document.querySelector<HTMLButtonElement>('[data-film-pick] button')?.click(),
        );
        const dialog = page.locator('[data-film-pick-dialog]');
        await dialog.waitFor({ state: 'visible' });
        const during = await page.evaluate(() => {
          const box = document.querySelector('[data-film-pick-dialog]')!.getBoundingClientRect();
          return {
            inView: box.top >= 0 && box.bottom <= window.innerHeight + 1,
            title: document.getElementById('film-pick-title')?.textContent ?? '',
          };
        });
        assert.ok(during.inView, `${close}: the dialog isn't in the viewport`);
        assert.ok(during.title.trim().length > 0, 'no film shown');
        assert.match(
          (await page.locator('[data-film-pick-status]').textContent()) ?? '',
          /^Picked .+ \(\d{4}\)\.$/,
        );
        if (close === 'escape') {
          const first = await titleShown();
          await page.locator('[data-film-pick-again]').click();
          assert.notEqual(await titleShown(), first, 'Another drew the same film');
          await page.keyboard.press('Escape');
        } else if (close === 'outside') {
          await page.mouse.click(4, 4);
        } else {
          await page.locator('[data-film-pick-close]').click();
        }
        await dialog.waitFor({ state: 'hidden' });
        const after = await page.evaluate(() => window.scrollY);
        assert.equal(
          after,
          before.y,
          `${close}: the page moved (${String(before.y)} → ${String(after)})`,
        );
        if (before.top !== null) {
          const top = await page.evaluate(
            () =>
              document
                .elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
                ?.closest('.film-card')
                ?.getBoundingClientRect().top ?? null,
          );
          assert.equal(top, before.top, `${close}: what was on screen moved`);
        }
      }
    },
    options,
  );
}
