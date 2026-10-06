/**
 * Reading (Browse) is still the default view on every tag/Selected Work
 * page — this only makes the grid markup that already renders alongside it
 * (originally the no-JS fallback only, see Browse.astro/browse.ts) into a
 * real secondary option a JS-enabled visitor can actually switch to and
 * back from, via the "Grid" corner mark Browse.astro renders when handed
 * `exitToGrid`. Saved/share pages have their own richer version of this
 * same shape (each prunes its grid/stack down to a subset first) — see
 * saved-view.ts/share-view.ts; this is the plain version for a page that
 * shows the whole view as-is, so it doesn't share code with them beyond
 * the pattern.
 */

import { openPhoto } from './browse.ts';

const grid = document.querySelector<HTMLElement>('[data-grid]');

grid?.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest('a');
  const tile = event.target.closest<HTMLElement>('[data-photo-id]');
  const id = tile?.dataset['photoId'];
  if (link === null || id === undefined) return;
  event.preventDefault();
  openPhoto(id);
});

const exitToGrid = (): void => {
  document.body.classList.remove('is-browsing');
  const url = new URL(location.href);
  url.hash = '';
  url.searchParams.delete('photo');
  history.replaceState(null, '', url);
};

document.querySelector('[data-exit-grid]')?.addEventListener('click', exitToGrid);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('is-browsing')) exitToGrid();
});
