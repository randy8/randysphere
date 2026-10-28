import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The family chat's database: one SQLite file (Node's built-in driver, no
 * dependency), opened by the server, by `pnpm family`, and by a deploy's
 * candidate server at the same time — WAL lets them share it, and
 * busy_timeout makes a writer wait for another rather than fail.
 *
 * `synchronous = FULL` is the durability promise: a message's INSERT has
 * reached the disk before the sender is told it was delivered. At this
 * volume (a family, not a feed) the extra fsync costs nothing noticeable.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Each entry runs once, in order, inside a transaction, and `user_version`
 * records how many have run. Append only: an applied migration is never
 * edited, because a database somewhere has already run it.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    lang          TEXT NOT NULL DEFAULT 'en',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    disabled_at   INTEGER,
    last_seen_at  INTEGER,
    last_read_rev INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    user_agent   TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE images (
    id         TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    width      INTEGER NOT NULL,
    height     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- rev: one counter across inserts and deletions, so "everything after
  -- rev N" is exactly what a reconnecting client missed, tombstones included.
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    client_id  TEXT NOT NULL,
    body       TEXT NOT NULL,
    image_id   TEXT REFERENCES images(id),
    reply_to   INTEGER REFERENCES messages(id),
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    rev        INTEGER NOT NULL UNIQUE,
    UNIQUE (user_id, client_id)
  );

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO meta (key, value) VALUES ('rev', 0);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `chat.db is at schema ${String(current)}, newer than this code (${String(MIGRATIONS.length)}).`,
    );
  }
  for (let index = current; index < MIGRATIONS.length; index += 1) {
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
