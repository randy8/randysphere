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
  `
  -- One row per device that asked for notifications. Tied to the sign-in
  -- it was made under: signing out, a revoke or a new password deletes the
  -- session, and the cascade stops that device's notifications with it.
  CREATE TABLE push_subscriptions (
    endpoint        TEXT PRIMARY KEY,
    session_hash    TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh          TEXT NOT NULL,
    auth            TEXT NOT NULL,
    preview         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_success_at INTEGER,
    failures        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  -- Which database this is. A restore gives it a new epoch, so a browser
  -- that saw revs from the replaced database starts over instead of
  -- waiting for revs that will never come (or skipping ones that will).
  INSERT INTO meta (key, value) VALUES ('epoch', abs(random()) % 9007199254740991);

  CREATE INDEX images_created ON images(created_at);
  `,
  `
  -- Rooms: separate conversations among the same members. Another room is
  -- one INSERT (or pnpm family add-room); nothing else is per room but
  -- messages and read positions.
  CREATE TABLE rooms (
    id         INTEGER PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  INSERT INTO rooms (id, slug, name, position, created_at) VALUES
    (1, 'family', 'Family', 0, unixepoch() * 1000),
    (2, 'disc', 'Disc', 1, unixepoch() * 1000);

  -- Every message already sent belongs to Family (room 1), and a server
  -- still running the previous code during a deploy keeps writing there.
  -- No REFERENCES: SQLite won't add a foreign-key column with a non-null
  -- default, so the trigger below is the foreign key.
  ALTER TABLE messages ADD COLUMN room_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX messages_room ON messages(room_id, id);
  CREATE TRIGGER messages_room_exists BEFORE INSERT ON messages
    WHEN NOT EXISTS (SELECT 1 FROM rooms WHERE id = NEW.room_id)
    BEGIN SELECT RAISE(ABORT, 'no such room'); END;

  -- How far each person has read, per room. Supersedes users.last_read_rev,
  -- which stays (unread by this code) so the previous server still works
  -- against this schema for the seconds a deploy overlaps them.
  CREATE TABLE room_reads (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    last_read_rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, room_id)
  );
  INSERT INTO room_reads (user_id, room_id, last_read_rev)
    SELECT id, 1, last_read_rev FROM users;
  `,
  `
  -- Rooms undone: Disc became a chat of its own at /disc/, with its own
  -- database and accounts (docs/decisions.md, 2026-10-29), so this one is
  -- a single conversation again. Refuses (the CHECK fails, the migration
  -- rolls back) if any message was ever sent outside Family, rather than
  -- dropping it.
  CREATE TEMP TABLE outside_family (n INTEGER CHECK (n = 0));
  INSERT INTO outside_family SELECT count(*) FROM messages WHERE room_id <> 1;
  DROP TABLE outside_family;

  UPDATE users SET last_read_rev = max(last_read_rev, coalesce(
    (SELECT last_read_rev FROM room_reads WHERE user_id = users.id AND room_id = 1), 0));
  DROP TABLE room_reads;
  DROP TRIGGER messages_room_exists;
  DROP INDEX messages_room;
  ALTER TABLE messages DROP COLUMN room_id;
  DROP TABLE rooms;
  `,
  `
  -- Set on an account made with a starter password (pnpm <chat> add
  -- --suggest-change): after signing in, they're offered the chance to
  -- choose their own, once, and may decline.
  ALTER TABLE users ADD COLUMN suggest_new_password INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- When each person read each message (read receipts: Info on a message).
  -- Written as their read position passes it; messages read before this
  -- existed have no row and show as read, without a time. Rows go with the
  -- message or the account.
  CREATE TABLE message_reads (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at    INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  ) WITHOUT ROWID;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings `db` up to `target` (every migration, unless a test wants an older schema to upgrade). */
export function migrate(db: DatabaseSync, target: number = MIGRATIONS.length): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `chat.db is at schema ${String(current)}, newer than this code (${String(MIGRATIONS.length)}).`,
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
