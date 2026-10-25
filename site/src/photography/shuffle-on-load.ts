/**
 * Imported by every photo page except Selected Work. The grid was already
 * dealt into a random order before the first paint (GridDeal.astro); this
 * hands that order to the lightbox, so prev/next follows what's on screen.
 */

import { setLightboxOrder } from './lightbox.ts';

const grid = document.querySelector<HTMLElement>('[data-grid]');
if (grid !== null) {
  setLightboxOrder(
    Array.from(
      grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]'),
      (tile) => tile.dataset['photoId'] ?? '',
    ),
  );
}
