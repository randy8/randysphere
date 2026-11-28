/**
 * The clue catalog: games in, games out. Imported historical episodes,
 * boards written in the editor, random boards and practice clues all use
 * one model (db.ts) — an episode of rounds of categories of clues at board
 * coordinates.
 *
 * Random boards keep categories whole. A category's clues were written to
 * be read together, top to bottom (the wordplay in its title, the climb in
 * difficulty), so a random board is six complete categories drawn from
 * different episodes, never six clues drawn from anywhere.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type {
  BoardRoundData,
  ClueData,
  GameData,
  Media,
  RoundData,
  TiebreakerData,
} from './engine/types.ts';
import type { EpisodeMeta, GameFile } from './validate.ts';

export const STANDARD_VALUES: readonly (readonly number[])[] = [
  [200, 400, 600, 800, 1000],
  [400, 800, 1200, 1600, 2000],
];

export interface EpisodeSummary {
  id: number;
  kind: 'imported' | 'custom';
  title: string;
  credit: string;
  showNumber: number | null;
  season: number | null;
  airDate: string | null;
  source: string | null;
  license: string | null;
  listed: boolean;
}

export interface SourceInfo {
  readonly name: string;
  readonly license: string;
  readonly url?: string;
  readonly notes?: string;
}

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export function ensureSource(db: DatabaseSync, source: SourceInfo): number {
  db.prepare(
    `INSERT INTO sources (name, license, url, notes, imported_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET license = excluded.license, url = excluded.url, notes = excluded.notes`,
  ).run(source.name, source.license, source.url ?? '', source.notes ?? '', Date.now());
  const row = db.prepare('SELECT id FROM sources WHERE name = ?').get(source.name) as {
    id: number;
  };
  return row.id;
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = work();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function writeRounds(db: DatabaseSync, episodeId: number, game: GameData): void {
  db.prepare('DELETE FROM rounds WHERE episode_id = ?').run(episodeId);
  const insertRound = db.prepare(
    'INSERT INTO rounds (episode_id, ordinal, kind, values_json, wagers, question_form) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertCategory = db.prepare(
    'INSERT INTO categories (round_id, position, title, note) VALUES (?, ?, ?, ?)',
  );
  const insertClue = db.prepare(
    `INSERT INTO clues (category_id, row, value, text, response, notes, media_json, is_wager, selection_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAlternate = db.prepare('INSERT INTO alternates (clue_id, n, text) VALUES (?, ?, ?)');
  const addClue = (
    categoryId: number | bigint,
    row: number,
    value: number | null,
    clue: ClueData,
  ): void => {
    const result = insertClue.run(
      categoryId,
      row,
      value,
      clue.text,
      clue.response,
      clue.notes,
      clue.media ? JSON.stringify(clue.media) : null,
      clue.wager ? 1 : 0,
      clue.order,
    );
    clue.accept.forEach((text, n) => insertAlternate.run(result.lastInsertRowid, n, text));
  };
  const rounds: (RoundData | { kind: 'tiebreak'; tiebreaker: TiebreakerData })[] = [
    ...game.rounds,
    ...game.tiebreakers.map((tiebreaker) => ({ kind: 'tiebreak' as const, tiebreaker })),
  ];
  rounds.forEach((round, ordinal) => {
    if (round.kind === 'board') {
      const roundId = insertRound.run(
        episodeId,
        ordinal,
        'board',
        JSON.stringify(round.values),
        round.wagers,
        round.questionForm,
      ).lastInsertRowid;
      round.categories.forEach((category, position) => {
        const categoryId = insertCategory.run(
          roundId,
          position,
          category.title,
          category.note,
        ).lastInsertRowid;
        category.clues.forEach((clue, row) => {
          if (clue) addClue(categoryId, row, round.values[row] ?? null, clue);
        });
      });
      return;
    }
    const roundId = insertRound.run(
      episodeId,
      ordinal,
      round.kind,
      '[]',
      0,
      'strict',
    ).lastInsertRowid;
    const title = round.kind === 'final' ? round.category : round.tiebreaker.category;
    const note = round.kind === 'final' ? round.note : '';
    const categoryId = insertCategory.run(roundId, 0, title, note).lastInsertRowid;
    addClue(categoryId, 0, null, round.kind === 'final' ? round.clue : round.tiebreaker.clue);
  });
}

/**
 * An imported episode: replaces the one with the same source and external
 * id (a re-import updates rather than duplicates), else adds one.
 */
