/**
 * Page-specific glue for /exposures/share/ alone — never imported
 * anywhere else. Mirrors saved-view.ts's shape closely, but the subset it
 * prunes down to comes from the URL's own ?s= query param (share-code.ts),
 * not localStorage, and it's shown in exactly the order the sender shared
 * it in, not archive order — so this reorders the DOM, not just filters it.
 */

import { openPhoto, setLightboxOrder } from './lightbox.ts';
import { resolveIds, sharedPrefixes } from './share-code.ts';

const grid = document.querySelector<HTMLElement>('[data-share-grid]');
const emptyMessage = document.querySelector<HTMLElement>('[data-share-empty]');
const summary = document.querySelector<HTMLElement>('[data-share-summary]');
const missingNote = document.querySelector<HTMLElement>('[data-share-missing]');
const more = document.querySelector<HTMLElement>('[data-share-more]');

if (grid !== null) {
  const validIds = new Set(
    Array.from(
      grid.querySelectorAll<HTMLElement>('[data-photo-id]'),
      (el) => el.dataset['photoId'] ?? '',
    ),
  );

  // Gracefully ignore ids for photographs that no longer exist — a link
  // shared before an archive change simply shows whatever's left.
  const named = sharedPrefixes(new URLSearchParams(location.search));
  const ids = resolveIds(named, validIds);
  const missing = named.length - ids.length;

  if (ids.length > 0) {
    emptyMessage?.remove();

    const gridTiles = new Map(
      Array.from(grid.querySelectorAll<HTMLElement>('[data-photo-id]'), (el) => [
        el.dataset['photoId'],
        el,
      ]),
    );
    const keep = new Set(ids);
    gridTiles.forEach((tile, id) => {
      if (id === undefined || !keep.has(id)) tile.remove();
    });

    if (summary !== null) {
      summary.textContent = `${String(ids.length)} photograph${ids.length === 1 ? '' : 's'}`;
      summary.hidden = false;
    }
    if (missingNote !== null && missing > 0) {
      missingNote.textContent = `${String(missing)} photograph${missing === 1 ? ' in this link is' : 's in this link are'} no longer in the archive.`;
      missingNote.hidden = false;
    }
    if (more !== null) more.hidden = false;

    grid.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a');
      const tile = event.target.closest<HTMLElement>('[data-photo-id]');
      const id = tile?.dataset['photoId'];
      if (link === null || id === undefined) return;
      event.preventDefault();
      openPhoto(id);
    });
  } else {
    // Nothing in the link resolves (empty, mangled, or every photograph
    // since removed): show only the message, never the whole archive the
    // page was rendered with.
    grid.replaceChildren();
    setLightboxOrder([]);
  }
}
