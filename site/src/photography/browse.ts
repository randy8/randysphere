/**
 * Browse mode is the only reading experience now — there is no grid to
 * toggle to or fall back on for a JavaScript-enabled visitor. The grid
 * markup still exists server-side purely as the no-JS fallback (every
 * thumbnail a real link to its full-size JPEG, see Photo.astro): without
 * this script, or if it fails, that plain grid is all a visitor gets,
 * since nothing else here ever runs to hide it.
 *
 * `#photo-<sourceId>` in the URL opens at a specific photograph; no hash
 * lands on the opening title panel. A reload or a shared link reopens at
 * the same photo. Scrolling and the keyboard/click navigation all replace
 * the URL rather than push it, so moving through a whole album never fills
 * up browser history with one entry per photo.
 */

import { hasSeenHint, isSaved, markHintSeen, savedCount, toggleSaved } from './saved.ts';

const PHOTO_HASH_PREFIX = '#photo-';
const PRELOAD_RADIUS = 1;
const CURRENT_MARK = 0.5;

function photoIdFromHash(hash: string): string | null {
  return hash.startsWith(PHOTO_HASH_PREFIX) ? hash.slice(PHOTO_HASH_PREFIX.length) : null;
}

// Set once per page by init(), below — an escape hatch for a page that
// needs to open a specific photo from outside this module entirely (the
// Saved page's own contact-sheet grid is the one caller today; every other
// page only ever opens through its own #photo-<id> hash or in-stack clicks,
// both handled internally). null until init() has actually run.
let openHandler: ((id: string) => boolean) | null = null;

