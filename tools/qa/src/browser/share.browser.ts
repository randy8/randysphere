/**
 * Share links are permanent and carry their own data (no server state), so
 * old formats and vanished photographs are the cases that matter.
 */

import assert from 'node:assert/strict';
import { BASE, browserTest, publicPhotos } from './harness.ts';

/** A `?s=` link (the original format): each full 8-byte id, base64url. */
function legacyCode(ids: readonly string[]): string {
  return Buffer.concat(ids.map((id) => Buffer.from(id, 'hex'))).toString('base64url');
}

browserTest(
  'an original ?s= link still works, and a photograph no longer in the archive is counted',
  async ({ page }) => {
    const [a, b] = await publicPhotos();
    assert.ok(a && b);
    await page.goto(`${BASE}/exposures/share/?s=${legacyCode([a.id, 'ffffffffffffffff', b.id])}`);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-share-grid] > [data-photo-id]:not([hidden])').length === 2,
    );
    const shown = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-share-grid] > [data-photo-id]:not([hidden])'),
        (el) => el.dataset['photoId'],
      ).sort(),
    );
    assert.deepEqual(shown, [a.id, b.id].sort());
    assert.match(
      (await page.locator('[data-share-missing]').textContent()) ?? '',
      /1 photograph in this link is no longer in the archive/,
    );
  },
);

browserTest('opening someone’s share link never changes your own Saved', async ({ page }) => {
  const [a, b] = await publicPhotos();
  assert.ok(a && b);
  await page.goto(`${BASE}/exposures/saved/`);
  await page.evaluate(
    (id) => localStorage.setItem('photography:saved', JSON.stringify([id])),
    a.id,
  );
  await page.goto(`${BASE}/exposures/share/?s=${legacyCode([b.id])}`);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-share-grid] > [data-photo-id]:not([hidden])').length === 1,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('photography:saved')),
    JSON.stringify([a.id]),
  );
});
