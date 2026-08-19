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

const PHOTO_HASH_PREFIX = '#photo-';
const PRELOAD_RADIUS = 1;
const CURRENT_MARK = 0.5;

function photoIdFromHash(hash: string): string | null {
  return hash.startsWith(PHOTO_HASH_PREFIX) ? hash.slice(PHOTO_HASH_PREFIX.length) : null;
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-browse]');
  if (root === null) return;

  const stack = root.querySelector<HTMLElement>('[data-browse-stack]');
  const position = root.querySelector<HTMLElement>('[data-browse-position]');
  if (stack === null) return;

  const items = Array.from(stack.querySelectorAll<HTMLElement>('[data-photo-id]'));
  const ids = items.map((item) => item.dataset['photoId'] ?? '');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentIndex = -1;

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
    items[index]?.scrollIntoView({ behavior, inline: 'start', block: 'nearest' });
  };

  // Each album loops on itself — forward from the last photo lands back on
  // the first, backward from the first lands on the last — so neither the
  // keyboard nor a click ever sweeps a visitor out to a whole different
  // page by accident. The one deliberate way to actually leave for the next
  // album is the outro panel below, reached by scrolling (or tabbing) to
  // it, never by holding down an arrow key.
  const advance = (fromIndex: number, forward: boolean): void => {
    const targetIndex = (fromIndex + (forward ? 1 : -1) + items.length) % items.length;
    const id = ids[targetIndex];
    if (id === undefined) return;
    replaceHash(id);
    focusItem(targetIndex, reduceMotion ? 'instant' : 'smooth');
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

  // The currently-open photo doubles as its own prev/next control: the left
  // half advances backward, the right half forward — same destinations as
  // the arrow keys, just reachable with a click. Decorative (aria-hidden),
  // not a tab stop: the arrow keys already cover this for anyone not using
  // a pointer, and two more focusable elements per photo would only add
  // noise to keyboard/screen-reader navigation through a long album.
  stack.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const nav = event.target.closest<HTMLElement>('[data-nav]');
    if (nav === null) return;
    const item = nav.closest<HTMLElement>('.browse-item');
    if (item === null) return;
    const index = items.indexOf(item);
    if (index === -1) return;
    advance(index, nav.dataset['nav'] === 'next');
  });

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
