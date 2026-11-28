import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The quiz's database, private/quiz/quiz.db: the clue catalog (imported
 * episodes and boards written in the editor, one model for both), live
 * rooms' snapshots and event logs, and finished games' results. Node's
 * built-in driver, the same conventions as family/db.ts: WAL so the
 * server, `pnpm quiz` and a deploy's candidate can share it; numbered,
 * append-only migrations recorded in user_version.
 *
 * `synchronous = NORMAL`, not the chat's FULL: nothing here is a message
 * someone was told was delivered. A snapshot lost to a power cut costs the
 * last second of a game, and is written after every event is arbitrated
 * and broadcast — never inside the buzzer path (room.ts).
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

const MIGRATIONS: readonly string[] = [
  `
  -- Where a dataset came from and on what terms. Every imported episode
  -- names one; boards written in the editor have none.
  CREATE TABLE sources (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    license     TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    imported_at INTEGER NOT NULL
  );

  -- A complete game: an imported historical episode, or a board written in
  -- the editor (kind 'custom', owned by whoever holds its edit key).
  CREATE TABLE episodes (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('imported', 'custom')),
    source_id     INTEGER REFERENCES sources(id),
    external_id   TEXT,
    title         TEXT NOT NULL,
    credit        TEXT NOT NULL DEFAULT '',
    show_number   INTEGER,
    season        INTEGER,
    air_date      TEXT,
    -- Offered in the host's library and drawn on for random boards and
    -- practice. Custom boards start unlisted: private to their key.
    listed        INTEGER NOT NULL DEFAULT 0,
    edit_key_hash TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    UNIQUE (source_id, external_id)
  );

  CREATE TABLE rounds (
    id            INTEGER PRIMARY KEY,
    episode_id    INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('board', 'final', 'tiebreak')),
    -- Board rounds: the value of each row, top to bottom (historical
    -- configurations differ), how many wager clues to place when none is
    -- flagged, and the question-form rule.
    values_json   TEXT NOT NULL DEFAULT '[]',
    wagers        INTEGER NOT NULL DEFAULT 0,
    question_form TEXT NOT NULL DEFAULT 'strict',
    UNIQUE (episode_id, ordinal)
  );

  CREATE TABLE categories (
    id       INTEGER PRIMARY KEY,
    round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    title    TEXT NOT NULL,
    note     TEXT NOT NULL DEFAULT '',
    UNIQUE (round_id, position)
  );

  -- One per board coordinate (category position × row). A historical
  -- board's unrevealed clue is simply absent.
  CREATE TABLE clues (
    id              INTEGER PRIMARY KEY,
    category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    row             INTEGER NOT NULL,
    value           INTEGER,
    text            TEXT NOT NULL,
    response        TEXT NOT NULL,
    notes           TEXT NOT NULL DEFAULT '',
    media_json      TEXT,
    is_wager        INTEGER NOT NULL DEFAULT 0,
    selection_order INTEGER,
    UNIQUE (category_id, row)
  );

  CREATE TABLE alternates (
    clue_id INTEGER NOT NULL REFERENCES clues(id) ON DELETE CASCADE,
    n       INTEGER NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (clue_id, n)
  ) WITHOUT ROWID;

  -- Live rooms. init_json is what the game was created from (data,
  -- settings, seed); events replay onto it to reproduce snapshot. owner and
  -- lease_until make one process the room's only authority.
  CREATE TABLE rooms (
    code        TEXT PRIMARY KEY,
    mode        TEXT NOT NULL,
    episode_id  INTEGER,
    theme       TEXT NOT NULL DEFAULT 'classic',
    init_json   TEXT NOT NULL,
    snapshot    TEXT NOT NULL,
    saved_at    REAL NOT NULL,
    events      INTEGER NOT NULL DEFAULT 0,
    owner       TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    active_at   INTEGER NOT NULL,
    game_id     INTEGER
  );

  -- Only hashes: a database copy grants nobody a seat.
  CREATE TABLE tokens (
    hash       TEXT PRIMARY KEY,
    room       TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('host', 'cohost', 'player', 'spectator', 'device')),
    player_id  TEXT,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX tokens_room ON tokens(room);

  CREATE TABLE events (
    room      TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
    n         INTEGER NOT NULL,
    at        INTEGER NOT NULL,
    mono      REAL NOT NULL,
    role      TEXT NOT NULL,
    player_id TEXT,
    action    TEXT NOT NULL,
    PRIMARY KEY (room, n)
  ) WITHOUT ROWID;

  -- Finished games, kept after their room expires.
  CREATE TABLE games (
    id         INTEGER PRIMARY KEY,
    room       TEXT NOT NULL,
    mode       TEXT NOT NULL,
    episode_id INTEGER,
    title      TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER NOT NULL,
    winners    TEXT NOT NULL
  );

  CREATE TABLE game_players (
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seat          INTEGER NOT NULL,
    name          TEXT NOT NULL,
    score         INTEGER NOT NULL,
    coryat        INTEGER NOT NULL,
    correct       INTEGER NOT NULL,
    incorrect     INTEGER NOT NULL,
    buzzes        INTEGER NOT NULL,
    wins          INTEGER NOT NULL,
    premature     INTEGER NOT NULL,
    wager_clues   INTEGER NOT NULL,
    wager_correct INTEGER NOT NULL,
    wager_net     INTEGER NOT NULL,
    final_wager   INTEGER,
    final_correct INTEGER,
    -- Server-measured: buzzers open → winning press arrives. Includes the
    -- network; not a human reaction time.
    buzz_ms_median INTEGER,
    PRIMARY KEY (game_id, seat)
  ) WITHOUT ROWID;

  CREATE TABLE game_rulings (
    game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    n        INTEGER NOT NULL,
    round    INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    category TEXT NOT NULL,
    value    INTEGER NOT NULL,
    amount   INTEGER NOT NULL,
    seat     INTEGER NOT NULL,
    verdict  TEXT NOT NULL,
    PRIMARY KEY (game_id, n)
  ) WITHOUT ROWID;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync, target: number = MIGRATIONS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `quiz.db is at schema ${String(current)}, newer than this code (${String(MIGRATIONS.length)}).`,
    );
  }
  for (let index = current; index < target; index += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[index] ?? '');
      db.exec(`PRAGMA user_version = ${String(index + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
