import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.ts';

export type Lang = 'en' | 'zh';

export interface User {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly lang: Lang;
  readonly isAdmin: boolean;
  readonly createdAt: number;
  readonly disabledAt: number | null;
  readonly lastSeenAt: number | null;
  readonly lastReadRev: number;
  /** Made with a starter password: offered the chance to choose their own (once, optional). */
  readonly suggestNewPassword: boolean;
}

export interface Message {
  readonly id: number;
  readonly userId: number;
  readonly clientId: string;
  readonly body: string;
  readonly image: { readonly id: string; readonly width: number; readonly height: number } | null;
  readonly replyTo: number | null;
  readonly createdAt: number;
  readonly deleted: boolean;
  /** Changes with every edit, unsend and Tapback: the stream's event id for it. */
  readonly rev: number;
  /** The rev it was sent at: what read positions and receipts are measured against. */
  readonly sentRev: number;
  readonly unsent: boolean;
  /** When it was last edited, or null. */
  readonly editedAt: number | null;
  /** Its earlier versions, oldest first: `body` as it read until `at`. */
  readonly edits: readonly { readonly body: string; readonly at: number }[];
  /** Reactions, oldest first: any emoji, several per person (as on Discord). */
  readonly reactions: readonly { readonly userId: number; readonly emoji: string }[];
  /** Genmoji and stickers set into the text: each GLYPH in `body` is the next one. */
  readonly glyphs: readonly {
    readonly id: string;
    readonly width: number;
    readonly height: number;
  }[];
}

/** Where a Genmoji or sticker sits in a message's text (U+FFFC, the object replacement character). */
export const GLYPH = '\uFFFC';
export const MAX_GLYPHS = 20;
/** Different emoji one person may put on one message, and on a message in all. */
export const MAX_REACTIONS_EACH = 20;
export const MAX_REACTIONS_TOTAL = 40;

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * One emoji, whatever it is: a pictograph with its skin tone, gender and
 * ZWJ sequences, a flag, or a keycap — one grapheme, and nothing else.
 */
export function isEmoji(text: string): boolean {
  if (text.length === 0 || text.length > 16) return false;
  if ([...GRAPHEMES.segment(text)].length !== 1) return false;
  return (
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u.test(text) &&
    /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}]+$/u.test(text)
  );
}

/** iMessage's limits: an edit within 15 minutes, at most 5 of them; Undo Send within 2. */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_EDITS = 5;
export const UNSEND_WINDOW_MS = 2 * 60 * 1000;

export interface SessionInfo {
  readonly userId: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly userAgent: string;
}

/** A year and a bit: the longest any browser keeps a cookie (Chrome caps at 400 days). */
export const SESSION_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How stale a session's last_used_at may be before a request refreshes it (and its expiry). */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const MAX_BODY_CHARS = 4000;
export const MAX_DISPLAY_NAME_CHARS = 40;
const USERNAME = /^[a-z0-9][a-z0-9._-]{1,31}$/i;

export class FamilyError extends Error {}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  lang: string;
  is_admin: number;
  created_at: number;
  disabled_at: number | null;
  last_seen_at: number | null;
  last_read_rev: number;
  suggest_new_password: number;
}

interface MessageRow {
  id: number;
  user_id: number;
  client_id: string;
  body: string;
  image_id: string | null;
  width: number | null;
  height: number | null;
  reply_to: number | null;
  created_at: number;
  deleted_at: number | null;
  rev: number;
  sent_rev: number;
  edited_at: number | null;
  unsent_at: number | null;
  edits: string;
  reactions: string;
  glyphs: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    lang: row.lang === 'zh' ? 'zh' : 'en',
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    lastSeenAt: row.last_seen_at,
    lastReadRev: row.last_read_rev,
    suggestNewPassword: row.suggest_new_password === 1,
  };
}

