/**
 * Turns a dataset on disk into game files (validate.ts) for
 * catalog.importEpisode. Two shapes:
 *
 * - JSON: one `quiz-game/1` game, a list of them, or
 *   `{ "format": "quiz-games/1", "source": {…}, "games": [...] }`.
 * - CSV or TSV, one clue per line, in the flat layout historical archives
 *   are usually distributed in. Columns are matched by header name, case
 *   and punctuation ignored:
 *     show / show number, air date, round, category, value,
 *     clue / question / text   (what is read to the players),
 *     response / answer        (what they must respond),
 *   and optionally: row, order, wager / daily double, accept (|-separated),
 *   notes, category note / comments, media url, media kind, season.
 *
 * Rounds are recognised by number (1, 2, 3 = final) or by name ("first",
 * "second", "double…", "final…", "tiebreak…"). Categories keep the order
 * they first appear in. A clue's row comes from its `row` column, else from
 * its value's place in the round's values; a value that fits no row (a
 * wager amount in place of the face value) is taken as a wager clue and
 * put in the category's first empty row. Values are inferred per round:
 * the configuration (100–500, 200–1,000, 400–2,000…) that explains the
 * most of the round's values.
 *
 * Nothing here fetches anything. A dataset is whatever you have the right
 * to use, already on disk.
 */

import { InvalidGame, parseGame } from './validate.ts';
import type { GameFile } from './validate.ts';
import type { SourceInfo } from './catalog.ts';

export interface ParsedDataset {
  games: GameFile[];
  /** Per-game problems that were skipped, in words. */
  skipped: string[];
  source: SourceInfo | null;
}

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

const key = (header: string): string => header.toLowerCase().replace(/[^a-z]/g, '');

const COLUMNS: Record<string, readonly string[]> = {
  show: ['show', 'shownumber', 'episode', 'episodeid', 'game', 'gameid'],
  airDate: ['airdate', 'date'],
  season: ['season'],
  round: ['round'],
  category: ['category'],
  value: ['value'],
  text: ['clue', 'question', 'text'],
  response: ['response', 'answer', 'correctresponse'],
  row: ['row'],
  order: ['order', 'selectionorder'],
  wager: ['wager', 'dailydouble', 'dd', 'iswager'],
  accept: ['accept', 'alternates', 'alternatives'],
  notes: ['notes'],
  categoryNote: ['categorynote', 'comments', 'categorycomments'],
  mediaUrl: ['mediaurl', 'media'],
  mediaKind: ['mediakind'],
};

type Column = keyof typeof COLUMNS;

const CONFIGS: readonly (readonly number[])[] = [
  [100, 200, 300, 400, 500],
  [200, 400, 600, 800, 1000],
  [400, 800, 1200, 1600, 2000],
  [10, 20, 30, 40, 50],
  [1, 2, 3, 4, 5],
];

function roundIndex(value: string): number | 'final' | 'tiebreak' | null {
  const name = value.trim().toLowerCase();
  if (/^(1|j|first|single|jeopardy!?|jeopardy round)$/.test(name) || name.startsWith('first'))
    return 0;
  if (/^(2|dj|second)$/.test(name) || name.startsWith('double') || name.startsWith('second'))
    return 1;
  if (/^(3|fj)$/.test(name) || name.startsWith('final')) return 'final';
  if (name.startsWith('tie')) return 'tiebreak';
  return null;
}

