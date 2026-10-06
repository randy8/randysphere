/**
 * A standard lightbox: the grid is always the page; this opens one photo
 * at a time over it on click, and closes back to the exact same grid —
 * no separate "mode," no toggle button. Replaces the old Browse mode
 * (browse.ts) and absorbs grid-toggle.ts's one job (a [data-grid] tile
 * click opens the lightbox instead of following the link to the raw
 * image). Saved and Share have their own richer pruning on top of this —
 * see saved-view.ts/share-view.ts — but open the same lightbox the same
 * way, via openPhoto() below.
 *
 * `#photo-<sourceId>` in the URL opens straight to that photograph on
 * load; closing clears it. Every navigation replaces the URL rather than
 * pushing it, so moving between photos never fills up browser history.
 */

import { hasSeenHint, isSaved, markHintSeen, savedCount, toggleSaved } from './saved.ts';

const PHOTO_HASH_PREFIX = '#photo-';

function photoIdFromHash(hash: string): string | null {
  return hash.startsWith(PHOTO_HASH_PREFIX) ? hash.slice(PHOTO_HASH_PREFIX.length) : null;
}

// Set once per page by init(), below — an escape hatch for a page that
// needs to open a specific photo from outside this module entirely (Saved
// and Share's own contact-sheet grids, after they've pruned down to their
// subset — every other page only ever opens through a [data-grid] click or
// a #photo-<id> hash, both handled internally).
let openHandler: ((id: string) => boolean) | null = null;

/** Opens a specific photo in the current page's lightbox, if one exists. Returns whether it did. */
export function openPhoto(id: string): boolean {
  return openHandler !== null && openHandler(id);
}

