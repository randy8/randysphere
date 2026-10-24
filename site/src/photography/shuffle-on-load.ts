/** Imported by every photo page except Selected Work: deals its grid into a random order on load. See shuffle-grid.ts. */

import { shuffleGrid } from './shuffle-grid.ts';

const grid = document.querySelector<HTMLElement>('.grid');
if (grid !== null) shuffleGrid(grid);
