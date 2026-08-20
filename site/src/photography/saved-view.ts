/**
 * Page-specific glue for /photography/saved/ alone — never imported
 * anywhere else. The page server-renders the entire archive twice (a grid
 * of thumbnails, a full Browse stack) because it has no way to know what's
 * saved at build time; this module is what actually prunes both down to
 * the saved subset, before browse.ts ever reads the stack (see the ordering
 * note in saved/index.astro).
 */

import { openPhoto } from './browse.ts';
import { encodeIds } from './share-code.ts';
import { clearSaved, pruneStale, removeSaved, savedIds } from './saved.ts';

const SHARE_LABEL_RESET_MS = 2000;

const grid = document.querySelector<HTMLElement>('[data-saved-grid]');
const stack = document.querySelector<HTMLElement>('[data-browse-stack]');
const emptyMessage = document.querySelector<HTMLElement>('[data-saved-empty]');
const summary = document.querySelector<HTMLElement>('[data-saved-summary]');
const actions = document.querySelector<HTMLElement>('[data-saved-actions]');
const clearButton = document.querySelector<HTMLElement>('[data-clear-saved]');
const shareButton = document.querySelector<HTMLElement>('[data-share-saved]');

if (grid !== null) {
  const validIds = new Set(
    Array.from(grid.querySelectorAll<HTMLElement>('[data-photo-id]'), (el) => el.dataset['photoId'] ?? ''),
  );
  pruneStale(validIds);

  const saved = new Set(savedIds());
  let remaining = saved.size;

  // Called once up front and again after every individual removal — the
  // grid can go from "has photos" to "empty" without a reload (Clear still
  // reloads; a single × doesn't need to).
  const refreshSummary = (): void => {
    if (remaining === 0) {
      if (summary !== null) summary.hidden = true;
      actions?.setAttribute('hidden', '');
      emptyMessage?.removeAttribute('hidden');
      return;
    }
    if (summary !== null) {
      summary.textContent = `${String(remaining)} photograph${remaining === 1 ? '' : 's'}`;
      summary.hidden = false;
    }
    actions?.removeAttribute('hidden');
  };

  if (saved.size > 0) {
    emptyMessage?.setAttribute('hidden', '');

    grid.querySelectorAll<HTMLElement>('[data-photo-id]').forEach((tile) => {
      if (!saved.has(tile.dataset['photoId'] ?? '')) tile.remove();
    });
    stack?.querySelectorAll<HTMLElement>('[data-photo-id]').forEach((item) => {
      if (!saved.has(item.dataset['photoId'] ?? '')) item.remove();
    });

    refreshSummary();

    grid.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;

      const removeButton = event.target.closest<HTMLElement>('[data-remove-saved]');
      if (removeButton !== null) {
        const tile = removeButton.closest<HTMLElement>('[data-photo-id]');
        const id = tile?.dataset['photoId'];
        if (id === undefined) return;
        // Only the grid tile — the corresponding photo inside the (already
        // built, by the time any click can happen) Browse stack is left in
        // place rather than spliced out of browse.ts's own index bookkeeping.
        // It simply won't reappear next time this page loads; see the same
        // trade-off documented for unsaving from inside the open viewer.
        removeSaved(id);
        tile?.remove();
        remaining -= 1;
        refreshSummary();
        return;
      }

      const link = event.target.closest('a');
      const tile = event.target.closest<HTMLElement>('[data-photo-id]');
      const id = tile?.dataset['photoId'];
      if (link === null || id === undefined) return;
      event.preventDefault();
      openPhoto(id);
    });
  }
}

const exitToGrid = (): void => {
  document.body.classList.remove('is-browsing');
  history.replaceState(null, '', '/photography/saved/');
};

document.querySelector('[data-exit-grid]')?.addEventListener('click', exitToGrid);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('is-browsing')) exitToGrid();
});

clearButton?.addEventListener('click', () => {
  clearSaved();
  location.reload();
});

// Whole-list only, in current-order — no subset selection yet (that needs
// multi-select, a separate pass). The same quiet text-swap the Save button
// itself already uses for feedback, not a toast.
shareButton?.addEventListener('click', () => {
  if (shareButton === null) return;
  // A query param, not a hash — browse.ts's own #photo-<id> already owns
  // the hash on every Browse page, /share/ included (see share-view.ts);
  // a query string survives history.replaceState(null, '', '#photo-xyz')
  // untouched (that call only ever replaces the fragment), so the two
  // never collide.
  const url = `${location.origin}/photography/share/?s=${encodeIds(savedIds())}`;
  navigator.clipboard.writeText(url).then(
    () => {
      const original = shareButton.textContent;
      shareButton.textContent = 'Copied';
      setTimeout(() => {
        shareButton.textContent = original;
      }, SHARE_LABEL_RESET_MS);
    },
    () => {
      // Clipboard access denied/unavailable — nothing to silently fail
      // into, so just leave the button's label alone.
    },
  );
});
