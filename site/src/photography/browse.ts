/**
 * Continuous-scroll browse mode is the default reading experience, not an
 * alternative layout — the grid is the explicit opt-out (`#grid`) and the
 * no-JS fallback: every grid thumbnail is still a real link to its full-size
 * JPEG (see Photo.astro), so without this script, or if it fails, a visitor
 * gets the plain grid and those links work exactly as before.
 *
 * State lives in the URL rather than only in memory: `#photo-<sourceId>`
 * opens at a specific photograph, `#grid` opts out to the grid, and no hash
 * at all is the default landing in browse mode, at the title panel rather
 * than any specific photograph. A reload or a shared link reopens at the
 * same state. Only the transition that *opens* a specific photograph (a grid
 * click) pushes a history entry — scrolling or using the keyboard replaces
 * it, so browsing through the whole album doesn't fill up history with one
 * entry per photo.
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
  const toggleButton = document.querySelector<HTMLButtonElement>('[data-view-toggle]');
  const position = root.querySelector<HTMLElement>('[data-browse-position]');
  if (stack === null || toggleButton === null) return;

  const items = Array.from(stack.querySelectorAll<HTMLElement>('[data-photo-id]'));
  const ids = items.map((item) => item.dataset['photoId'] ?? '');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let currentIndex = -1;
  let lastTrigger: HTMLElement | null = null;

  // Arrow functions, not declarations: TS only carries the `toggleButton`/`stack`
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
    toggleButton.focus();
  };

  const hide = (): void => {
    document.body.classList.remove('is-browsing');
    lastTrigger?.focus();
    lastTrigger = null;
  };

  // No specific photo focused — the title panel at the top of the stack is
  // whatever's on screen, same as any other scroll position, and the usual
  // scroll-driven IntersectionObserver picks up currentIndex once the
  // visitor scrolls into the sequence.
  const showIntro = (): void => {
    document.body.classList.add('is-browsing');
  };

  const syncFromHash = (behavior: ScrollBehavior): void => {
    const id = photoIdFromHash(location.hash);
    if (id !== null && ids.includes(id)) {
      show(id, behavior);
    } else if (location.hash === '#grid') {
      hide();
    } else {
      showIntro();
    }
  };

  const replaceHash = (id: string): void => {
    history.replaceState(
      { browse: true } satisfies BrowseHistoryState,
      '',
      `${PHOTO_HASH_PREFIX}${id}`,
    );
  };

  const open = (id: string, trigger: HTMLElement | null): void => {
    lastTrigger = trigger;
    history.pushState(
      { browse: true } satisfies BrowseHistoryState,
      '',
      `${PHOTO_HASH_PREFIX}${id}`,
    );
    show(id, 'instant');
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
    open(id, link instanceof HTMLElement ? link : null);
  });

  toggleButton.addEventListener('click', () => {
    if (!isOpen()) {
      // Entering from the grid rather than a specific photo: clear any
      // #grid left in the URL and land at the top of the stack, same as a
      // fresh visit with no hash at all.
      history.pushState(null, '', location.pathname + location.search);
      stack.scrollTo({ top: 0, behavior: 'instant' });
      showIntro();
      return;
    }
    // A specific photo was opened by a grid click, which pushed a history
    // entry — going back lands exactly where that click happened (usually
    // #grid). Landing directly in browse mode (the default, no entry pushed)
    // has nothing to go back to, so opting out pushes #grid explicitly.
    if (isBrowseState(history.state)) {
      history.back();
    } else {
      history.pushState(null, '', '#grid');
      hide();
    }
  });

  window.addEventListener('popstate', () => {
    syncFromHash('instant');
  });

  window.addEventListener('keydown', (event) => {
    if (!isOpen()) return;
    if (event.key === 'Escape') {
      toggleButton.click();
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
  // Deferred a frame: observing immediately after `is-browsing` is added can
  // fire against the pre-layout geometry (display:none's box, not the
  // min-height:90vh title panel it's about to become), which was promoting
  // photo 1 to "current" — and pushing #photo-<id> into the URL — before a
  // single pixel had scrolled.
  requestAnimationFrame(() => {
    items.forEach((item) => observer.observe(item));
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
