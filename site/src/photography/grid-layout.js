/**
 * The photo grid's layout, run inline (GridLayout.astro) immediately after
 * the grid's closing tag, while the page is still being parsed — so the
 * first paint already shows the final arrangement and nothing shifts.
 * Plain JavaScript because it's inlined as text: an inline script can't
 * import, and a module would run after the first paint (which is exactly
 * what caused a 0.11–0.14 layout shift on the shuffled pages, Lighthouse
 * 2026-10-25).
 *
 * 1. Deal (pages that shuffle): a random order, before the browser lays
 *    out — and starts loading — the server's archival order. Random per
 *    visit, kept for the rest of the session (see below). Weighted by each
 *    figure's `data-w` (archive.ts's weightOf: the photographer's rating),
 *    so a better photograph tends to come earlier — never certainly.
 *    No data-w is 1.
 * 2. Masonry: each figure into whichever column is shortest, at its own
 *    aspect ratio (width/height attributes are on every <img>, so heights
 *    are known before any image loads). Only positions change, never DOM
 *    order, so the lightbox, tab order and Selected Work's filter keep
 *    working. Absolute positioning rather than fine grid-row spans: a
 *    400-photograph page would need more implicit rows than browsers lay
 *    out.
 * 3. Priority: the photographs that landed in the first viewport load
 *    eagerly at high priority; the rest wait until those have arrived,
 *    then load one screen ahead of the scroll.
 * 4. Afterwards: re-place on a width change, when figures are reordered
 *    or hidden (Shuffle, the film filter, Saved and Share pruning), and
 *    once web fonts settle a caption's height.
 *
 * Without JavaScript none of this runs: a plain CSS grid in archival order.
 */

