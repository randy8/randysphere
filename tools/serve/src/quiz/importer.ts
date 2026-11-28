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

/** `draft` keeps a half-written game (a clue with no response yet) instead of skipping it: the converter's view. */
export interface ParseOptions {
  readonly draft?: boolean;
}

export function parseCsv(text: string, options: ParseOptions = {}): ParsedDataset {
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
      games.push(parseGame(buildEpisode(id, episodeRows), options));
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
          : id === 'game'
            ? 'Untitled game'
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

export function parseJson(text: string, options: ParseOptions = {}): ParsedDataset {
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
      games.push(parseGame(entry, options));
    } catch (error) {
      skipped.push(
        `game ${String(index + 1)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return { games, skipped, source };
}

export type DatasetFormat = 'auto' | 'json' | 'csv' | 'outline';

/** Which reader a text wants: JSON by its first character, an outline by a `#` heading line, else a spreadsheet. */
export function detectFormat(name: string, text: string): Exclude<DatasetFormat, 'auto'> {
  const start = text.trimStart();
  if (/\.json$/i.test(name) || start.startsWith('{') || start.startsWith('[')) return 'json';
  if (/\.(txt|md)$/i.test(name) || /^#\s*\S/m.test(text)) return 'outline';
  return 'csv';
}

export function parseDataset(
  name: string,
  text: string,
  options: ParseOptions & { format?: DatasetFormat } = {},
): ParsedDataset {
  const format =
    options.format && options.format !== 'auto' ? options.format : detectFormat(name, text);
  if (format === 'json') return parseJson(text, options);
  if (format === 'outline') return parseOutline(text, options);
  return parseCsv(text, options);
}

/**
 * A game written as plain text, the quickest way to type one out:
 *
 *     Title: Friday night
 *     # Round 1
 *     values: 200 400 600 800 1000      (optional)
 *     wagers: 1                         (optional)
 *     form: strict                      (optional; lenient is the default)
 *     ## SPACE PROBES
 *     note: every answer is a NASA mission      (optional, before its first clue)
 *     Launched in 1977, this probe left the solar system in 2012
 *     = Voyager 1 | Voyager             (the response, then alternatives)
 *     note: accept either Voyager       (optional host note, after a response)
 *     [wager] A clue to pin as a wager clue
 *     = Its response
 *     # Final
 *     ## WORLD LANDMARKS
 *     …one clue…
 *     # Tiebreak
 *     ## OCEANS
 *     …one clue per category…
 *
 * Clues fill a category's rows from the top; a clue can run over several
 * lines until its `=` line. Blank lines and lines starting `//` are ignored.
 */
export function parseOutline(text: string, options: ParseOptions = {}): ParsedDataset {
  interface Clue {
    text: string[];
    response: string;
    accept: string[];
    notes: string;
    wager: boolean;
  }
  interface Category {
    title: string;
    note: string;
    clues: Clue[];
  }
  interface Round {
    kind: 'board' | 'final' | 'tiebreak';
    values: number[] | null;
    wagers: number | null;
    form: 'strict' | 'lenient' | null;
    categories: Category[];
  }
  let title = '';
  let credit = '';
  const rounds: Round[] = [];
  let round: Round | null = null;
  let category: Category | null = null;
  let clue: Clue | null = null;
  const fail = (line: number, message: string): never => {
    throw new InvalidGame(`line ${String(line)}: ${message}`);
  };

  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const number = index + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) return;
    const setting = /^([a-z]+)\s*:\s*(.*)$/i.exec(line);
    const name = setting?.[1]?.toLowerCase();
    const value = setting?.[2]?.trim() ?? '';
    if (line.startsWith('##')) {
      if (!round) fail(number, 'a category (##) must come after a round heading (#)');
      if (clue && !clue.response) fail(number, 'the clue above has no "=" response line');
      category = { title: line.replace(/^#+/, '').trim(), note: '', clues: [] };
      round?.categories.push(category);
      clue = null;
      return;
    }
    if (line.startsWith('#')) {
      if (clue && !clue.response) fail(number, 'the clue above has no "=" response line');
      const heading = line.replace(/^#+/, '').trim().toLowerCase();
      const kind = heading.startsWith('final')
        ? 'final'
        : heading.startsWith('tie')
          ? 'tiebreak'
          : 'board';
      round = { kind, values: null, wagers: null, form: null, categories: [] };
      rounds.push(round);
      category = null;
      clue = null;
      return;
    }
    if (!round && (name === 'title' || name === 'credit')) {
      if (name === 'title') title = value;
      else credit = value;
      return;
    }
    if (round && !category && name === 'values') {
      const values = value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((v) => money(v));
      if (values.length === 0 || values.some((v) => v === null))
        fail(number, 'values are whole numbers, like "values: 200 400 600 800 1000"');
      round.values = values as number[];
      return;
    }
    if (round && !category && name === 'wagers') {
      const wagers = Number(value);
      if (!Number.isInteger(wagers) || wagers < 0) fail(number, 'wagers is a whole number');
      round.wagers = wagers;
      return;
    }
    if (round && !category && name === 'form') {
      if (value !== 'strict' && value !== 'lenient') fail(number, 'form is strict or lenient');
      round.form = value as 'strict' | 'lenient';
      return;
    }
    if (category && name === 'note') {
      if (clue?.response) clue.notes = value;
      else if (!clue) category.note = value;
      else fail(number, 'a note goes after the clue’s "=" response line');
      return;
    }
    if (!category) fail(number, 'a clue must come under a category heading (##)');
    if (line.startsWith('=')) {
      if (!clue || clue.response) fail(number, 'a "=" response line must follow a clue');
      const [response = '', ...accept] = line
        .slice(1)
        .split('|')
        .map((part) => part.trim());
      if (clue) {
        clue.response = response;
        clue.accept = accept.filter(Boolean);
      }
      return;
    }
    if (clue && !clue.response) {
      clue.text.push(line);
      return;
    }
    const wager = /^\[wager\]\s*/i.test(line);
    clue = {
      text: [line.replace(/^\[wager\]\s*/i, '')],
      response: '',
      accept: [],
      notes: '',
      wager,
    };
    category?.clues.push(clue);
  });
  if (clue && !(clue as Clue).response && !options.draft)
    throw new InvalidGame('the last clue has no "=" response line');

  const toClue = (c: Clue | undefined, wager = false): Record<string, unknown> | null =>
    c
      ? {
          text: c.text.join(' '),
          response: c.response,
          accept: c.accept,
          notes: c.notes,
          ...(wager ? { wager: c.wager } : {}),
        }
      : null;
  const boards = rounds.filter((r) => r.kind === 'board');
  const final = rounds.find((r) => r.kind === 'final');
  const out: Record<string, unknown>[] = boards.map((r, index) => {
    const step = 200 * (index + 1);
    const values = r.values ?? [1, 2, 3, 4, 5].map((n) => n * step);
    for (const c of r.categories) {
      if (c.clues.length > values.length)
        throw new InvalidGame(
          `${c.title || 'a category'} has ${String(c.clues.length)} clues for ${String(values.length)} values`,
        );
    }
    return {
      kind: 'board',
      values,
      wagers: r.wagers ?? (index === 0 ? 1 : 2),
      questionForm: r.form ?? 'lenient',
      categories: r.categories.map((c) => ({
        title: c.title,
        note: c.note,
        clues: values.map((_, row) => toClue(c.clues[row], true)),
      })),
    };
  });
  if (final) {
    const c = final.categories[0];
    out.push({
      kind: 'final',
      category: c?.title ?? '',
      note: c?.note ?? '',
      clue: toClue(c?.clues[0]),
    });
  }
  const game = {
    title: title || 'Untitled game',
    credit,
    rounds: out,
    tiebreakers: rounds
      .filter((r) => r.kind === 'tiebreak')
      .flatMap((r) => r.categories)
      .map((c) => ({ category: c.title, clue: toClue(c.clues[0]) })),
  };
  return { games: [parseGame(game, options)], skipped: [], source: null };
}