export function importEpisode(
  db: DatabaseSync,
  file: GameFile,
  sourceId: number,
  options: { listed: boolean },
): { id: number; replaced: boolean } {
  return transaction(db, () => {
    const now = Date.now();
    const existing =
      file.meta.externalId === null
        ? undefined
        : (db
            .prepare('SELECT id FROM episodes WHERE source_id = ? AND external_id = ?')
            .get(sourceId, file.meta.externalId) as { id: number } | undefined);
    let id: number;
    if (existing) {
      id = existing.id;
      db.prepare(
        `UPDATE episodes SET title = ?, credit = ?, show_number = ?, season = ?, air_date = ?, listed = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        file.game.title,
        file.game.credit,
        file.meta.showNumber,
        file.meta.season,
        file.meta.airDate,
        options.listed ? 1 : 0,
        now,
        id,
      );
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO episodes (kind, source_id, external_id, title, credit, show_number, season, air_date, listed, created_at, updated_at)
             VALUES ('imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId,
            file.meta.externalId,
            file.game.title,
            file.game.credit,
            file.meta.showNumber,
            file.meta.season,
            file.meta.airDate,
            options.listed ? 1 : 0,
            now,
            now,
          ).lastInsertRowid,
      );
    }
    writeRounds(db, id, file.game);
    return { id, replaced: existing !== undefined };
  });
}

/** A new board in the editor. Returns its id; the key is the caller's, only its hash is kept. */
export function createCustom(db: DatabaseSync, game: GameData, key: string): number {
  return transaction(db, () => {
    const now = Date.now();
    const id = Number(
      db
        .prepare(
          `INSERT INTO episodes (kind, title, credit, listed, edit_key_hash, created_at, updated_at)
           VALUES ('custom', ?, ?, 0, ?, ?, ?)`,
        )
        .run(game.title, game.credit, hashKey(key), now, now).lastInsertRowid,
    );
    writeRounds(db, id, game);
    return id;
  });
}

export function keyMatches(db: DatabaseSync, id: number, key: string): boolean {
  const row = db
    .prepare("SELECT edit_key_hash FROM episodes WHERE id = ? AND kind = 'custom'")
    .get(id) as { edit_key_hash: string | null } | undefined;
  if (!row?.edit_key_hash) return false;
  const expected = Buffer.from(row.edit_key_hash, 'hex');
  const given = Buffer.from(hashKey(key), 'hex');
  return expected.length === given.length && expected.equals(given);
}

export function updateCustom(db: DatabaseSync, id: number, game: GameData): void {
  transaction(db, () => {
    db.prepare('UPDATE episodes SET title = ?, credit = ?, updated_at = ? WHERE id = ?').run(
      game.title,
      game.credit,
      Date.now(),
      id,
    );
    writeRounds(db, id, game);
  });
}

export function deleteEpisode(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare('DELETE FROM episodes WHERE id = ?').run(id).changes) > 0;
}

export function setListed(db: DatabaseSync, id: number, listed: boolean): boolean {
  return (
    Number(
      db.prepare('UPDATE episodes SET listed = ? WHERE id = ?').run(listed ? 1 : 0, id).changes,
    ) > 0
  );
}

interface ClueRow {
  id: number;
  row: number;
  text: string;
  response: string;
  notes: string;
  media_json: string | null;
  is_wager: number;
  selection_order: number | null;
}

function readClue(db: DatabaseSync, row: ClueRow): ClueData {
  const accept = (
    db.prepare('SELECT text FROM alternates WHERE clue_id = ? ORDER BY n').all(row.id) as {
      text: string;
    }[]
  ).map((alternate) => alternate.text);
  return {
    id: `c${String(row.id)}`,
    text: row.text,
    response: row.response,
    accept,
    notes: row.notes,
    media: row.media_json ? (JSON.parse(row.media_json) as Media) : null,
    wager: row.is_wager === 1,
    order: row.selection_order,
  };
}

function readCategory(db: DatabaseSync, categoryId: number, rows: number): (ClueData | null)[] {
  const clues: (ClueData | null)[] = Array.from({ length: rows }, () => null);
  for (const row of db
    .prepare('SELECT * FROM clues WHERE category_id = ? ORDER BY row')
    .all(categoryId) as unknown as ClueRow[]) {
    if (row.row < rows) clues[row.row] = readClue(db, row);
  }
  return clues;
}

export function loadEpisode(
  db: DatabaseSync,
  id: number,
): { game: GameData; meta: EpisodeMeta; summary: EpisodeSummary } | null {
  const summary = listEpisodes(db, { id }).at(0);
  if (!summary) return null;
  const episode = db.prepare('SELECT external_id FROM episodes WHERE id = ?').get(id) as {
    external_id: string | null;
  };
  const rounds: RoundData[] = [];
  const tiebreakers: TiebreakerData[] = [];
  for (const round of db
    .prepare('SELECT * FROM rounds WHERE episode_id = ? ORDER BY ordinal')
    .all(id) as {
    id: number;
    kind: string;
    values_json: string;
    wagers: number;
    question_form: string;
  }[]) {
    const categories = db
      .prepare('SELECT * FROM categories WHERE round_id = ? ORDER BY position')
      .all(round.id) as {
      id: number;
      title: string;
      note: string;
    }[];
    if (round.kind === 'board') {
      const values = JSON.parse(round.values_json) as number[];
      rounds.push({
        kind: 'board',
        values,
        wagers: round.wagers,
        questionForm: round.question_form === 'lenient' ? 'lenient' : 'strict',
        categories: categories.map((category) => ({
          title: category.title,
          note: category.note,
          clues: readCategory(db, category.id, values.length),
        })),
      });
      continue;
    }
    const category = categories[0];
    const clue = category ? readCategory(db, category.id, 1)[0] : null;
    if (!category || !clue) continue;
    if (round.kind === 'final')
      rounds.push({ kind: 'final', category: category.title, note: category.note, clue });
    else tiebreakers.push({ category: category.title, clue });
  }
  return {
    game: { title: summary.title, credit: summary.credit, rounds, tiebreakers },
    meta: {
      showNumber: summary.showNumber,
      season: summary.season,
      airDate: summary.airDate,
      externalId: episode.external_id,
    },
    summary,
  };
}

export function listEpisodes(
  db: DatabaseSync,
  filter: { id?: number; listed?: boolean; kind?: 'imported' | 'custom' } = {},
): EpisodeSummary[] {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.id !== undefined) {
    where.push('e.id = ?');
    params.push(filter.id);
  }
  if (filter.listed !== undefined) {
    where.push('e.listed = ?');
    params.push(filter.listed ? 1 : 0);
  }
  if (filter.kind !== undefined) {
    where.push('e.kind = ?');
    params.push(filter.kind);
  }
  const rows = db
    .prepare(
      `SELECT e.*, s.name AS source_name, s.license AS source_license FROM episodes e
       LEFT JOIN sources s ON s.id = e.source_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.air_date IS NULL, e.air_date DESC, e.id DESC`,
    )
    .all(...params) as {
    id: number;
    kind: 'imported' | 'custom';
    title: string;
    credit: string;
    show_number: number | null;
    season: number | null;
    air_date: string | null;
    listed: number;
    source_name: string | null;
    source_license: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    credit: row.credit,
    showNumber: row.show_number,
    season: row.season,
    airDate: row.air_date,
    source: row.source_name,
    license: row.source_license,
    listed: row.listed === 1,
  }));
}

/** A board round's ordinal (0 = first, 1 = second) for the categories random boards draw on. */
interface CategoryCandidate {
  id: number;
  episode_id: number;
  title: string;
  note: string;
  rows: number;
}

function completeCategories(
  db: DatabaseSync,
  ordinal: number,
  query: string | null,
): CategoryCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.id, r.episode_id, c.title, c.note, json_array_length(r.values_json) AS rows,
              (SELECT COUNT(*) FROM clues WHERE category_id = c.id) AS clue_count
       FROM categories c
       JOIN rounds r ON r.id = c.round_id
       JOIN episodes e ON e.id = r.episode_id
       WHERE e.listed = 1 AND r.kind = 'board' AND r.ordinal = ?
         ${query ? "AND c.title LIKE ? ESCAPE '\\'" : ''}`,
    )
    .all(
      ...(query ? [ordinal, `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`] : [ordinal]),
    ) as unknown as (CategoryCandidate & {
    clue_count: number;
  })[];
  return rows.filter((row) => row.clue_count === row.rows && row.rows === 5);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

/**
 * Six complete categories per board round, from as many different episodes
 * as the catalog allows, at the standard values (a category keeps its
 * order; only the dollar figures are normalised). `query` prefers
 * categories whose title contains it, topping up at random. A final and
 * tiebreakers from the episodes' own.
 */
export function randomGame(
  db: DatabaseSync,
  random: () => number,
  options: { query?: string | null; rounds?: number } = {},
): GameData | null {
  const query = options.query?.trim() || null;
  const boardRounds: BoardRoundData[] = [];
  for (let ordinal = 0; ordinal < (options.rounds ?? 2); ordinal += 1) {
    const preferred = query ? shuffle(completeCategories(db, ordinal, query), random) : [];
    const rest = shuffle(completeCategories(db, ordinal, null), random);
    const chosen: CategoryCandidate[] = [];
    const usedEpisodes = new Set<number>();
    const usedIds = new Set<number>();
    // First pass: distinct episodes; second: anything left.
    for (const pass of [true, false]) {
      for (const candidate of [...preferred, ...rest]) {
        if (chosen.length === 6) break;
        if (usedIds.has(candidate.id) || (pass && usedEpisodes.has(candidate.episode_id))) continue;
        chosen.push(candidate);
        usedIds.add(candidate.id);
        usedEpisodes.add(candidate.episode_id);
      }
    }
    if (chosen.length < 6) return null;
    const values = STANDARD_VALUES[ordinal] ?? STANDARD_VALUES[1] ?? [];
    boardRounds.push({
      kind: 'board',
      values: [...values],
      wagers: ordinal === 0 ? 1 : 2,
      questionForm: ordinal === 0 ? 'lenient' : 'strict',
      categories: chosen.map((category) => ({
        title: category.title,
        note: category.note,
        // Original wager flags don't carry over: a random board places its own.
        clues: readCategory(db, category.id, 5).map((clue) =>
          clue ? { ...clue, wager: false } : null,
        ),
      })),
    });
  }
  const singles = (kind: 'final' | 'tiebreak'): { title: string; note: string; clue: ClueData }[] =>
    (
      db
        .prepare(
          `SELECT c.id, c.title, c.note FROM categories c JOIN rounds r ON r.id = c.round_id
           JOIN episodes e ON e.id = r.episode_id WHERE e.listed = 1 AND r.kind = ?`,
        )
        .all(kind) as { id: number; title: string; note: string }[]
    ).flatMap((category) => {
      const clue = readCategory(db, category.id, 1)[0];
      return clue ? [{ title: category.title, note: category.note, clue }] : [];
    });
  const finals = shuffle(singles('final'), random);
  const final = finals[0];
  const tiebreakers = [...shuffle(singles('tiebreak'), random), ...finals.slice(1)].slice(0, 3);
  return {
    title: query ? `Random board: ${query}` : 'Random board',
    credit: 'Complete categories drawn at random from the library',
    rounds: [
      ...boardRounds,
      ...(final
        ? [{ kind: 'final' as const, category: final.title, note: final.note, clue: final.clue }]
        : []),
    ],
    tiebreakers: tiebreakers.map((entry) => ({ category: entry.title, clue: entry.clue })),
  };
}

export interface PracticeClue {
  id: number;
  category: string;
  note: string;
  value: number | null;
  text: string;
  media: Media | null;
  source: string;
}

/** A clue from a listed episode, for practice. `query` limits categories by title. */
export function practiceClue(
  db: DatabaseSync,
  random: () => number,
  query: string | null,
): PracticeClue | null {
  const like = query ? `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM clues cl JOIN categories c ON c.id = cl.category_id JOIN rounds r ON r.id = c.round_id
         JOIN episodes e ON e.id = r.episode_id WHERE e.listed = 1 ${like ? "AND c.title LIKE ? ESCAPE '\\'" : ''}`,
      )
      .get(...(like ? [like] : [])) as { n: number }
  ).n;
  if (count === 0) return null;
  const row = db
    .prepare(
      `SELECT cl.id, c.title, c.note, cl.value, cl.text, cl.media_json, e.title AS episode FROM clues cl
       JOIN categories c ON c.id = cl.category_id JOIN rounds r ON r.id = c.round_id
       JOIN episodes e ON e.id = r.episode_id WHERE e.listed = 1 ${like ? "AND c.title LIKE ? ESCAPE '\\'" : ''}
       LIMIT 1 OFFSET ?`,
    )
    .get(...(like ? [like] : []), Math.floor(random() * count)) as {
    id: number;
    title: string;
    note: string;
    value: number | null;
    text: string;
    media_json: string | null;
    episode: string;
  };
  return {
    id: row.id,
    category: row.title,
    note: row.note,
    value: row.value,
    text: row.text,
    media: row.media_json ? (JSON.parse(row.media_json) as Media) : null,
    source: row.episode,
  };
}

/** A practice clue's answer — only for clues in listed episodes. */
export function practiceAnswer(
  db: DatabaseSync,
  id: number,
): { response: string; accept: string[] } | null {
  const row = db
    .prepare(
      `SELECT cl.id, cl.response FROM clues cl JOIN categories c ON c.id = cl.category_id JOIN rounds r ON r.id = c.round_id
       JOIN episodes e ON e.id = r.episode_id WHERE cl.id = ? AND e.listed = 1`,
    )
    .get(id) as { id: number; response: string } | undefined;
  if (!row) return null;
  const accept = (
    db.prepare('SELECT text FROM alternates WHERE clue_id = ? ORDER BY n').all(id) as {
      text: string;
    }[]
  ).map((alternate) => alternate.text);
  return { response: row.response, accept };
}
