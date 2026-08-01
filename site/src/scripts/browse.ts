/**
 * Continuous-scroll browse mode, layered on top of the plain grid.
 *
 * Progressive enhancement: every grid thumbnail is a real link to its
 * full-size JPEG (see Photo.astro). This script intercepts plain left-clicks
 * on those links and opens the in-page browse view instead; without it, or if
 * it fails, the links still work exactly as before.
 *
 * State lives in the URL (`#photo-<sourceId>`) rather than only in memory, so
 * the back button closes browse mode, and a reload or a shared link reopens
 * at the same photograph. Only the click that *opens* browse mode pushes a
 * history entry — scrolling or using the keyboard replaces it, so browsing
 * through the whole album doesn't fill up history with one entry per photo.
 */

const PHOTO_HASH_PREFIX = '#photo-';
const PRELOAD_RADIUS = 1;
const CURRENT_MARK = 0.5;

interface BrowseHistoryState {
  readonly browse?: boolean;
}

function photoIdFromHash(hash: string): string | null {
  return hash.startsWith(PHOTO_HASH_PREFIX) ? hash.slice(PHOTO_HASH_PREFIX.length) : null;
}

function isBrowseState(state: unknown): state is BrowseHistoryState {
  return (
    typeof state === 'object' && state !== null && (state as BrowseHistoryState).browse === true
  );
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-browse]');
  const grid = document.querySelector<HTMLElement>('[data-grid]');
  if (root === null || grid === null) return;

  const stack = root.querySelector<HTMLElement>('[data-browse-stack]');
  const closeButton = root.querySelector<HTMLButtonElement>('[data-browse-close]');
  const position = root.querySelector<HTMLElement>('[data-browse-position]');
  if (stack === null || closeButton === null) return;

  const items = Array.from(stack.querySelectorAll<HTMLElement>('[data-photo-id]'));
  const ids = items.map((item) => item.dataset['photoId'] ?? '');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentIndex = -1;
  let lastTrigger: HTMLElement | null = null;

  // Arrow functions, not declarations: TS only carries the `closeButton`/`stack`
  // non-null narrowing above into closures it can prove run after that check,
  // which excludes hoisted function declarations.
  const isOpen = (): boolean => document.body.classList.contains('is-browsing');

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
    items[index]?.scrollIntoView({ behavior, block: 'start' });
  };

  const show = (id: string, behavior: ScrollBehavior): void => {
    const index = ids.indexOf(id);
    if (index === -1) return;
    document.body.classList.add('is-browsing');
    focusItem(index, behavior);
    closeButton.focus();
  };

  const hide = (): void => {
    document.body.classList.remove('is-browsing');
    lastTrigger?.focus();
    lastTrigger = null;
  };

  const syncFromHash = (behavior: ScrollBehavior): void => {
    const id = photoIdFromHash(location.hash);
    if (id !== null && ids.includes(id)) {
      show(id, behavior);
    } else if (isOpen()) {
      hide();
    }
  };

  const replaceHash = (id: string): void => {
    history.replaceState(
      { browse: true } satisfies BrowseHistoryState,
      '',
      `${PHOTO_HASH_PREFIX}${id}`,
    );
  };

  // A reload or a link landing directly on #photo-<id> opens straight there,
  // with no visible transition from the grid.
  syncFromHash('instant');

  grid.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a.photo');
    if (link === null) return;
    const figure = event.target.closest<HTMLElement>('[data-photo-id]');
    const id = figure?.dataset['photoId'];
    if (id === undefined) return;

    event.preventDefault();
    lastTrigger = link instanceof HTMLElement ? link : null;
    history.pushState(
      { browse: true } satisfies BrowseHistoryState,
      '',
      `${PHOTO_HASH_PREFIX}${id}`,
    );
    show(id, 'instant');
  });

  closeButton.addEventListener('click', () => {
    if (isBrowseState(history.state)) {
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      hide();
    }
  });

  window.addEventListener('popstate', () => {
    syncFromHash('instant');
  });

  window.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      closeButton.click();
      return;
    }
    const forward = event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === 'j';
    const backward = event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'k';
    if (!forward && !backward) return;
    const nextIndex = currentIndex + (forward ? 1 : -1);
    const id = ids[nextIndex];
    if (id === undefined) return;

    event.preventDefault();
    replaceHash(id);
    focusItem(nextIndex, reduceMotion ? 'instant' : 'smooth');
  });

  const observer = new IntersectionObserver(
    (entries) => {
      if (!isOpen()) return;
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
    { root: stack, threshold: [0, 0.25, 0.5, 0.75, 1] },
  );
  items.forEach((item) => observer.observe(item));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
