/**
 * Masonry for the photography grid: each photograph goes into whichever
 * column is currently shortest, at its own aspect ratio, so a portrait
 * frame no longer sets the height of a whole row and leaves a gap under
 * every landscape beside it.
 *
 * Progressive enhancement over `.grid` exactly as it renders without
 * script — a plain CSS grid, same columns, same gap — so a no-JS visitor
 * still gets every photograph, just top-aligned in rows. Only positions
 * change here, never DOM order, so the lightbox's prev/next, tab order,
 * and Selected Work's filter/shuffle (which reorder or hide figures, and
 * are picked up by the MutationObserver below) all keep working untouched.
 *
 * Absolute positioning rather than a grid with fine row spans: a
 * 400-photograph page would need tens of thousands of implicit grid rows,
 * past what browsers will lay out.
 */

function columnCount(grid: HTMLElement): number {
  const value = getComputedStyle(grid).getPropertyValue('--grid-columns').trim();
  const count = Number.parseInt(value, 10);
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function layout(grid: HTMLElement): void {
  const items = Array.from(grid.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.hidden,
  );
  const columns = columnCount(grid);
  const gap = Number.parseFloat(getComputedStyle(grid).columnGap) || 0;
  const width = (grid.clientWidth - gap * (columns - 1)) / columns;

  // Every width first, then every height read in one go, then every
  // position — one forced layout, not one per photograph.
  for (const item of items) item.style.width = `${String(width)}px`;
  const heights = items.map((item) => item.offsetHeight);

  const columnHeights = Array.from({ length: columns }, () => 0);
  items.forEach((item, index) => {
    const column = columnHeights.indexOf(Math.min(...columnHeights));
    const top = columnHeights[column] ?? 0;
    item.style.transform = `translate(${String(column * (width + gap))}px, ${String(top)}px)`;
    columnHeights[column] = top + (heights[index] ?? 0) + gap;
  });

  grid.style.height = `${String(Math.max(0, Math.max(...columnHeights) - gap))}px`;
}

function init(grid: HTMLElement): void {
  grid.classList.add('is-masonry');
  layout(grid);

  // Width only: setting the grid's own height above would otherwise
  // re-trigger this observer forever.
  let lastWidth = grid.clientWidth;
  new ResizeObserver(() => {
    if (grid.clientWidth === lastWidth) return;
    lastWidth = grid.clientWidth;
    layout(grid);
  }).observe(grid);

  // Shuffle reorders figures; the film filter toggles `hidden`.
  new MutationObserver(() => {
    layout(grid);
  }).observe(grid, { childList: true, subtree: true, attributeFilter: ['hidden'] });

  // Web fonts can change a caption's line height after first layout.
  void document.fonts.ready.then(() => {
    layout(grid);
  });
}

const grid = document.querySelector<HTMLElement>('.grid[data-grid]');
if (grid !== null) init(grid);
