/**
 * Every photograph grid opens in a fresh random order on each visit — a
 * tag, a film stock, the archive, Saved, a shared selection — so the
 * whole body of work gets seen, not just whatever sorts first. The server
 * still renders archival order (roll, frame), which is what a no-JS
 * visitor gets. Only DOM order changes; masonry.ts re-places the grid
 * when it sees the move, and the lightbox is told the new order so
 * prev/next steps through exactly what the grid shows.
 *
 * Selected Work does this in selected-view.ts instead, where Shuffle and
 * the filters need the same function.
 */

import { setLightboxOrder } from './lightbox.ts';

export function shuffled<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** Deals `grid`'s photo tiles into a random order and hands that order to the lightbox. */
export function shuffleGrid(grid: HTMLElement): void {
  const order = shuffled(
    Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]')),
  );
  for (const tile of order) grid.appendChild(tile);
  setLightboxOrder(order.map((tile) => tile.dataset['photoId'] ?? ''));
}