const money = (value: string): number | null => {
  const digits = value.replace(/[$,\s]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : null;
};

/** Archives often carry light HTML (<i>, <br>) and escaped quotes; clue text is plain text here. */
const plain = (value: string): string =>
  value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\\(["'])/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

interface Row {
  get(column: Column): string;
}

export function parseCsv(text: string): ParsedDataset {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const [header, ...lines] = parseDelimited(
    text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    delimiter,
  );
  if (!header) throw new InvalidGame('the file is empty');
  const index = new Map<Column, number>();
  header.forEach((name, position) => {
    for (const [column, names] of Object.entries(COLUMNS)) {
      const known = column;
      if (names.includes(key(name)) && !index.has(known)) index.set(known, position);
    }
  });
  for (const required of ['round', 'category', 'text', 'response'] as const) {
    if (!index.has(required)) {
      throw new InvalidGame(`no "${required}" column (found: ${header.join(', ')})`);
    }
  }
  const rows: Row[] = lines.map((cells) => ({
    get: (column) => {
      const at = index.get(column);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    },
  }));

  // Group by episode, in file order.
  const episodes = new Map<string, Row[]>();
  for (const row of rows) {
    const id = row.get('show') || row.get('airDate') || 'game';
    const list = episodes.get(id) ?? [];
    list.push(row);
    episodes.set(id, list);
  }

  const games: GameFile[] = [];
  const skipped: string[] = [];
  for (const [id, episodeRows] of episodes) {
    try {
      games.push(parseGame(buildEpisode(id, episodeRows)));
    } catch (error) {
      skipped.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { games, skipped, source: null };
}

function buildEpisode(id: string, rows: Row[]): Record<string, unknown> {
  const first = rows[0];
  const boards = new Map<number, Row[]>();
  const finals: Row[] = [];
  const tiebreaks: Row[] = [];
  for (const row of rows) {
    const round = roundIndex(row.get('round'));
    if (round === null) throw new InvalidGame(`unknown round "${row.get('round')}"`);
    if (round === 'final') finals.push(row);
    else if (round === 'tiebreak') tiebreaks.push(row);
    else boards.set(round, [...(boards.get(round) ?? []), row]);
  }
  const clue = (row: Row): Record<string, unknown> => {
    const url = row.get('mediaUrl');
    const kind = row.get('mediaKind') || 'image';
    const order = Number(row.get('order'));
    return {
      text: plain(row.get('text')),
      response: plain(row.get('response')),
      accept: row.get('accept').split('|').map(plain).filter(Boolean),
      notes: plain(row.get('notes')),
      media: url ? { kind, url } : null,
      order: Number.isInteger(order) && order > 0 ? order : null,
    };
  };
  const rounds: Record<string, unknown>[] = [...boards.entries()]
    .sort(([a], [b]) => a - b)
    .map(([roundNumber, roundRows]) => {
      const observed = roundRows
        .map((row) => money(row.get('value')))
        .filter((value): value is number => value !== null);
      const values = [
        ...(CONFIGS.reduce<readonly number[] | null>((best, config) => {
          const hits = observed.filter((value) => config.includes(value)).length;
          const bestHits = best ? observed.filter((value) => best.includes(value)).length : -1;
          return hits > bestHits ? config : best;
        }, null) ?? (CONFIGS[1] as number[])),
      ];
      const categories = new Map<
        string,
        { note: string; clues: (Record<string, unknown> | null)[]; pending: Row[] }
      >();
      for (const row of roundRows) {
        const title = plain(row.get('category'));
        const category = categories.get(title) ?? {
          note: plain(row.get('categoryNote')),
          clues: values.map(() => null),
          pending: [],
        };
        categories.set(title, category);
        const explicitRow = Number(row.get('row'));
        const value = money(row.get('value'));
        const wagerFlag = /^(1|true|yes|y|dd|wager)$/i.test(row.get('wager'));
        const at =
          Number.isInteger(explicitRow) && row.get('row') !== ''
            ? explicitRow - 1
            : value === null
              ? -1
              : values.indexOf(value);
        if (at >= 0 && at < values.length && category.clues[at] === null) {
          category.clues[at] = { ...clue(row), wager: wagerFlag };
        } else {
          // Off the value grid: a wager amount where the face value would be.
          category.pending.push(row);
        }
      }
      for (const category of categories.values()) {
        for (const row of category.pending) {
          const empty = category.clues.indexOf(null);
          if (empty !== -1) category.clues[empty] = { ...clue(row), wager: true };
        }
      }
      return {
        kind: 'board',
        values,
        wagers: roundNumber === 0 ? 1 : 2,
        questionForm: roundNumber === 0 ? 'lenient' : 'strict',
        categories: [...categories.entries()].slice(0, 8).map(([title, category]) => ({
          title,
          note: category.note,
          clues: category.clues,
        })),
      };
    });
  const finalRow = finals[0];
  if (finalRow) {
    rounds.push({
      kind: 'final',
      category: plain(finalRow.get('category')),
      note: plain(finalRow.get('categoryNote')),
      clue: clue(finalRow),
    });
  }
  const airDate = first?.get('airDate') ?? '';
  const isoDate = /^\d{4}-\d{2}-\d{2}/.test(airDate) ? airDate.slice(0, 10) : null;
  const show = Number(first?.get('show'));
  const season = Number(first?.get('season'));
  return {
    title:
      Number.isInteger(show) && first?.get('show')
        ? `Show #${String(show)}`
        : isoDate
          ? `Game of ${isoDate}`
          : `Game ${id}`,
    credit: isoDate ? `Originally aired ${isoDate}` : '',
    episode: {
      id,
      showNumber: Number.isInteger(show) && first?.get('show') ? show : null,
      season: Number.isInteger(season) && first?.get('season') ? season : null,
      airDate: isoDate,
    },
    rounds,
    tiebreakers: tiebreaks.map((row) => ({
      category: plain(row.get('category')),
      clue: clue(row),
    })),
  };
}

export function parseJson(text: string): ParsedDataset {
  const input = JSON.parse(text) as unknown;
  const list: unknown[] = Array.isArray(input)
    ? input
    : typeof input === 'object' &&
        input !== null &&
        Array.isArray((input as { games?: unknown }).games)
      ? (input as { games: unknown[] }).games
      : [input];
  const sourceField =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as { source?: unknown }).source
      : undefined;
  const source =
    typeof sourceField === 'object' &&
    sourceField !== null &&
    typeof (sourceField as { name?: unknown }).name === 'string'
      ? {
          name: String((sourceField as { name: string }).name),
          license: String((sourceField as { license?: string }).license ?? ''),
          url: String((sourceField as { url?: string }).url ?? ''),
          notes: String((sourceField as { notes?: string }).notes ?? ''),
        }
      : null;
  const games: GameFile[] = [];
  const skipped: string[] = [];
  list.forEach((entry, index) => {
    try {
      games.push(parseGame(entry));
    } catch (error) {
      skipped.push(
        `game ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return { games, skipped, source };
}

export function parseDataset(name: string, text: string): ParsedDataset {
  return /\.json$/i.test(name) ||
    text.trimStart().startsWith('{') ||
    text.trimStart().startsWith('[')
    ? parseJson(text)
    : parseCsv(text);
}
