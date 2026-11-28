/**
 * The game file format (`quiz-game/1`) — what the editor saves, what
 * `pnpm quiz import` reads, what `pnpm quiz export` writes — and its
 * validation. Everything that reaches the database or a game from outside
 * passes through `parseGame`: bounded lengths, whole-number values, known
 * media hosts, control characters removed. Text is stored as text and
 * always rendered as text (textContent, never innerHTML), so nothing here
 * escapes HTML: it cannot be interpreted in the first place.
 */

import type {
  BoardRoundData,
  ClueData,
  GameData,
  Media,
  RoundData,
  TiebreakerData,
} from './engine/types.ts';

export const FORMAT = 'quiz-game/1';

export const LIMITS = {
  title: 120,
  credit: 300,
  category: 100,
  note: 300,
  text: 1000,
  response: 300,
  accept: 12,
  notes: 1000,
  categories: 8,
  rows: 10,
  rounds: 6,
  tiebreakers: 5,
  value: 1_000_000,
} as const;

export interface EpisodeMeta {
  readonly showNumber: number | null;
  readonly season: number | null;
  readonly airDate: string | null;
  readonly externalId: string | null;
}

export interface GameFile {
  readonly game: GameData;
  readonly meta: EpisodeMeta;
}

export class InvalidGame extends Error {}

/**
 * Set for the length of one `parseGame(…, { draft: true })` call: the
 * editor saves drafts, where a clue may have text but no response yet and
 * a category may be untitled. `playable` is what stands between a draft
 * and a game.
 */
let drafting = false;