/** Opens a specific photo in the current page's Browse stack, if one exists. Returns whether it did. */
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
  const root = document.querySelector<HTMLElement>('[data-browse]');
  if (root === null) return;

  const stack = root.querySelector<HTMLElement>('[data-browse-stack]');
  const position = root.querySelector<HTMLElement>('[data-browse-position]');
  if (stack === null) return;

  const items = Array.from(stack.querySelectorAll<HTMLElement>('[data-photo-id]'));
  const ids = items.map((item) => item.dataset['photoId'] ?? '');

  // Every save button starts server-rendered as unsaved (the server has no
  // way to know what's in this visitor's localStorage) — reconcile once,
  // on load, against whatever's actually saved.
  items.forEach((item, i) => {
    const button = item.querySelector<HTMLElement>('[data-save]');
    if (button !== null) applySaveButtonState(button, isSaved(ids[i] ?? ''));
  });

  let currentIndex = -1;
  let hintChecked = false;

  // The first-use hint attaches to whichever photo a visitor actually
  // encounters first (respecting a #photo-<id> deep link), shown once ever
  // — not modelled as a modal or tour, just one quiet line under that one
  // photo's Save button, gone for good the moment it's shown.
  const maybeShowHint = (index: number): void => {
    if (hintChecked) return;
    hintChecked = true;
    if (savedCount() > 0 || hasSeenHint()) return;
    const hint = items[index]?.querySelector<HTMLElement>('[data-save-hint]');
    if (hint === null || hint === undefined) return;
    hint.hidden = false;
    markHintSeen();
  };

  // Arrow functions, not declarations: TS only carries the `stack`
  // non-null narrowing above into closures it can prove run after that check,
  // which excludes hoisted function declarations.
  const setEagerWindow = (index: number): void => {
    items.forEach((item, i) => {
      const img = item.querySelector('img');
      if (img === null) return;
      img.loading = Math.abs(i - index) <= PRELOAD_RADIUS ? 'eager' : 'lazy';
    });
  };

  const updatePosition = (index: number): void => {
    if (position !== null)
      position.textContent = `${(index + 1).toString()} / ${items.length.toString()}`;
  };

  const focusItem = (index: number, behavior: ScrollBehavior): void => {
    currentIndex = index;
    setEagerWindow(index);
    updatePosition(index);
    maybeShowHint(index);
    items[index]?.scrollIntoView({ behavior, inline: 'start', block: 'nearest' });
  };

  // Each album loops on itself — forward from the last photo lands back on
  // the first, backward from the first lands on the last — so neither the
  // keyboard nor a click ever sweeps a visitor out to a whole different
  // page by accident. The one deliberate way to actually leave for the next
  // album is the outro panel below, reached by scrolling (or tabbing) to
  // it, never by holding down an arrow key.
  //
  // Always 'instant': a smooth slide necessarily paints both photos at once
  // mid-transition, which is exactly the "two images partially in view"
  // this reading mode is trying not to show. One photo replaces another in
  // a single frame, the same cut a click into a new page would make.
  const advance = (fromIndex: number, forward: boolean): void => {
    const targetIndex = (fromIndex + (forward ? 1 : -1) + items.length) % items.length;
    const id = ids[targetIndex];
    if (id === undefined) return;
    replaceHash(id);
    focusItem(targetIndex, 'instant');
  };

  // The URL always names the current photo, but only ever by replacing —
  // nothing here pushes a history entry any more, since there is no other
  // page state (a grid, a title-only view) to come back to by pressing
  // Back. Leaving the album entirely is a real navigation (the outro panel,
  // browse-home), which the browser already handles on its own.
  const replaceHash = (id: string): void => {
    history.replaceState(null, '', `${PHOTO_HASH_PREFIX}${id}`);
  };

  // A reload or a shared link landing directly on #photo-<id> opens
  // straight there, with no visible transition from the opening panel.
  const initialId = photoIdFromHash(location.hash);
  if (initialId !== null && ids.includes(initialId)) {
    focusItem(ids.indexOf(initialId), 'instant');
  }

  window.addEventListener('keydown', (event) => {
    // A modified arrow key is a browser or OS shortcut passing through
    // (Cmd+Left for history back on Mac, most notably) — never ours to
    // intercept. Swallowing it here previously left a visitor unable to
    // navigate back out of a film-stock or tag page at all, since the
    // keydown never reached the browser's own binding.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const forward =
      event.key === 'ArrowDown' ||
      event.key === 'ArrowRight' ||
      event.key === 'PageDown' ||
      event.key === 'j';
    const backward =
      event.key === 'ArrowUp' ||
      event.key === 'ArrowLeft' ||
      event.key === 'PageUp' ||
      event.key === 'k';
    if (!forward && !backward) return;
    event.preventDefault();
    advance(currentIndex, forward);
  });

  // The currently-open photo doubles as its own prev/next control: a strip
  // at its left edge advances backward, a strip at its right edge forward
  // (see base.css's .browse-item-nav) — same destinations as the arrow
  // keys, just reachable with a click. Decorative (aria-hidden), not a tab
  // stop: the arrow keys already cover this for anyone not using a
  // pointer, and two more focusable elements per photo would only add
  // noise to keyboard/screen-reader navigation through a long album.
  stack.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;

    const saveButton = event.target.closest<HTMLElement>('[data-save]');
    if (saveButton !== null) {
      const item = saveButton.closest<HTMLElement>('.browse-item');
      const id = item?.dataset['photoId'];
      if (id === undefined) return;
      applySaveButtonState(saveButton, toggleSaved(id));
      // Using the feature once is a stronger signal than merely seeing it —
      // dismiss the hint immediately rather than waiting for the once-ever
      // check above to run again (it may already have, on a different photo).
      const hint = item?.querySelector<HTMLElement>('[data-save-hint]');
      if (hint !== null && hint !== undefined) hint.hidden = true;
      markHintSeen();
      return;
    }

    const nav = event.target.closest<HTMLElement>('[data-nav]');
    if (nav === null) return;
    const item = nav.closest<HTMLElement>('.browse-item');
    if (item === null) return;
    const index = items.indexOf(item);
    if (index === -1) return;
    advance(index, nav.dataset['nav'] === 'next');
  });

  // Scrolling never moves the stack — only a click (the edge nav zones, a
  // tap included — a tap with no drag still fires 'click' normally below)
  // or an arrow key does. A wheel notch or a swipe used to advance past a
  // threshold, but any such threshold reads as unpredictable ("too
  // sensitive") next to a plain, deliberate click — so this only blocks the
  // browser's own proportional drag/scroll rather than replacing it with a
  // different gesture.
  root.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });
  root.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });

  const observer = new IntersectionObserver(
    (entries) => {
      let best: { index: number; ratio: number } | null = null;
      for (const entry of entries) {
        const index = items.indexOf(entry.target as HTMLElement);
        if (index === -1) continue;
        if (best === null || entry.intersectionRatio > best.ratio)
          best = { index, ratio: entry.intersectionRatio };
      }
      if (best === null || best.index === currentIndex || best.ratio < CURRENT_MARK) return;
      currentIndex = best.index;
      setEagerWindow(currentIndex);
      updatePosition(currentIndex);
      maybeShowHint(currentIndex);
      const id = ids[currentIndex];
      if (id !== undefined) replaceHash(id);
    },
    { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  // Deferred a frame: observing immediately after the page's own early
  // is-browsing script runs can fire against pre-layout geometry, which
  // was promoting photo 1 to "current" — and pushing #photo-<id> into the
  // URL — before a single pixel had scrolled.
  requestAnimationFrame(() => {
    items.forEach((item) => observer.observe(item));
  });

  // The one door in from outside this module — the Saved page's contact
  // sheet has no other way to tell an already-running Browse instance
  // "open this specific photo" (see openPhoto() above).
  openHandler = (id) => {
    const index = ids.indexOf(id);
    if (index === -1) return false;
    // is-browsing has to be added first — .browse is display:none until
    // then, and scrollIntoView on an element with no layout box (hidden by
    // a display:none ancestor) does nothing, silently leaving the stack at
    // its default scroll position (the first photo) once revealed.
    document.body.classList.add('is-browsing');
    replaceHash(id);
    focusItem(index, 'instant');
    return true;
  };

  // Every slide is edge to edge now, at every viewport width, so the home
  // link — legible over any image by design (mix-blend-mode) — can end up
  // straddling a photo and the paper showing in the snap gap between
  // slides mid-scroll, which renders as a visible seam sliced through the
  // text (see base.css). Hide it while the stack is actually moving and
  // bring it back a moment after it settles, rather than removing it
  // outright: it still needs to be reachable, just not painting that seam
  // mid-scroll.
  let scrollHideTimer: ReturnType<typeof setTimeout> | undefined;
  root.addEventListener(
    'scroll',
    () => {
      document.body.classList.add('is-scrolling-browse');
      clearTimeout(scrollHideTimer);
      scrollHideTimer = setTimeout(() => {
        document.body.classList.remove('is-scrolling-browse');
      }, 600);
    },
    { passive: true },
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
