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
 *    out — and starts loading — the server's archival order; then the
 *    first row loads eagerly, the first tile at high priority, because
 *    those are the photographs actually on top.
 * 2. Masonry: each figure into whichever column is shortest, at its own
 *    aspect ratio (width/height attributes are on every <img>, so heights
 *    are known before any image loads). Only positions change, never DOM
 *    order, so the lightbox, tab order and Selected Work's filter keep
 *    working. Absolute positioning rather than fine grid-row spans: a
 *    400-photograph page would need more implicit rows than browsers lay
 *    out.
 * 3. Afterwards: re-place on a width change, when figures are reordered
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
    tiles.slice(0, columnCount()).forEach((tile, index) => {
      const img = tile.querySelector('img');
      if (!img) return;
      img.loading = 'eager';
      if (index === 0) img.fetchPriority = 'high';
    });
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