function toMessage(row: MessageRow): Message {
  const deleted = row.deleted_at !== null;
  const gone = deleted || row.unsent_at !== null;
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    // A deletion keeps the row (its rev tells reconnecting clients to drop
    // it) but nothing of what it said.
    body: gone ? '' : row.body,
    image:
      !gone && row.image_id !== null
        ? { id: row.image_id, width: row.width ?? 0, height: row.height ?? 0 }
        : null,
    replyTo: row.reply_to,
    createdAt: row.created_at,
    deleted,
    rev: row.rev,
    sentRev: row.sent_rev,
    unsent: row.unsent_at !== null,
    editedAt: gone ? null : row.edited_at,
    edits: gone ? [] : (JSON.parse(row.edits) as Message['edits']),
    reactions: gone ? [] : (JSON.parse(row.reactions) as Message['reactions']),
    glyphs: gone ? [] : (JSON.parse(row.glyphs) as Message['glyphs']),
  };
}

// A message's edit history and Tapbacks come with it, as JSON from one
// indexed lookup each (both keyed by message_id): a page of 50 messages is
// still one query.
const MESSAGE_COLUMNS = `m.id, m.user_id, m.client_id, m.body, m.image_id, i.width, i.height,
  m.reply_to, m.created_at, m.deleted_at, m.rev, coalesce(m.sent_rev, m.rev) AS sent_rev,
  m.edited_at, m.unsent_at,
  (SELECT json_group_array(json_object('body', e.body, 'at', e.replaced_at))
     FROM (SELECT body, replaced_at FROM message_edits WHERE message_id = m.id ORDER BY n) e) AS edits,
  (SELECT json_group_array(json_object('userId', r.user_id, 'emoji', r.kind))
     FROM (SELECT user_id, kind FROM reactions WHERE message_id = m.id ORDER BY created_at) r)
     AS reactions,
  (SELECT json_group_array(json_object('id', g.image_id, 'width', g.width, 'height', g.height))
     FROM (SELECT mg.image_id, gi.width, gi.height FROM message_glyphs mg
           JOIN images gi ON gi.id = mg.image_id WHERE mg.message_id = m.id ORDER BY mg.n) g)
     AS glyphs`;
const MESSAGE_FROM = 'messages m LEFT JOIN images i ON i.id = m.image_id';

export function normalizeDisplayName(name: string): string {
  const trimmed = name.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) throw new FamilyError('A display name is required.');
  if ([...trimmed].length > MAX_DISPLAY_NAME_CHARS) {
    throw new FamilyError(
      `Display names are at most ${String(MAX_DISPLAY_NAME_CHARS)} characters.`,
    );
  }
  return trimmed;
}

function normalizeBody(text: string): string {
  const body = text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if ([...body].length > MAX_BODY_CHARS) throw new FamilyError('That message is too long.');
  return body;
}

