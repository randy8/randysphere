/**
 * What "looks right" means, measured in the page: proportions, overlap,
 * clipping, what's on the wall. Geometry rather than pixel diffs, so a
 * shuffled grid or a new photograph never trips a test, but a distorted,
 * overlapping or stale one always does.
 */

import type { Page } from 'playwright-core';

/** Waits until every photograph the grid chose for the first screen has loaded. */
export async function waitForFirstScreen(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const eager = Array.from(
        document.querySelectorAll<HTMLImageElement>('[data-grid] img'),
      ).filter((img) => img.loading === 'eager');
      return eager.length > 0 && eager.every((img) => img.complete && img.naturalWidth > 0);
    },
    null,
    { timeout: 45_000 },
  );
}

export interface GridGeometry {
  readonly tiles: number;
  readonly columns: number;
  readonly firstScreen: number;
  /** Photographs drawn more than 1% off their own aspect ratio. */
  readonly distorted: readonly string[];
  /** Pairs of photographs whose boxes overlap. */
  readonly overlapping: readonly string[];
  /** Photographs reaching outside the grid's own width. */
  readonly outside: readonly string[];
  readonly pageOverflowsX: boolean;
}

export function gridGeometry(page: Page): Promise<GridGeometry> {
  return page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-grid]');
    if (grid === null) throw new Error('no [data-grid] on the page');
    const box = grid.getBoundingClientRect();
    const tiles = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]')).filter(
      (t) => !t.hidden,
    );
    const rects = tiles.map((tile) => ({
      id: tile.dataset['photoId'] ?? '?',
      r: tile.getBoundingClientRect(),
    }));
    const distorted: string[] = [];
    for (const tile of tiles) {
      const img = tile.querySelector('img');
      if (img === null) continue;
      const want = Number(img.getAttribute('width')) / Number(img.getAttribute('height'));
      const drawn = img.getBoundingClientRect();
      if (drawn.height > 0 && Math.abs(drawn.width / drawn.height / want - 1) > 0.01) {
        distorted.push(
          `${tile.dataset['photoId'] ?? '?'} ${(drawn.width / drawn.height).toFixed(3)} vs ${want.toFixed(3)}`,
        );
      }
    }
    const overlapping: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!.r;
        const b = rects[j]!.r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) overlapping.push(`${rects[i]!.id} × ${rects[j]!.id}`);
      }
    }
    const outside = rects
      .filter(({ r }) => r.left < box.left - 1 || r.right > box.right + 1)
      .map(({ id }) => id);
    return {
      tiles: tiles.length,
      columns: new Set(rects.map(({ r }) => Math.round(r.left))).size,
      firstScreen: tiles.filter((t) => t.querySelector('img')?.loading === 'eager').length,
      distorted,
      overlapping,
      outside,
      pageOverflowsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

export interface ExhibitionState {
  readonly visibleLayers: number;
  readonly loaded: boolean;
  readonly photoRatio: number;
  readonly drawnRatio: number;
  readonly overlapsControls: boolean;
  readonly insideViewport: boolean;
  /** Every control button wholly on screen and on one line. */
  readonly controlsFit: boolean;
}

/** Waits for every fade to finish, then reports what's on the wall. */
export async function exhibitionAtRest(page: Page): Promise<ExhibitionState> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== 'running' ||
          !((a.effect as KeyframeEffect | null)?.target as Element | null)?.matches('[data-layer]'),
      ),
  );
  return page.evaluate(() => {
    const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-layer]'));
    const visible = layers.filter((layer) => Number(getComputedStyle(layer).opacity) > 0.01);
    const img = visible[0]?.querySelector('img');
    const drawn = img?.getBoundingClientRect();
    const bars = Array.from(document.querySelectorAll<HTMLElement>('.exhibition-bar'))
      .filter((bar) => Number(getComputedStyle(bar).opacity) > 0.01 && !bar.hidden)
      .map((bar) => bar.getBoundingClientRect());
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('.exhibition-bar .exhibition-button'),
    ).filter((button) => !button.hidden);
    const controlsFit = buttons.every((button) => {
      const r = button.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(button).lineHeight) || 24;
      return (
        r.left >= -0.5 &&
        r.right <= window.innerWidth + 0.5 &&
        button.scrollHeight <= Math.max(r.height, line * 1.6)
      );
    });
    const overlaps =
      drawn !== undefined &&
      bars.some((b) => drawn.top < b.bottom - 0.5 && drawn.bottom > b.top + 0.5);
    return {
      visibleLayers: visible.length,
      loaded: img?.complete === true && (img.naturalWidth ?? 0) > 0,
      photoRatio: img ? img.width / img.height : NaN,
      drawnRatio: drawn ? drawn.width / drawn.height : NaN,
      overlapsControls: overlaps,
      controlsFit,
      insideViewport:
        drawn !== undefined &&
        drawn.left >= -0.5 &&
        drawn.top >= -0.5 &&
        drawn.right <= window.innerWidth + 0.5 &&
        drawn.bottom <= window.innerHeight + 0.5,
    };
  });
}

/**
 * Watches Exhibition on every animation frame from now on and records any
 * moment the wall breaks its one rule: two photographs visible at once
 * whose frames differ (that's the landscape showing either side of a
 * portrait), or a visible photograph that hasn't loaded.
 */
export async function watchTheWall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __wall: { frames: number; breaches: string[] } };
    w.__wall = { frames: 0, breaches: [] };
    const tick = (): void => {
      w.__wall.frames++;
      const visible = Array.from(document.querySelectorAll<HTMLElement>('[data-layer]'))
        .map((layer) => ({
          o: Number(getComputedStyle(layer).opacity),
          img: layer.querySelector('img'),
        }))
        .filter((layer) => layer.o > 0.04 && layer.img !== null);
      if (visible.length === 2) {
        const [a, b] = visible.map((layer) => layer.img!.width / layer.img!.height) as [
          number,
          number,
        ];
        if (Math.abs(a / b - 1) > 0.02)
          w.__wall.breaches.push(
            `two frames on the wall (${visible.map((v) => v.o.toFixed(2)).join(' / ')})`,
          );
      }
      for (const layer of visible) {
        if (!layer.img!.complete) w.__wall.breaches.push('an unloaded photograph is visible');
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function wallReport(page: Page): Promise<{ frames: number; breaches: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __wall: { frames: number; breaches: string[] } };
    return { frames: w.__wall.frames, breaches: [...new Set(w.__wall.breaches)] };
  });
}
