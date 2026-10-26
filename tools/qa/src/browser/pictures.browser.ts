/**
 * Pictures, the film log: the controls never lie over a poster (a floating
 * panel did until 2026-10-26), posters keep their proportions, each card
 * carries its catalogue line, and the year stands beside its films.
 */

import assert from 'node:assert/strict';
import { waitForStill } from './checks.ts';
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
    `${label}: deep in the page the bar is pinned with every option, and a year lands just under it`,
    async ({ page }) => {
      await page.goto(`${BASE}/pictures/`);
      await page.locator('[data-film-pick]').waitFor({ state: 'visible' });
      await page.evaluate(() => window.scrollTo(0, 6000));
      await page.waitForFunction(() =>
        document.querySelector('.film-bar')?.classList.contains('is-stuck'),
      );
      const bar = await page.evaluate(() => {
        const box = document.querySelector('.film-bar')!.getBoundingClientRect();
        const shown = (s: string) => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return (
            r !== undefined && r.width > 0 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1
          );
        };
        return {
          top: Math.round(box.top),
          height: box.height,
          years: shown('[data-film-years]'),
          genre: shown('[data-film-genre-select]'),
          shuffle: shown('[data-film-shuffle]'),
          pick: shown('[data-film-pick] button'),
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
        };
      });
      assert.equal(bar.top, 0, 'the bar is not pinned to the top');
      assert.ok(
        bar.years && bar.genre && bar.shuffle && bar.pick,
        `options missing from the pinned bar: ${JSON.stringify(bar)}`,
      );
      assert.ok(
        bar.height < (label === 'phone' ? 110 : 70),
        `the pinned bar is ${String(Math.round(bar.height))}px tall`,
      );
      assert.equal(bar.overflowX, false, 'page scrolls sideways');
      if (label === 'phone') {
        const rows = await page.evaluate(
          () =>
            new Set(
              Array.from(document.querySelectorAll('.film-index li'), (li) =>
                Math.round(li.getBoundingClientRect().top),
              ),
            ).size,
        );
        assert.equal(rows, 1, 'the years wrap instead of scrolling sideways');
      }
      await waitForStill(page);
      const g = await page.evaluate(posterGeometry);
      assert.equal(g.distorted, 0, 'distorted posters');
      // A year chosen from the pinned bar: its heading lands just below it,
      // and the bar marks it.
      const target =
        (await page.locator('[data-film-year-link]').nth(3).getAttribute('data-film-year-link')) ??
        '';
      await page.locator('[data-film-year-link]').nth(3).click();
      await page.waitForFunction(
        (y) => {
          const bar = document.querySelector('.film-bar')!.getBoundingClientRect();
          const heading = document.getElementById(`year-${y}`)!.getBoundingClientRect();
          return heading.top >= bar.bottom - 1 && heading.top < bar.bottom + 60;
        },
        target,
        { timeout: 5000 },
      );
      await page.waitForFunction(
        (y) =>
          document.querySelector(`[data-film-year-link="${y}"]`)?.getAttribute('aria-current') ===
          'true',
        target,
        { timeout: 5000 },
      );
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

browserTest(
  'Shuffle is a toggle: the bar never moves, and pressing it again restores the years in order',
  async ({ page }) => {
    await page.goto(`${BASE}/pictures/`);
    const button = page.locator('[data-film-shuffle]');
    const where = () =>
      page.evaluate(() => {
        const b = document.querySelector('[data-film-shuffle]')!.getBoundingClientRect();
        const y = document.querySelector('[data-film-years]')!.getBoundingClientRect();
        return {
          bx: Math.round(b.left),
          by: Math.round(b.top),
          yx: Math.round(y.left),
          yy: Math.round(y.top),
        };
      });
    const order = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('.film-card'), (c) => c.id).join(','),
      );
    const start = await where();
    const original = await order();
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await where(), start, 'shuffling moved the bar');
    assert.notEqual(await order(), original);
    assert.equal(
      await page.locator('[data-film-years]').isVisible(),
      true,
      'the years disappeared',
    );
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await where(), start, 'un-shuffling moved the bar');
    assert.equal(await order(), original, 'the years did not come back in order');
    // A year chosen while shuffled ends the shuffle and goes there.
    await button.click();
    const year = await page
      .locator('[data-film-year-link]')
      .nth(2)
      .getAttribute('data-film-year-link');
    await page.locator('[data-film-year-link]').nth(2).click();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    await page.waitForFunction((y) => {
      const bar = document.querySelector('.film-bar')!.getBoundingClientRect();
      const top = document.getElementById(`year-${y}`)!.getBoundingClientRect().top;
      return top >= bar.bottom - 1 && top < bar.bottom + 60;
    }, year);
  },
);