function checkPassword(password: string): void {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    throw new FamilyError(`Passwords are at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
  }
}

/**
 * Everything the chat stores, as plain synchronous calls. Node's SQLite
 * driver is synchronous, which is what makes the server's ordering simple:
 * an insert, its rev, and the broadcast that follows happen in one tick,
 * with nothing interleaved.
 */
export class FamilyStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- users -------------------------------------------------------------

  /**
   * `suggestNewPassword`: a starter password, offered for replacing at the
   * first sign-in, and exempt from the minimum length (the owner chose it,
   * knowing). `passwordHash`: the same password as an account in another
   * chat, copied as its hash (pnpm <chat> add --same-password-as).
   */
  async createUser(input: {
    username: string;
    displayName: string;
    password: string;
    passwordHash?: string;
    suggestNewPassword?: boolean;
    lang?: Lang;
    isAdmin?: boolean;
    now?: number;
  }): Promise<User> {
    const username = input.username.trim();
    if (!USERNAME.test(username)) {
      throw new FamilyError(
        'Usernames are 2–32 letters, digits, dots, dashes or underscores (they are typed on a phone).',
      );
    }
    const displayName = normalizeDisplayName(input.displayName);
    if (input.passwordHash === undefined) {
      if (input.suggestNewPassword === true) {
        if (input.password === '') throw new FamilyError('A password is needed.');
      } else {
        checkPassword(input.password);
      }
    }
    if (this.findUserByUsername(username)) throw new FamilyError('That username is taken.');
    const hash = input.passwordHash ?? (await hashPassword(input.password));
    const result = this.db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, lang, is_admin, created_at,
                            suggest_new_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        username,
        displayName,
        hash,
        input.lang ?? 'en',
        input.isAdmin === true ? 1 : 0,
        input.now ?? Date.now(),
        input.suggestNewPassword === true ? 1 : 0,
      );
    return this.requireUser(Number(result.lastInsertRowid));
  }

  findUserByUsername(username: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as
      UserRow | undefined;
    return row ? toUser(row) : null;
  }

  getUser(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  requireUser(id: number): User {
    const user = this.getUser(id);
    if (!user) throw new FamilyError('No such user.');
    return user;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[]).map(
      toUser,
    );
  }

  /** The user a username and password name, or null — never which half was wrong. */
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as
      UserRow | undefined;
    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
    if (!row || !ok || row.disabled_at !== null) return null;
    return toUser(row);
  }

  async setPassword(userId: number, password: string): Promise<void> {
    checkPassword(password);
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    // A new password signs every device out: that is what a reset is for.
    this.revokeSessions(userId);
  }

  /**
   * Someone choosing their own password, signed in: their other devices
   * are signed out, the one they're using (`keepToken`) stays.
   */
  async changeOwnPassword(userId: number, password: string, keepToken: string): Promise<void> {
    checkPassword(password);
    const hash = await hashPassword(password);
    this.db
      .prepare('UPDATE users SET password_hash = ?, suggest_new_password = 0 WHERE id = ?')
      .run(hash, userId);
    this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .run(userId, sha256(keepToken));
  }

  /** "Not now": the starter password stays, and isn't offered for replacing again. */
  keepPassword(userId: number): void {
    this.db.prepare('UPDATE users SET suggest_new_password = 0 WHERE id = ?').run(userId);
  }

  /** The stored hash of `username`'s password, for giving the same one in another chat. */
  passwordHash(username: string): string | null {
    const row = this.db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(username.trim()) as { password_hash: string } | undefined;
    return row?.password_hash ?? null;
  }

  rename(userId: number, displayName: string): User {
    this.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ?')
      .run(normalizeDisplayName(displayName), userId);
    return this.requireUser(userId);
  }

  setLang(userId: number, lang: Lang): void {
    this.db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, userId);
  }

  setDisabled(userId: number, disabled: boolean, now: number = Date.now()): void {
    this.db
      .prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .run(disabled ? now : null, userId);
    if (disabled) this.revokeSessions(userId);
  }

  /**
   * Removes an account, its sign-ins and its photos' rows (the caller
   * removes the files). Its messages are deleted too —
   * leaving them attributed to nobody would be stranger than either
   * keeping the account (disable it instead) or removing it whole.
   */
  deleteUser(
    userId: number,
    now: number = Date.now(),
  ): { messageIds: number[]; imageIds: string[]; reactedIds: number[] } {
    const reactedIds = (
      this.db.prepare('SELECT message_id FROM reactions WHERE user_id = ?').all(userId) as {
        message_id: number;
      }[]
    ).map((row) => row.message_id);
    const messageIds = (
      this.db
        .prepare('SELECT id FROM messages WHERE user_id = ? AND deleted_at IS NULL')
        .all(userId) as { id: number }[]
    ).map((row) => row.id);
    const imageIds = (
      this.db.prepare('SELECT id FROM images WHERE user_id = ?').all(userId) as { id: string }[]
    ).map((row) => row.id);
    this.transaction(() => {
      for (const id of messageIds) this.#tombstone(id, now);
      this.db.prepare('UPDATE messages SET image_id = NULL WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM images WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      // Their Tapbacks on everyone else's messages go with them.
      this.db.prepare('DELETE FROM reactions WHERE user_id = ?').run(userId);
      for (const id of reactedIds) this.#touch(id);
      // The row stays for the tombstones' foreign keys; the person is gone.
      this.db
        .prepare(
          `UPDATE users SET username = ?, display_name = '', password_hash = '!',
             disabled_at = ?, is_admin = 0 WHERE id = ?`,
        )
        .run(`deleted-${String(userId)}-${String(now)}`, now, userId);
    });
    return {
      messageIds,
      imageIds,
      reactedIds: reactedIds.filter((id) => !messageIds.includes(id)),
    };
  }

  /** Members shown in the conversation: anyone not deleted (disabled people keep their name on what they said). */
  members(): User[] {
    return this.listUsers().filter((user) => !user.username.startsWith('deleted-'));
  }

  // ---- sessions ----------------------------------------------------------

  createSession(userId: number, userAgent: string, now: number = Date.now()): string {
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), userId, now, now + SESSION_DAYS * DAY_MS, now, userAgent.slice(0, 200));
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId);
    return token;
  }

  /**
   * The signed-in user for a session token, or null if it is unknown,
   * expired, or its account disabled. Sliding: a session in use keeps
   * pushing its expiry out, so someone who opens the chat now and then is
   * never asked to sign in again. `refreshed` says the cookie should be
   * re-sent with the new expiry.
   */
  resolveSession(
    token: string | undefined,
    now: number = Date.now(),
  ): { user: User; refreshed: boolean } | null {
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const row = this.db
      .prepare(
        `SELECT s.expires_at, s.last_used_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(hash) as (UserRow & { expires_at: number; last_used_at: number }) | undefined;
    if (!row || row.expires_at <= now || row.disabled_at !== null) return null;
    let refreshed = false;
    if (now - row.last_used_at > TOUCH_INTERVAL_MS) {
      this.db
        .prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?')
        .run(now, now + SESSION_DAYS * DAY_MS, hash);
      this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, row.id);
      refreshed = true;
    }
    return { user: toUser(row), refreshed };
  }

  deleteSession(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  revokeSessions(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  sessions(userId: number): SessionInfo[] {
    return (
      this.db
        .prepare(
          `SELECT user_id, created_at, last_used_at, user_agent FROM sessions
           WHERE user_id = ? ORDER BY last_used_at DESC`,
        )
        .all(userId) as {
        user_id: number;
        created_at: number;
        last_used_at: number;
        user_agent: string;
      }[]
    ).map((row) => ({
      userId: row.user_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      userAgent: row.user_agent,
    }));
  }

  pruneExpiredSessions(now: number = Date.now()): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // ---- messages ----------------------------------------------------------

  currentRev(): number {
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: number })
      .value;
  }

  #nextRev(): number {
    this.db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'rev'").run();
    return this.currentRev();
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Stores a message, or returns the one already stored under the same
   * (author, clientId) — a phone that lost the response and sent again
   * gets its original back instead of a duplicate. `created` says which.
   * The author is whoever is signed in; nothing in the request can say
   * otherwise.
   */
  postMessage(input: {
    userId: number;
    clientId: string;
    body: string;
    imageId?: string | null;
    /** Genmoji and stickers, in the order of the GLYPHs in `body`: the sender's own uploads. */
    glyphs?: readonly string[];
    replyTo?: number | null;
    now?: number;
  }): { message: Message; created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.user_id = ? AND m.client_id = ?`,
      )
      .get(input.userId, input.clientId) as MessageRow | undefined;
    if (existing) return { message: toMessage(existing), created: false };

    const body = normalizeBody(input.body);
    const imageId = input.imageId ?? null;
    const glyphs = input.glyphs ?? [];
    if (body.length === 0 && imageId === null) throw new FamilyError('That message is empty.');
    if (glyphs.length > MAX_GLYPHS) throw new FamilyError('Too many stickers in one message.');
    if (body.split(GLYPH).length - 1 !== glyphs.length) {
      throw new FamilyError('That message’s stickers don’t match its text.');
    }
    // Only your own uploads, each used once: an image id seen in someone
    // else's message can't be re-posted as yours.
    if (new Set(glyphs).size !== glyphs.length) throw new FamilyError('Unknown image.');
    for (const id of imageId === null ? glyphs : [imageId, ...glyphs]) {
      const image = this.db.prepare('SELECT user_id FROM images WHERE id = ?').get(id) as
        { user_id: number } | undefined;
      const used = this.db
        .prepare(
          `SELECT 1 FROM messages WHERE image_id = ?1
           UNION ALL SELECT 1 FROM message_glyphs WHERE image_id = ?1`,
        )
        .get(id);
      if (!image || image.user_id !== input.userId || used) throw new FamilyError('Unknown image.');
    }
    let replyTo = input.replyTo ?? null;
    if (replyTo !== null && !this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(replyTo)) {
      replyTo = null;
    }

    const id = this.transaction(() => {
      const rev = this.#nextRev();
      const result = this.db
        .prepare(
          `INSERT INTO messages (user_id, client_id, body, image_id, reply_to, created_at, rev,
                                 sent_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.userId,
          input.clientId,
          body,
          imageId,
          replyTo,
          input.now ?? Date.now(),
          rev,
          rev,
        );
      const id = Number(result.lastInsertRowid);
      const glyph = this.db.prepare(
        'INSERT INTO message_glyphs (message_id, n, image_id) VALUES (?, ?, ?)',
      );
      glyphs.forEach((imageId, n) => glyph.run(id, n, imageId));
      return id;
    });
    return { message: this.requireMessage(id), created: true };
  }

  getMessage(id: number): Message | null {
    const row = this.db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id = ?`)
      .get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  requireMessage(id: number): Message {
    const message = this.getMessage(id);
    if (!message) throw new FamilyError('No such message.');
    return message;
  }

  /** The newest `limit` live messages before `beforeId` (or the very newest), oldest first. */
  history(beforeId: number | null, limit: number): { messages: Message[]; hasMore: boolean } {
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
         WHERE m.deleted_at IS NULL AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
      )
      .all(beforeId ?? Number.MAX_SAFE_INTEGER, limit + 1) as unknown as MessageRow[];
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
  }

  /**
   * Messages whose text contains `query` (case-insensitive for Latin
   * letters; Chinese has no case), newest first. Deleted messages are
   * never found — their text is already gone. Only this chat's database is
   * searched, so only the conversation the searcher is signed in to.
   */
  search(query: string, limit: number): { messages: Message[]; hasMore: boolean } {
    const needle = query.normalize('NFC').trim();
    if (needle === '') return { messages: [], hasMore: false };
    const pattern = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
         WHERE m.deleted_at IS NULL AND m.unsent_at IS NULL AND m.body LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`,
      )
      .all(pattern, limit + 1) as unknown as MessageRow[];
    return { messages: rows.slice(0, limit).map(toMessage), hasMore: rows.length > limit };
  }

  /** Every message inserted or deleted after `rev`, in rev order — what a reconnect missed. */
  changesSince(rev: number, limit: number): Message[] {
    return (
      this.db
        .prepare(
          `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.rev > ? ORDER BY m.rev LIMIT ?`,
        )
        .all(rev, limit) as unknown as MessageRow[]
    ).map(toMessage);
  }

  #tombstone(id: number, now: number): string[] {
    const rev = this.#nextRev();
    this.db
      .prepare(`UPDATE messages SET deleted_at = ?, body = '', rev = ? WHERE id = ?`)
      .run(now, rev, id);
    return this.#forget(id);
  }

  /**
   * Everything a message said, before it is unsent or deleted: earlier
   * versions, reactions, its photo and stickers' rows. Returns the images'
   * ids, whose files the caller removes.
   */
  #forget(id: number): string[] {
    const images = (
      this.db
        .prepare(
          `SELECT image_id AS id FROM messages WHERE id = ?1 AND image_id IS NOT NULL
           UNION ALL SELECT image_id FROM message_glyphs WHERE message_id = ?1`,
        )
        .all(id) as { id: string }[]
    ).map((row) => row.id);
    this.db.prepare('DELETE FROM message_edits WHERE message_id = ?').run(id);
    this.db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
    this.db.prepare('DELETE FROM message_glyphs WHERE message_id = ?').run(id);
    this.db.prepare('UPDATE messages SET image_id = NULL WHERE id = ?').run(id);
    const remove = this.db.prepare('DELETE FROM images WHERE id = ?');
    for (const image of images) remove.run(image);
    return images;
  }

  /** A change to a message: it takes the next rev, so a reconnect replays it. */
  #touch(id: number): void {
    this.db.prepare('UPDATE messages SET rev = ? WHERE id = ?').run(this.#nextRev(), id);
  }

  #ownLive(actor: User, id: number): Message {
    const message = this.getMessage(id);
    if (!message || message.deleted || message.unsent) throw new FamilyError('No such message.');
    if (message.userId !== actor.id)
      throw new FamilyError('Only its author can change that message.');
    return message;
  }

  /**
   * Edits one's own message: within EDIT_WINDOW_MS of sending, at most
   * MAX_EDITS times, text only (a photo can't be edited). The version it
   * replaces is kept, for everyone's "Edited" history. `changed` is false
   * when the text is the same, which costs no edit.
   */
  editMessage(
    actor: User,
    id: number,
    text: string,
    now: number = Date.now(),
  ): { message: Message; changed: boolean } {
    const message = this.#ownLive(actor, id);
    if (message.body === '') throw new FamilyError('Only text can be edited.');
    if (message.glyphs.length > 0) {
      throw new FamilyError('A message with stickers or Genmoji can’t be edited.');
    }
    if (now - message.createdAt > EDIT_WINDOW_MS) {
      throw new FamilyError('Messages can be edited for 15 minutes after sending.');
    }
    if (message.edits.length >= MAX_EDITS) {
      throw new FamilyError('A message can be edited 5 times.');
    }
    const body = normalizeBody(text.replaceAll(GLYPH, ''));
    if (body === '') throw new FamilyError('That message is empty.');
    if (body === message.body) return { message, changed: false };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO message_edits (message_id, n, body, replaced_at) VALUES (?, ?, ?, ?)')
        .run(id, message.edits.length, message.body, now);
      this.db
        .prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
        .run(body, now, id);
      this.#touch(id);
    });
    return { message: this.requireMessage(id), changed: true };
  }

  /**
   * Undo Send: within UNSEND_WINDOW_MS, its author only. The row stays (so
   * everyone sees "… unsent a message", and replies keep their place) but
   * its text, earlier versions, Tapbacks and photo are gone — from every
   * API, every page of history, every replay. The caller removes the
   * photo's file.
   */
  unsendMessage(
    actor: User,
    id: number,
    now: number = Date.now(),
  ): { message: Message; imageIds: string[] } {
    const message = this.#ownLive(actor, id);
    if (now - message.createdAt > UNSEND_WINDOW_MS) {
      throw new FamilyError('Messages can be unsent for 2 minutes after sending.');
    }
    const imageIds = this.transaction(() => {
      this.db
        .prepare(`UPDATE messages SET unsent_at = ?, body = '', edited_at = NULL WHERE id = ?`)
        .run(now, id);
      const removed = this.#forget(id);
      this.#touch(id);
      return removed;
    });
    return { message: this.requireMessage(id), imageIds };
  }

  /**
   * Adds `actor`'s reaction with `emoji` to a message (`on`), or takes it
   * back. Any emoji, several each, as on Discord. `changed` is false when
   * it was already so.
   */
  react(
    actor: User,
    id: number,
    emoji: string,
    on: boolean,
    now: number = Date.now(),
  ): { message: Message; changed: boolean } {
    if (!isEmoji(emoji)) throw new FamilyError('That isn’t an emoji.');
    const message = this.getMessage(id);
    if (!message || message.deleted || message.unsent) throw new FamilyError('No such message.');
    const mine = message.reactions.filter((r) => r.userId === actor.id);
    const has = mine.some((r) => r.emoji === emoji);
    if (has === on) return { message, changed: false };
    if (on) {
      if (mine.length >= MAX_REACTIONS_EACH) throw new FamilyError('That’s plenty of reactions.');
      const kinds = new Set(message.reactions.map((r) => r.emoji));
      if (!kinds.has(emoji) && kinds.size >= MAX_REACTIONS_TOTAL) {
        throw new FamilyError('That’s plenty of reactions.');
      }
    }
    this.transaction(() => {
      if (on) {
        this.db
          .prepare(
            'INSERT INTO reactions (message_id, user_id, kind, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(id, actor.id, emoji, now);
      } else {
        this.db
          .prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND kind = ?')
          .run(id, actor.id, emoji);
      }
      this.#touch(id);
    });
    return { message: this.requireMessage(id), changed: true };
  }

  /**
   * Deletes a message if `actor` may: its author, or an admin. Returns the
   * tombstone, and the image file to remove (the bytes go too, not only
   * the reference).
   */
  deleteMessage(
    actor: User,
    id: number,
    now: number = Date.now(),
  ): { message: Message; imageIds: string[] } {
    const message = this.getMessage(id);
    if (!message || message.deleted) throw new FamilyError('No such message.');
    if (message.userId !== actor.id && !actor.isAdmin) {
      throw new FamilyError('Only its author can delete that message.');
    }
    const imageIds = this.transaction(() => this.#tombstone(id, now));
    return { message: this.requireMessage(id), imageIds };
  }

  /**
   * Moves `userId`'s read position up to `rev` (never back), stamping each
   * message from someone else that it passes with the time it was read.
   * Returns the new position if it moved, else null — a read receipt to
   * tell everyone about.
   */
  markRead(userId: number, rev: number, now: number = Date.now()): number | null {
    const target = Math.min(rev, this.currentRev());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT last_read_rev FROM users WHERE id = ?').get(userId) as
        { last_read_rev: number } | undefined;
      if (!row || target <= row.last_read_rev) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at)
           SELECT id, ?, ? FROM messages
           WHERE rev > ? AND coalesce(sent_rev, rev) > ? AND coalesce(sent_rev, rev) <= ?
             AND user_id <> ? AND deleted_at IS NULL AND unsent_at IS NULL`,
        )
        // rev > …: a message's rev is never below the rev it was sent at, so
        // this only narrows the search to the rev index, never the result.
        .run(userId, now, row.last_read_rev, row.last_read_rev, target, userId);
      this.db.prepare('UPDATE users SET last_read_rev = ? WHERE id = ?').run(target, userId);
      this.db.exec('COMMIT');
      return target;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Who has read message `id` and when (`at` null: read before receipts
   * were kept), and who hasn't yet — every active member but its author.
   */
  receipts(id: number): {
    read: { userId: number; at: number | null }[];
    unread: number[];
  } | null {
    const message = this.getMessage(id);
    if (!message || message.deleted || message.unsent) return null;
    const times = new Map(
      (
        this.db
          .prepare('SELECT user_id, read_at FROM message_reads WHERE message_id = ?')
          .all(id) as unknown as { user_id: number; read_at: number }[]
      ).map((r) => [r.user_id, r.read_at]),
    );
    const read: { userId: number; at: number | null }[] = [];
    const unread: number[] = [];
    for (const user of this.members()) {
      if (user.id === message.userId || user.disabledAt !== null) continue;
      if (user.lastReadRev >= message.sentRev || times.has(user.id)) {
        read.push({ userId: user.id, at: times.get(user.id) ?? null });
      } else unread.push(user.id);
    }
    read.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return { read, unread };
  }

  // ---- images ------------------------------------------------------------

  addImage(input: {
    userId: number;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    now?: number;
  }): string {
    const id = randomBytes(16).toString('hex');
    this.db
      .prepare(
        `INSERT INTO images (id, user_id, mime, bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.mime,
        input.bytes,
        input.width,
        input.height,
        input.now ?? Date.now(),
      );
    return id;
  }

  getImage(id: string): { mime: string } | null {
    if (!/^[0-9a-f]{32}$/.test(id)) return null;
    const row = this.db.prepare('SELECT mime FROM images WHERE id = ?').get(id) as
      { mime: string } | undefined;
    return row ?? null;
  }

  /**
   * Photos uploaded but never sent (the message's POST never came: the
   * page was closed between the two requests, or its send failed for
   * good), older than `before`. Their rows go here; the caller removes
   * the files.
   */
  takeOrphanImages(before: number): string[] {
    return this.transaction(() => {
      const ids = (
        this.db
          .prepare(
            `SELECT id FROM images WHERE created_at < ?
             AND NOT EXISTS (SELECT 1 FROM messages WHERE image_id = images.id)
             AND NOT EXISTS (SELECT 1 FROM message_glyphs WHERE image_id = images.id)`,
          )
          .all(before) as { id: string }[]
      ).map((row) => row.id);
      const remove = this.db.prepare('DELETE FROM images WHERE id = ?');
      for (const id of ids) remove.run(id);
      return ids;
    });
  }

  // ---- sync --------------------------------------------------------------

  /** Which database this is; a restore changes it (see db.ts, migration 2). */
  epoch(): number {
    return (
      this.db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: number }
    ).value;
  }

  renewEpoch(): number {
    this.db
      .prepare("UPDATE meta SET value = abs(random()) % 9007199254740991 WHERE key = 'epoch'")
      .run();
    return this.epoch();
  }

  /** Messages from others this person hasn't read yet: the app badge's number. */
  unreadCount(userId: number): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM messages m JOIN users u ON u.id = ?
           WHERE m.rev > u.last_read_rev AND coalesce(m.sent_rev, m.rev) > u.last_read_rev
             AND m.user_id != u.id
             AND m.deleted_at IS NULL AND m.unsent_at IS NULL`,
        )
        .get(userId) as { n: number }
    ).n;
  }

  // ---- notifications -------------------------------------------------------

  /** Stores (or moves to this sign-in) one device's push subscription. */
  savePushSubscription(input: {
    endpoint: string;
    sessionToken: string;
    userId: number;
    p256dh: string;
    auth: string;
    preview: boolean;
    now?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (endpoint, session_hash, user_id, p256dh, auth, preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET session_hash = excluded.session_hash,
           user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           preview = excluded.preview, failures = 0`,
      )
      .run(
        input.endpoint,
        sha256(input.sessionToken),
        input.userId,
        input.p256dh,
        input.auth,
        input.preview ? 1 : 0,
        input.now ?? Date.now(),
      );
  }

  /** Removes a subscription — only one of the caller's own. */
  deletePushSubscription(endpoint: string, userId: number): void {
    this.db
      .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
      .run(endpoint, userId);
  }

  /** This device's subscription (by its sign-in), if it has one. */
  pushSubscriptionFor(
    sessionToken: string | undefined,
  ): { endpoint: string; preview: boolean } | null {
    if (!sessionToken) return null;
    const row = this.db
      .prepare('SELECT endpoint, preview FROM push_subscriptions WHERE session_hash = ?')
      .get(sha256(sessionToken)) as { endpoint: string; preview: number } | undefined;
    return row ? { endpoint: row.endpoint, preview: row.preview === 1 } : null;
  }

  pushTargets(
    userId: number,
  ): { endpoint: string; p256dh: string; auth: string; preview: boolean }[] {
    return (
      this.db
        .prepare(
          `SELECT p.endpoint, p.p256dh, p.auth, p.preview FROM push_subscriptions p
           JOIN users u ON u.id = p.user_id WHERE p.user_id = ? AND u.disabled_at IS NULL`,
        )
        .all(userId) as { endpoint: string; p256dh: string; auth: string; preview: number }[]
    ).map((row) => ({ ...row, preview: row.preview === 1 }));
  }

  /**
   * Records how a push went. A subscription the push service says is gone
   * is deleted at once; one that keeps failing for other reasons goes
   * after 20 in a row (weeks of a device that will never come back).
   */
  recordPush(
    endpoint: string,
    outcome: 'sent' | 'gone' | 'failed',
    now: number = Date.now(),
  ): void {
    if (outcome === 'sent') {
      this.db
        .prepare(
          'UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE endpoint = ?',
        )
        .run(now, endpoint);
    } else if (outcome === 'gone') {
      this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } else {
      this.db
        .prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?')
        .run(endpoint);
      this.db
        .prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= 20')
        .run(endpoint);
    }
  }

  pushDeviceCount(userId: number): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?')
        .get(userId) as { n: number }
    ).n;
  }

  // ---- diagnostics -------------------------------------------------------

  stats(): { messages: number; deleted: number; images: number; imageBytes: number } {
    const m = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL) AS live,
                COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS gone FROM messages`,
      )
      .get() as { live: number; gone: number };
    const i = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM images')
      .get() as { n: number; b: number };
    return { messages: m.live, deleted: m.gone, images: i.n, imageBytes: i.b };
  }
}