function text(value: unknown, max: number, where: string, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new InvalidGame(`${where} is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new InvalidGame(`${where} must be text`);
  const out = String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => (char === '\n' ? '\n' : ''))
    .trim();
  if (out.length > max) throw new InvalidGame(`${where} is longer than ${String(max)} characters`);
  if (required && !out) throw new InvalidGame(`${where} is required`);
  return out;
}

function int(value: unknown, where: string, min: number, max: number): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) {
    throw new InvalidGame(`${where} must be a whole number from ${String(min)} to ${String(max)}`);
  }
  return number;
}

const isBlank = (clue: unknown): boolean =>
  isObject(clue) &&
  !(typeof clue['text'] === 'string' && clue['text'].trim()) &&
  !(typeof clue['response'] === 'string' && clue['response'].trim());

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** https anywhere, or a file in the quiz's own media directory. Nothing else is ever loaded. */
export function safeMediaUrl(url: string): boolean {
  if (/^\/(?:trivia|quiz)\/media\/[A-Za-z0-9._-]+$/.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && url.length <= 500;
  } catch {
    return false;
  }
}

function media(value: unknown, where: string): Media | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isObject(value)) throw new InvalidGame(`${where}.media must be an object`);
  const kind = value['kind'];
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
    throw new InvalidGame(`${where}.media.kind must be image, audio or video`);
  }
  const url = text(value['url'], 500, `${where}.media.url`, true);
  if (!safeMediaUrl(url))
    throw new InvalidGame(`${where}.media.url must be https:// or /trivia/media/<file>`);
  return { kind, url };
}

export function parseClue(value: unknown, where: string, id: string): ClueData {
  if (!isObject(value)) throw new InvalidGame(`${where} must be an object`);
  const accept = value['accept'] ?? [];
  if (!Array.isArray(accept) || accept.length > LIMITS.accept) {
    throw new InvalidGame(`${where}.accept must be a list of at most ${String(LIMITS.accept)}`);
  }
  const order = value['order'];
  return {
    id: typeof value['id'] === 'string' && /^[\w-]{1,40}$/.test(value['id']) ? value['id'] : id,
    text: text(value['text'], LIMITS.text, `${where}.text`, !drafting),
    response: text(value['response'], LIMITS.response, `${where}.response`, !drafting),
    accept: accept
      .map((entry, index) => text(entry, LIMITS.response, `${where}.accept[${String(index)}]`))
      .filter(Boolean),
    notes: text(value['notes'], LIMITS.notes, `${where}.notes`),
    media: media(value['media'], where),
    wager: value['wager'] === true,
    order: order === undefined || order === null ? null : int(order, `${where}.order`, 1, 100),
  };
}

function parseBoard(value: Record<string, unknown>, where: string, index: number): BoardRoundData {
  const values = value['values'];
  if (!Array.isArray(values) || values.length === 0 || values.length > LIMITS.rows) {
    throw new InvalidGame(`${where}.values must list 1 to ${String(LIMITS.rows)} values`);
  }
  const rowValues = values.map((entry, row) =>
    int(entry, `${where}.values[${String(row)}]`, 1, LIMITS.value),
  );
  const categories = value['categories'];
  if (
    !Array.isArray(categories) ||
    categories.length === 0 ||
    categories.length > LIMITS.categories
  ) {
    throw new InvalidGame(
      `${where}.categories must list 1 to ${String(LIMITS.categories)} categories`,
    );
  }
  const questionForm = value['questionForm'] ?? (index === 0 ? 'lenient' : 'strict');
  if (questionForm !== 'lenient' && questionForm !== 'strict') {
    throw new InvalidGame(`${where}.questionForm must be lenient or strict`);
  }
  return {
    kind: 'board',
    values: rowValues,
    wagers:
      value['wagers'] === undefined
        ? index === 0
          ? 1
          : 2
        : int(value['wagers'], `${where}.wagers`, 0, 4),
    questionForm,
    categories: categories.map((category: unknown, col) => {
      const at = `${where}.categories[${String(col)}]`;
      if (!isObject(category)) throw new InvalidGame(`${at} must be an object`);
      const clues = category['clues'];
      if (!Array.isArray(clues) || clues.length !== rowValues.length) {
        throw new InvalidGame(
          `${at}.clues must have one entry per value (${String(rowValues.length)}); use null for an empty cell`,
        );
      }
      return {
        title: text(category['title'], LIMITS.category, `${at}.title`, !drafting),
        note: text(category['note'], LIMITS.note, `${at}.note`),
        clues: clues.map((clue: unknown, row) =>
          clue === null || (drafting && isBlank(clue))
            ? null
            : parseClue(
                clue,
                `${at}.clues[${String(row)}]`,
                `r${String(index)}c${String(col)}r${String(row)}`,
              ),
        ),
      };
    }),
  };
}

export function parseGame(input: unknown, options: { draft?: boolean } = {}): GameFile {
  drafting = options.draft === true;
  try {
    return parseGameNow(input);
  } finally {
    drafting = false;
  }
}

function parseGameNow(input: unknown): GameFile {
  if (!isObject(input)) throw new InvalidGame('a game must be a JSON object');
  if (input['format'] !== undefined && input['format'] !== FORMAT) {
    throw new InvalidGame(`unknown format ${JSON.stringify(input['format'])} (expected ${FORMAT})`);
  }
  const rounds = input['rounds'];
  if (!Array.isArray(rounds) || rounds.length === 0 || rounds.length > LIMITS.rounds) {
    throw new InvalidGame(`rounds must list 1 to ${String(LIMITS.rounds)} rounds`);
  }
  let boards = 0;
  const parsedRounds: RoundData[] = rounds.map((round: unknown, index) => {
    const where = `rounds[${String(index)}]`;
    if (!isObject(round)) throw new InvalidGame(`${where} must be an object`);
    if (round['kind'] === 'final') {
      if (index !== rounds.length - 1) throw new InvalidGame('the final round must come last');
      return {
        kind: 'final',
        category: text(round['category'], LIMITS.category, `${where}.category`, !drafting),
        note: text(round['note'], LIMITS.note, `${where}.note`),
        clue: parseClue(round['clue'], `${where}.clue`, 'final'),
      };
    }
    if (round['kind'] !== 'board') throw new InvalidGame(`${where}.kind must be board or final`);
    boards += 1;
    return parseBoard(round, where, index);
  });
  if (boards === 0) throw new InvalidGame('a game needs at least one board round');
  const tiebreakers = input['tiebreakers'] ?? [];
  if (!Array.isArray(tiebreakers) || tiebreakers.length > LIMITS.tiebreakers) {
    throw new InvalidGame(`tiebreakers must list at most ${String(LIMITS.tiebreakers)}`);
  }
  const meta = isObject(input['episode']) ? input['episode'] : {};
  const airDate = text(meta['airDate'], 10, 'episode.airDate');
  if (airDate && !/^\d{4}-\d{2}-\d{2}$/.test(airDate))
    throw new InvalidGame('episode.airDate must be YYYY-MM-DD');
  return {
    game: {
      title: text(input['title'], LIMITS.title, 'title', true),
      credit: text(input['credit'], LIMITS.credit, 'credit'),
      rounds: parsedRounds,
      tiebreakers: tiebreakers.map((entry: unknown, index): TiebreakerData => {
        const where = `tiebreakers[${String(index)}]`;
        if (!isObject(entry)) throw new InvalidGame(`${where} must be an object`);
        return {
          category: text(entry['category'], LIMITS.category, `${where}.category`, !drafting),
          clue: parseClue(entry['clue'], `${where}.clue`, `tb${String(index)}`),
        };
      }),
    },
    meta: {
      showNumber:
        meta['showNumber'] == null
          ? null
          : int(meta['showNumber'], 'episode.showNumber', 0, 1_000_000),
      season: meta['season'] == null ? null : int(meta['season'], 'episode.season', 0, 1000),
      airDate: airDate || null,
      externalId: meta['id'] == null ? null : text(meta['id'], 100, 'episode.id'),
    },
  };
}

/** The file form of a game, for export and the editor. */
export function toFile(game: GameData, meta?: EpisodeMeta): Record<string, unknown> {
  return {
    format: FORMAT,
    title: game.title,
    credit: game.credit,
    ...(meta && (meta.showNumber !== null || meta.airDate !== null || meta.season !== null)
      ? {
          episode: {
            showNumber: meta.showNumber,
            season: meta.season,
            airDate: meta.airDate,
            id: meta.externalId,
          },
        }
      : {}),
    rounds: game.rounds,
    tiebreakers: game.tiebreakers,
  };
}

/**
 * Whether a (possibly draft) game can be hosted: every board round has a
 * clue, every clue present has both text and a response, every category
 * a title. Null when it can; otherwise the first problem, in words.
 */
export function playable(game: GameData): string | null {
  const incomplete = (clue: ClueData): boolean => !clue.text || !clue.response;
  for (const [index, round] of game.rounds.entries()) {
    const name = `Round ${String(index + 1)}`;
    if (round.kind === 'final') {
      if (!round.category || incomplete(round.clue))
        return `${name} (final) needs a category, clue and response`;
      continue;
    }
    if (!round.categories.some((category) => category.clues.some((clue) => clue !== null))) {
      return `${name} has no clues`;
    }
    for (const [col, category] of round.categories.entries()) {
      if (!category.title) return `${name}, category ${String(col + 1)} needs a title`;
      for (const [row, clue] of category.clues.entries()) {
        if (clue && incomplete(clue)) {
          return `${name}, ${category.title} for ${String(round.values[row])} needs both a clue and a response`;
        }
      }
    }
  }
  for (const [index, tiebreaker] of game.tiebreakers.entries()) {
    if (!tiebreaker.category || incomplete(tiebreaker.clue))
      return `Tiebreaker ${String(index + 1)} is incomplete`;
  }
  return null;
}
