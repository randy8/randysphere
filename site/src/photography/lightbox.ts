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

import type { LightboxPhoto } from './lightbox-data.ts';
import { hasSeenHint, isSaved, markHintSeen, savedCount, toggleSaved } from './saved.ts';
import { initSwipe } from './swipe.ts';

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

// Same escape hatch, for a page that reorders or filters its own grid
// after load (Selected Work's shuffle and film-stock filter, see
// selected-view.ts) — prev/next should step through exactly what the grid
// now shows, in the order it shows it. An order set before init() has run
// is held here and applied the moment it does.
let orderHandler: ((ids: readonly string[]) => void) | null = null;
let pendingOrder: readonly string[] | null = null;

/** Restricts the lightbox to these photos, in this order. Unknown ids are ignored. */
export function setLightboxOrder(ids: readonly string[]): void {
  if (orderHandler === null) pendingOrder = ids;
  else orderHandler(ids);
}

function applySaveButtonState(button: HTMLElement, saved: boolean): void {
  button.setAttribute('aria-pressed', String(saved));
  const icon = button.querySelector('[data-save-icon]');
  const label = button.querySelector('[data-save-label]');
  if (icon !== null) icon.textContent = saved ? '✓' : '+';
  if (label !== null) label.textContent = saved ? 'Saved' : 'Save';
}

/**
 * The page's own thumbnail of this photograph, if it has already arrived —
 * shown, scaled up, behind the full-size image while that loads, so a
 * photograph opens at once and sharpens rather than starting from a blank.
 * Only a finished one: an unloaded tile's URL would start a second download.
 */
function thumbnailOf(id: string): string | null {
  const tile = document.querySelector<HTMLImageElement>(
    `:not(.lightbox-item)[data-photo-id="${CSS.escape(id)}"] img`,
  );
  return tile !== null && tile.complete && tile.naturalWidth > 0 ? tile.currentSrc : null;
}

/**
 * Pours one photograph's data into a slot — the same attributes Photo.astro
 * renders, set from lightbox-data.ts's JSON. A slot already holding this
 * photograph is left alone, so a photo that was preloaded beside the
 * current one is never reloaded when it becomes current.
 *
 * Each photograph gets a fresh <img>. A reused one keeps painting the
 * photograph it held until the new one's bytes arrive — on a slow
 * connection, the previous photograph flashed up before the right one.
 */
