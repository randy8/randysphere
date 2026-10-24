/**
 * A save mark on every grid photograph — the way into Saved without first
 * opening the lightbox. Quiet by design: on a pointer device it appears
 * only on hover or keyboard focus; on a touch screen only already-saved
 * photographs show one (a ✓), so a page of photographs never reads as a
 * page of buttons. Added here, client-side, because saving needs
 * JavaScript anyway (localStorage) — a no-JS visitor never sees a control
 * that can't work. saved.ts's syncSavedUI keeps these in step with the
 * lightbox's own Save button.
 */

import { syncSavedUI, toggleSaved } from './saved.ts';

const grid = document.querySelector<HTMLElement>('.grid[data-grid]');
if (grid !== null) {
  for (const tile of grid.querySelectorAll<HTMLElement>(':scope > [data-photo-id]')) {
    const id = tile.dataset['photoId'] ?? '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tile-save';
    button.dataset['tileSave'] = id;
    tile.appendChild(button);
  }
  syncSavedUI();
  grid.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLElement>('[data-tile-save]');
    if (button === null || button === undefined) return;
    event.preventDefault();
    toggleSaved(button.dataset['tileSave'] ?? '');
  });
}
