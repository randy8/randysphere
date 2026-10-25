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
 *    out — and starts loading — the server's archival order.
 * 2. Masonry: each figure into whichever column is shortest, at its own
 *    aspect ratio (width/height attributes are on every <img>, so heights
 *    are known before any image loads). Only positions change, never DOM
 *    order, so the lightbox, tab order and Selected Work's filter keep
 *    working. Absolute positioning rather than fine grid-row spans: a
 *    400-photograph page would need more implicit rows than browsers lay
 *    out.
 * 3. Priority: the photographs that landed in the first viewport load
 *    eagerly at high priority; the rest stay lazy.
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
    const tiles = Array.from(grid.children);
    for (let i = tiles.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    grid.append(...tiles);
  }

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
      columnHeights[column] = top + heights[index] + gap;
    });
    grid.style.height = `${Math.max(0, Math.max(...columnHeights) - gap)}px`;
  };

  grid.classList.add('is-masonry');
  layout();

  // Now every tile's place is known: the ones that landed in the first
  // viewport load immediately, at high priority — they're what the
  // visitor sees first, and the largest of them is the page's largest
  // paint. Everything below stays lazy, so it can't compete for the
  // connection. (Measured 2026-10-25: promoting only the first tile per
  // column left the actual largest visible photo queued behind ~50 lazy
  // ones on a slow connection.)
  const viewportBottom = window.innerHeight - grid.getBoundingClientRect().top;
  for (const item of grid.children) {
    const top = new DOMMatrixReadOnly(getComputedStyle(item).transform).m42;
    if (top >= viewportBottom) continue;
    const img = item.querySelector('img');
    if (!img) continue;
    img.loading = 'eager';
    img.fetchPriority = 'high';
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