function fill(slot: HTMLElement, photo: LightboxPhoto): void {
  if (slot.dataset['photoId'] === photo.id) return;
  slot.dataset['photoId'] = photo.id;
  const picture = slot.querySelector('picture');
  picture?.setAttribute('data-orientation', photo.height > photo.width ? 'portrait' : 'landscape');
  const [avif, webp] = Array.from(slot.querySelectorAll('source'));
  const old = slot.querySelector('img');
  // Inserted empty, so it fetches nothing until every attribute is set.
  const img = old === null ? null : document.createElement('img');
  if (old !== null && img !== null) {
    img.loading = 'eager';
    img.decoding = 'async';
    old.replaceWith(img);
  }
  for (const [source, value] of [
    [avif, photo.avif],
    [webp, photo.webp],
  ] as const) {
    if (source === undefined) continue;
    if (value === null) source.removeAttribute('srcset');
    else source.srcset = value;
  }
  if (img !== null) {
    if (photo.jpeg === null) {
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
    } else {
      img.sizes = '100vw';
      img.srcset = photo.jpeg;
    }
    img.width = photo.width;
    img.height = photo.height;
    img.alt = photo.alt;
    img.style.backgroundColor = photo.color;
    const thumbnail = thumbnailOf(photo.id);
    if (thumbnail !== null) img.style.backgroundImage = `url("${thumbnail}")`;
    img.src = photo.src;
  }
  const film = slot.querySelector<HTMLElement>('[data-slot-film]');
  const filmLink = film?.querySelector('a');
  if (film && filmLink) {
    film.hidden = photo.filmStock === null;
    filmLink.textContent = photo.filmStock ?? '';
    filmLink.href = photo.filmStock === null ? '' : `/exposures/film/${photo.filmStock}/`;
  }
  const caption = slot.querySelector<HTMLElement>('[data-slot-caption]');
  if (caption) {
    caption.hidden = photo.caption === null;
    caption.textContent = photo.caption ?? '';
  }
  const camera = slot.querySelector<HTMLElement>('[data-slot-camera]');
  if (camera) {
    camera.hidden = photo.camera === null;
    camera.textContent = photo.camera ?? '';
  }
  const button = slot.querySelector<HTMLElement>('[data-save]');
  if (button !== null) applySaveButtonState(button, isSaved(photo.id));
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-lightbox]');
  if (root === null) return;

  const stage = root.querySelector<HTMLElement>('[data-lightbox-stage]');
  if (stage === null) return;

  const photos = JSON.parse(
    root.querySelector('[data-lightbox-photos]')?.textContent ?? '[]',
  ) as LightboxPhoto[];
  const byId = new Map(photos.map((photo) => [photo.id, photo]));
  let ids = photos.map((photo) => photo.id);
  const slots = Array.from(stage.querySelectorAll<HTMLElement>('.lightbox-item'));
  const position = root.querySelector<HTMLElement>('[data-lightbox-position]');

  let currentIndex = -1;
  // The slots playing each role right now; swipe.ts reads these.
  let current: HTMLElement | null = null;
  let previous: HTMLElement | null = null;
  let following: HTMLElement | null = null;
  let hintChecked = false;
  // The photograph the first-use hint was shown under, so it stays with
  // that photograph (and only it) as slots are reused.
  let hintFor: string | null = null;
  let lastFocused: HTMLElement | null = null;

  const syncHint = (slot: HTMLElement): void => {
    const hint = slot.querySelector<HTMLElement>('[data-save-hint]');
    if (hint !== null) hint.hidden = hintFor === null || slot.dataset['photoId'] !== hintFor;
  };

  // The first-use hint attaches to whichever photo a visitor actually
  // opens first, shown once ever — not a modal or a tour, just one quiet
  // line under that one photo's Save button, gone for good once shown.
  const maybeShowHint = (): void => {
    if (hintChecked) return;
    hintChecked = true;
    if (savedCount() > 0 || hasSeenHint() || current === null) return;
    hintFor = current.dataset['photoId'] ?? null;
    syncHint(current);
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

  /**
   * Shows `index`, with its neighbours loaded in the other two slots so a
   * prev/next tap or a swipe never meets a blank frame. Each role goes to
   * the slot already holding that photograph where there is one — after a
   * step forward the slot that held the next photo simply becomes the
   * current one — and only what's left over is refilled.
   */
  const activate = (index: number): void => {
    const count = ids.length;
    const idAt = (n: number): string => ids[(n + count) % count] ?? '';
    // One, two or three distinct photographs: with two, the previous and
    // next are the same one; with one, both are the current photo itself.
    const wanted = [...new Set([idAt(index), idAt(index - 1), idAt(index + 1)])];
    const free = [...slots];
    const slotFor = new Map<string, HTMLElement>();
    for (const id of wanted) {
      const held = free.findIndex((slot) => slot.dataset['photoId'] === id);
      if (held !== -1) slotFor.set(id, free.splice(held, 1)[0] as HTMLElement);
    }
    for (const id of wanted) {
      if (slotFor.has(id)) continue;
      const spare = free.shift();
      const photo = byId.get(id);
      if (spare === undefined || photo === undefined) continue;
      fill(spare, photo);
      slotFor.set(id, spare);
    }
    current = slotFor.get(idAt(index)) ?? null;
    previous = slotFor.get(idAt(index - 1)) ?? null;
    following = slotFor.get(idAt(index + 1)) ?? null;

    slots.forEach((slot) => {
      slot.classList.toggle('is-active', slot === current);
      syncHint(slot);
      // The neighbours are display: none until stepped to, so the browser
      // downloads them but wouldn't decode them until then — a blank frame
      // on every step. Decode them now, off the main thread.
      if (slot !== current)
        void slot
          .querySelector('img')
          ?.decode()
          .catch(() => {});
    });
    currentIndex = index;
    if (position !== null) position.textContent = `${(index + 1).toString()} / ${count.toString()}`;
    maybeShowHint();
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
    if (ids.length === 0) return;
    const next = (currentIndex + (forward ? 1 : -1) + ids.length) % ids.length;
    activate(next);
  };

  root.querySelector('[data-lightbox-close]')?.addEventListener('click', close);
  root.querySelectorAll<HTMLElement>('[data-nav]').forEach((button) => {
    button.addEventListener('click', () => advance(button.dataset['nav'] === 'next'));
  });

  // Clicking the scrim itself (not a photo, caption, or control) closes —
  // the standard lightbox dismissal, alongside Escape and the × button.
  // Not on a touch screen: there a stray tap beside a photo is far too easy,
  // and swipe-down (swipe.ts) and × are the deliberate ways out.
  const coarsePointer = window.matchMedia('(pointer: coarse)');
  root.addEventListener('click', (event) => {
    if (coarsePointer.matches) return;
    if (event.target === root || event.target === stage) close();
  });

  initSwipe(root, {
    current: () => current,
    neighbours: () => ({ prev: previous, next: following }),
    advance,
    close,
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
    hintFor = null;
    if (item) syncHint(item);
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
    if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      current?.querySelector<HTMLElement>('[data-save]')?.click();
      return;
    }
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

  orderHandler = (order) => {
    ids = order.filter((id) => byId.has(id));
    // A visible photo that's no longer in the order would leave prev/next
    // pointing at slots for the old sequence; the next activate() refills.
    if (!root.hidden && currentIndex !== -1) {
      const id = current?.dataset['photoId'] ?? '';
      const index = ids.indexOf(id);
      if (index !== -1) activate(index);
    }
  };
  if (pendingOrder !== null) {
    orderHandler(pendingOrder);
    pendingOrder = null;
  }

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
// import this module and call setLightboxOrder() with their own subset as
// part of their own top-level code — which, per the ES module spec, runs
// after this module's. A microtask runs once that synchronous script has
// finished, so by the time init() opens a #photo-<id> from the URL, the
// page's real order (pending until then, see setLightboxOrder) is already
// in place. Every other page sees no difference.
const deferredInit = (): void => {
  queueMicrotask(init);
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', deferredInit);
} else {
  deferredInit();
}