function applySaveButtonState(button: HTMLElement, saved: boolean): void {
  button.setAttribute('aria-pressed', String(saved));
  const icon = button.querySelector('[data-save-icon]');
  const label = button.querySelector('[data-save-label]');
  if (icon !== null) icon.textContent = saved ? '✓' : '+';
  if (label !== null) label.textContent = saved ? 'Saved' : 'Save';
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-lightbox]');
  if (root === null) return;

  const stage = root.querySelector<HTMLElement>('[data-lightbox-stage]');
  if (stage === null) return;

  const items = Array.from(stage.querySelectorAll<HTMLElement>('[data-photo-id]'));
  const ids = items.map((item) => item.dataset['photoId'] ?? '');
  const position = root.querySelector<HTMLElement>('[data-lightbox-position]');

  // Every save button starts server-rendered as unsaved (the server has no
  // way to know what's in this visitor's localStorage) — reconcile once,
  // on load, against whatever's actually saved.
  items.forEach((item, i) => {
    const button = item.querySelector<HTMLElement>('[data-save]');
    if (button !== null) applySaveButtonState(button, isSaved(ids[i] ?? ''));
  });

  let currentIndex = -1;
  let hintChecked = false;
  let lastFocused: HTMLElement | null = null;

  // The first-use hint attaches to whichever photo a visitor actually
  // opens first, shown once ever — not a modal or a tour, just one quiet
  // line under that one photo's Save button, gone for good once shown.
  const maybeShowHint = (index: number): void => {
    if (hintChecked) return;
    hintChecked = true;
    if (savedCount() > 0 || hasSeenHint()) return;
    const hint = items[index]?.querySelector<HTMLElement>('[data-save-hint]');
    if (hint === null || hint === undefined) return;
    hint.hidden = false;
    markHintSeen();
  };

  const replaceHash = (id: string): void => {
    const url = new URL(location.href);
    url.searchParams.set('photo', id);
    url.hash = `${PHOTO_HASH_PREFIX}${id}`;
    history.replaceState(null, '', url);
  };

  const clearHash = (): void => {
    const url = new URL(location.href);
    url.searchParams.delete('photo');
    url.hash = '';
    history.replaceState(null, '', url);
  };

  // Eagerly load the active photo plus its immediate neighbours (so a
  // prev/next tap never shows a blank frame while its image fetches) —
  // every other photo stays lazy, loaded only if a visitor actually
  // navigates to it. A hidden (`display: none`) image's `loading="lazy"`
  // never fetches on its own, so this is the only thing that triggers it.
  const setEagerNeighbours = (index: number): void => {
    [index - 1, index, index + 1].forEach((n) => {
      const img = items[(n + items.length) % items.length]?.querySelector('img');
      if (img !== null && img !== undefined) img.loading = 'eager';
    });
  };

  const activate = (index: number): void => {
    items.forEach((item, i) => item.classList.toggle('is-active', i === index));
    setEagerNeighbours(index);
    currentIndex = index;
    if (position !== null)
      position.textContent = `${(index + 1).toString()} / ${items.length.toString()}`;
    maybeShowHint(index);
    replaceHash(ids[index] ?? '');
  };

  const open = (index: number): void => {
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.classList.add('lightbox-open');
    root.hidden = false;
    activate(index);
    root.querySelector<HTMLElement>('[data-lightbox-close]')?.focus();
  };

  const close = (): void => {
    document.body.classList.remove('lightbox-open');
    root.hidden = true;
    clearHash();
    lastFocused?.focus();
  };

  // Loops on itself — forward from the last photo lands back on the first,
  // backward from the first lands on the last — same as the old Browse
  // mode, a normal lightbox convention (Google Photos and most others do
  // the same).
  const advance = (forward: boolean): void => {
    const next = (currentIndex + (forward ? 1 : -1) + items.length) % items.length;
    activate(next);
  };

  root.querySelector('[data-lightbox-close]')?.addEventListener('click', close);
  root.querySelectorAll<HTMLElement>('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => advance(button.dataset['nav'] === 'next'));
  });

  // Clicking the scrim itself (not a photo, caption, or control) closes —
  // the standard lightbox dismissal, alongside Escape and the × button.
  root.addEventListener('click', (event) => {
    if (event.target === root || event.target === stage) close();
  });

  stage.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const saveButton = event.target.closest<HTMLElement>('[data-save]');
    if (saveButton === null) return;
    const item = saveButton.closest<HTMLElement>('.lightbox-item');
    const id = item?.dataset['photoId'];
    if (id === undefined) return;
    applySaveButtonState(saveButton, toggleSaved(id));
    // Using the feature once is a stronger signal than merely seeing it —
    // dismiss the hint immediately rather than waiting for the once-ever
    // check above to run again (it may already have, on a different photo).
    const hint = item?.querySelector<HTMLElement>('[data-save-hint]');
    if (hint !== null && hint !== undefined) hint.hidden = true;
    markHintSeen();
  });

  window.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    if (event.key === 'Escape') {
      close();
      return;
    }
    // A modified arrow key is a browser/OS shortcut passing through (Cmd+Left
    // for history back on Mac, most notably) — never ours to intercept.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      advance(true);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      advance(false);
    }
  });

  // The one door in from outside this module — Saved/Share's own
  // contact-sheet grids, after pruning to their subset, have no other way
  // to tell an already-running lightbox "open this specific photo."
  openHandler = (id) => {
    const index = ids.indexOf(id);
    if (index === -1) return false;
    open(index);
    return true;
  };

  // The plain grid's own tiles intercept here directly — Saved/Share render
  // a different grid ([data-saved-grid]/[data-share-grid]) with their own
  // click handling that calls openPhoto() after pruning, so this only ever
  // matches the plain [data-grid] every other page renders.
  document.querySelector('[data-grid]')?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a');
    const tile = event.target.closest<HTMLElement>('[data-photo-id]');
    const id = tile?.dataset['photoId'];
    if (link === null || id === undefined) return;
    event.preventDefault();
    openPhoto(id);
  });

  // A reload or a shared link landing directly on #photo-<id> opens
  // straight there, with no visible transition.
  const initialId = photoIdFromHash(location.hash);
  if (initialId !== null && ids.includes(initialId)) {
    open(ids.indexOf(initialId));
  }
}

// Deferred a microtask, not called inline: saved-view.ts and share-view.ts
// both `import { openPhoto } from './lightbox.ts'` so they can hand a
// clicked grid tile off to the lightbox once they've pruned it down to
// their own subset — but per the ES module spec, evaluating an import means
// running the imported module's own top-level code first, *before* the
// importer's body continues. That would put this file's side effect
// (init(), which snapshots `items`/`ids` from whatever's in the DOM right
// now) ahead of that pruning on both pages, regardless of which <script>
// tag looks first in the document. A microtask always runs after the
// synchronous script that queued it finishes — which on these two pages
// includes the rest of that importing script's body, the pruning included
// — so by the time init() actually reads the DOM, it's already down to the
// right subset. The other pages ([tag].astro, selected/index.astro,
// film/[stock].astro) see no change: init() still runs before anything
// else touches the page.
const deferredInit = (): void => {
  queueMicrotask(init);
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', deferredInit);
} else {
  deferredInit();
}
