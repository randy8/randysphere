import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatCsvRow, parseCsv } from './csv.ts';

/**
 * Drop Letterboxd's `ratings.csv` (from Settings → Data → Export your data)
 * into films/inbox/ and run this — or just `pnpm sync`/`pnpm deploy`,
 * which do. It keeps the five-star rows, rewrites
 * films/five-star-ratings.csv exactly as the hand-trimmed file always was
 * (same columns, same order, same quoting), and then fetches TMDB details
 * for films that are new since last time.
 *
 * The inbox file itself is git-ignored and left where it is: re-running is
 * a no-op until a newer export replaces it. With nothing in the inbox,
 * this does nothing at all.
 */

const COLUMNS = ['Date', 'Name', 'Year', 'Letterboxd URI', 'Rating'] as const;

/**
 * The five-star rows of a Letterboxd ratings export, as the committed CSV's
 * text. Throws on anything that isn't a ratings export (diary.csv and
 * watched.csv share some columns but not `Rating`).
 */
export function fiveStarCsv(exportText: string): { readonly csv: string; readonly count: number } {
  const [header, ...rows] = parseCsv(exportText.replace(/^\uFEFF/, ''));
  const indexes = COLUMNS.map((column) => header?.indexOf(column) ?? -1);
  if (header === undefined || indexes.includes(-1)) {
    throw new Error(
      `Not a Letterboxd ratings export: expected columns ${COLUMNS.join(', ')}, ` +
        `got ${header?.join(', ') ?? 'nothing'}. Use ratings.csv from the export zip.`,
    );
  }
  const ratingIndex = header.indexOf('Rating');
  const kept = rows
    .filter((cells) => Number(cells[ratingIndex]) === 5)
    .map((cells) => formatCsvRow(indexes.map((index) => cells[index] ?? '')));
  return { csv: [formatCsvRow(COLUMNS), ...kept].join('\n') + '\n', count: kept.length };
}

/** "Title (Year)" for each row — the same key films.ts and tmdb.json use. */
function filmKeys(csv: string): Set<string> {
  const [header, ...rows] = parseCsv(csv);
  const name = header?.indexOf('Name') ?? -1;
  const year = header?.indexOf('Year') ?? -1;
  return new Set(rows.map((cells) => `${cells[name] ?? ''} (${cells[year] ?? ''})`));
}

function main(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const inbox = join(root, 'films', 'inbox');
  const target = join(root, 'films', 'five-star-ratings.csv');

  const exports = existsSync(inbox)
    ? readdirSync(inbox)
        .filter((name) => name.toLowerCase().endsWith('.csv'))
        .map((name) => join(inbox, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  const [newest] = exports;
  if (newest === undefined) {
    console.log('films: nothing in films/inbox/, leaving five-star-ratings.csv as it is.');
    return;
  }

  const { csv, count } = fiveStarCsv(readFileSync(newest, 'utf8'));
  const previous = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (csv === previous) {
    console.log(`films: ${String(count)} five-star films, unchanged.`);
    return;
  }

  const before = filmKeys(previous);
  const after = filmKeys(csv);
  const added = [...after].filter((key) => !before.has(key));
  const removed = [...before].filter((key) => !after.has(key));
  writeFileSync(target, csv);
  console.log(
    `films: ${String(count)} five-star films (${String(added.length)} new, ${String(removed.length)} no longer five stars).`,
  );
  for (const key of added) console.log(`  + ${key}`);
  for (const key of removed) console.log(`  - ${key}`);

  // Posters and plot text for the new arrivals. Online and optional: a
  // missing token or an unreachable TMDB leaves those films without a
  // poster for now, never fails the import (or the deploy running it).
  if (added.length === 0) return;
  const result = spawnSync(
    process.execPath,
    [join(root, 'tools', 'films', 'fetch-posters.ts'), ...added.map((key) => `--only=${key}`)],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.warn(
      'films: TMDB lookup did not complete; run `pnpm films:posters` later to fill in posters.',
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
