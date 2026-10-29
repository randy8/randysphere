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
  readonly rev: number;
}

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
  };
}

function toMessage(row: MessageRow): Message {
  const deleted = row.deleted_at !== null;
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    // A deletion keeps the row (its rev tells reconnecting clients to drop
    // it) but nothing of what it said.
    body: deleted ? '' : row.body,
    image:
      !deleted && row.image_id !== null
        ? { id: row.image_id, width: row.width ?? 0, height: row.height ?? 0 }
        : null,
    replyTo: row.reply_to,
    createdAt: row.created_at,
    deleted,
    rev: row.rev,
  };
}

const MESSAGE_COLUMNS = `m.id, m.user_id, m.client_id, m.body, m.image_id, i.width, i.height,
  m.reply_to, m.created_at, m.deleted_at, m.rev`;
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

  async createUser(input: {
    username: string;
    displayName: string;
    password: string;
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
    checkPassword(input.password);
    if (this.findUserByUsername(username)) throw new FamilyError('That username is taken.');
    const hash = await hashPassword(input.password);
    const result = this.db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, lang, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        username,
        displayName,
        hash,
        input.lang ?? 'en',
        input.isAdmin === true ? 1 : 0,
        input.now ?? Date.now(),
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
  ): { messageIds: number[]; imageIds: string[] } {
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
      // The row stays for the tombstones' foreign keys; the person is gone.
      this.db
        .prepare(
          `UPDATE users SET username = ?, display_name = '', password_hash = '!',
             disabled_at = ?, is_admin = 0 WHERE id = ?`,
        )
        .run(`deleted-${String(userId)}-${String(now)}`, now, userId);
    });
    return { messageIds, imageIds };
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
    replyTo?: number | null;
    now?: number;
  }): { message: Message; created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.user_id = ? AND m.client_id = ?`,
      )
      .get(input.userId, input.clientId) as MessageRow | undefined;
    if (existing) return { message: toMessage(existing), created: false };

    const body = input.body.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if ([...body].length > MAX_BODY_CHARS) throw new FamilyError('That message is too long.');
    const imageId = input.imageId ?? null;
    if (body.length === 0 && imageId === null) throw new FamilyError('That message is empty.');
    if (imageId !== null) {
      const image = this.db.prepare('SELECT user_id FROM images WHERE id = ?').get(imageId) as
        { user_id: number } | undefined;
      // Only your own uploads: an image id seen in someone else's message
      // can't be re-posted as yours.
      if (!image || image.user_id !== input.userId) throw new FamilyError('Unknown image.');
    }
    let replyTo = input.replyTo ?? null;
    if (replyTo !== null && !this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(replyTo)) {
      replyTo = null;
    }

    const id = this.transaction(() => {
      const rev = this.#nextRev();
      const result = this.db
        .prepare(
          `INSERT INTO messages (user_id, client_id, body, image_id, reply_to, created_at, rev)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.userId, input.clientId, body, imageId, replyTo, input.now ?? Date.now(), rev);
      return Number(result.lastInsertRowid);
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

  #tombstone(id: number, now: number): void {
    const rev = this.#nextRev();
    this.db
      .prepare(`UPDATE messages SET deleted_at = ?, body = '', rev = ? WHERE id = ?`)
      .run(now, rev, id);
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
  ): { message: Message; imageId: string | null } {
    const message = this.getMessage(id);
    if (!message || message.deleted) throw new FamilyError('No such message.');
    if (message.userId !== actor.id && !actor.isAdmin) {
      throw new FamilyError('Only its author can delete that message.');
    }
    const imageId = message.image?.id ?? null;
    this.transaction(() => {
      this.#tombstone(id, now);
      this.db.prepare('UPDATE messages SET image_id = NULL WHERE id = ?').run(id);
      if (imageId !== null) this.db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
    });
    return { message: this.requireMessage(id), imageId };
  }

  markRead(userId: number, rev: number): void {
    this.db
      .prepare('UPDATE users SET last_read_rev = MAX(last_read_rev, ?) WHERE id = ?')
      .run(Math.min(rev, this.currentRev()), userId);
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
             AND NOT EXISTS (SELECT 1 FROM messages WHERE image_id = images.id)`,
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
           WHERE m.rev > u.last_read_rev AND m.user_id != u.id AND m.deleted_at IS NULL`,
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