// eslint-disable-next-line no-unused-vars -- invoked by GridLayout.astro, which inlines this file
function placeGrid(grid, deal) {
  if (!(grid instanceof HTMLElement)) return;

  const columnCount = () => {
    const count = Number.parseInt(getComputedStyle(grid).getPropertyValue('--grid-columns'), 10);
    return Number.isInteger(count) && count > 0 ? count : 1;
  };

  if (deal) {
    // A refresh deals again — that's what a visitor expects of it. Coming
    // back to the page (Back, or a link from another page) finds the
    // arrangement it left, and the photographs already in the cache on the
    // first screen. (Keeping the order through refreshes too, briefly on
    // 2026-10-26, made a refresh show the same photographs.) Seeded per
    // page, kept in the session.
    const key = `deal:${location.pathname}`;
    const navigation = performance.getEntriesByType('navigation')[0];
    const reload = navigation !== undefined && navigation.type === 'reload';
    let seed = 0;
    try {
      if (!reload) seed = Number(sessionStorage.getItem(key));
    } catch {
      seed = 0;
    }
    if (!Number.isInteger(seed) || seed <= 0) {
      seed = Math.floor(Math.random() * 4294967295) + 1;
      try {
        sessionStorage.setItem(key, String(seed));
      } catch {
        // Storage off: this visit's order just isn't kept.
      }
    }
    // mulberry32: a tiny seeded generator, the same order from the same seed.
    let state = seed >>> 0;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Efraimidis–Spirakis: each figure draws u^(1/weight) and the largest
    // go first — a uniform shuffle when every weight is equal, as
    // shuffle-grid.ts and exhibition-model.ts deal too.
    const keyed = Array.from(grid.children, (tile) => {
      const weight = Number(tile.getAttribute('data-w')) || 1;
      return { tile, key: Math.pow(random(), 1 / weight) };
    });
    keyed.sort((a, b) => b.key - a.key);
    grid.append(...keyed.map(({ tile }) => tile));
  }

  // Each figure's distance from the grid's top, as last placed — kept so
  // nothing has to read it back out of the DOM.
  const tops = new WeakMap();
  const layout = () => {
    const items = Array.from(grid.children).filter(
      (child) => child instanceof HTMLElement && !child.hidden,
    );
    const columns = columnCount();
    const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
    const width = (grid.clientWidth - gap * (columns - 1)) / columns;
    // Every width first, then every height read in one go, then every
    // position: one forced layout, not one per photograph.
    for (const item of items) item.style.width = `${width}px`;
    const heights = items.map((item) => item.offsetHeight);
    const columnHeights = Array.from({ length: columns }, () => 0);
    items.forEach((item, index) => {
      const column = columnHeights.indexOf(Math.min(...columnHeights));
      const top = columnHeights[column];
      item.style.transform = `translate(${column * (width + gap)}px, ${top}px)`;
      tops.set(item, top);
      columnHeights[column] = top + heights[index] + gap;
    });
    grid.style.height = `${Math.max(0, Math.max(...columnHeights) - gap)}px`;
  };

  grid.classList.add('is-masonry');
  layout();

  // Now every tile's place is known. The ones that landed in the first
  // viewport load immediately, at high priority — they're what the visitor
  // sees first, and the largest of them is the page's largest paint.
  //
  // The rest hold back until those have arrived (or 4 s pass), then load
  // one screen ahead of the scroll. Without this, a phone on a slow
  // connection lazy-loads ~40 off-screen photos at once (Chrome's lazy
  // margin is ~2500 px there), splitting the bandwidth with the ~9 on
  // screen: live, 2026-10-25, every visible photo took 11.2 s on
  // Exposures. A photo scrolled into view loads at once, gate or not.
  const viewportBottom = window.innerHeight - grid.getBoundingClientRect().top;
  const visible = [];
  const held = [];
  for (const item of grid.children) {
    const img = item.querySelector('img');
    if (!img) continue;
    // From layout(), not getComputedStyle: this loop also edits attributes,
    // so each read would force a fresh style pass — 251 of them on
    // Exposures, 3 s of main thread on a 4×-throttled phone (2026-10-26).
    if ((tops.get(item) ?? Infinity) < viewportBottom) {
      img.loading = 'eager';
      img.fetchPriority = 'high';
      visible.push(img);
      continue;
    }
    for (const source of item.querySelectorAll('source[srcset], img[srcset]')) {
      source.dataset.srcset = source.getAttribute('srcset');
      source.removeAttribute('srcset');
    }
    img.dataset.src = img.getAttribute('src');
    img.removeAttribute('src');
    held.push(item);
  }
  const release = (item) => {
    for (const el of item.querySelectorAll('[data-srcset]')) {
      el.setAttribute('srcset', el.dataset.srcset);
      delete el.dataset.srcset;
    }
    const img = item.querySelector('img[data-src]');
    if (img) {
      img.setAttribute('src', img.dataset.src);
      delete img.dataset.src;
    }
  };
  const watch = (margin) => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          release(entry.target);
        }
      },
      { rootMargin: margin },
    );
    for (const item of held) if (item.querySelector('img[data-src]')) observer.observe(item);
    return observer;
  };
  if (held.length > 0) {
    const onScreen = watch('0px');
    const arrived = visible.map((img) =>
      img.complete
        ? null
        : new Promise((done) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          }),
    );
    void Promise.race([Promise.all(arrived), new Promise((done) => setTimeout(done, 4000))]).then(
      () => {
        onScreen.disconnect();
        watch('100% 0px');
      },
    );
  }

  // Width only: setting the grid's own height above would otherwise
  // re-trigger the observer forever.
  let lastWidth = grid.clientWidth;
  new ResizeObserver(() => {
    if (grid.clientWidth === lastWidth) return;
    lastWidth = grid.clientWidth;
    layout();
  }).observe(grid);
  new MutationObserver(layout).observe(grid, {
    childList: true,
    subtree: true,
    attributeFilter: ['hidden'],
  });
  void document.fonts.ready.then(layout);
}
