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

browserTest(
  'every card carries its catalogue number, and the year’s numbers run from its count down to 1',
  async ({ page }) => {
    await page.goto(`${BASE}/pictures/`);
    const years = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('.film-year-group'), (group) =>
        Array.from(group.querySelectorAll('.film-catalogue'), (line) =>
          Number(/№\s*(\d+)/.exec(line.textContent ?? '')?.[1]),
        ),
      ),
    );
    assert.ok(years.length > 0);
    for (const numbers of years) {
      assert.deepEqual(
        numbers,
        numbers.map((_, i) => numbers.length - i),
      );
    }
  },
);

browserTest(
  'on a wide screen the year stands in the margin beside its films',
  async ({ page }) => {
    await page.goto(`${BASE}/pictures/`);
    const g = await page.evaluate(() => {
      const group = document.querySelector('.film-year-group');
      const heading = group?.querySelector('.film-year-heading')?.getBoundingClientRect();
      const grid = group?.querySelector('.film-grid')?.getBoundingClientRect();
      return heading && grid
        ? {
            headingRight: heading.right,
            gridLeft: grid.left,
            sameRow: Math.abs(heading.top - grid.top) < 2,
          }
        : null;
    });
    assert.ok(g, 'no year group');
    assert.ok(g.headingRight <= g.gridLeft, 'year overlaps the posters');
    assert.ok(g.sameRow, 'year is not beside its films');
  },
  { viewport: { width: 1440, height: 900 } },
);
