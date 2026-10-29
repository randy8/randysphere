import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { migrate, openDatabase, SCHEMA_VERSION } from './db.ts';
import { FamilyError, FamilyStore, SESSION_DAYS } from './store.ts';
import type { User } from './store.ts';

const path = join(mkdtempSync(join(tmpdir(), 'family-store-')), 'chat.db');
let store: FamilyStore;
let mom: User;
let randy: User;
let dad: User;

before(async () => {
  store = new FamilyStore(openDatabase(path));
  [mom, randy, dad] = await Promise.all([
    store.createUser({
      username: 'mom',
      displayName: '妈妈',
      password: 'correct horse',
      lang: 'zh',
    }),
    store.createUser({
      username: 'randy',
      displayName: 'Randy',
      password: 'battery staple',
      isAdmin: true,
    }),
    store.createUser({ username: 'dad', displayName: 'Dad', password: 'another password' }),
  ]);
});

test('passwords are stored as Argon2id hashes, never as given', () => {
  const row = store.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(mom.id) as {
    password_hash: string;
  };
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.ok(!row.password_hash.includes('correct horse'));
});

test('sign-in: right password, wrong password, unknown name, any capitalisation', async () => {
  assert.equal((await store.authenticate('mom', 'correct horse'))?.id, mom.id);
  assert.equal((await store.authenticate('MOM ', 'correct horse'))?.id, mom.id);
  assert.equal(await store.authenticate('mom', 'correct horsE'), null);
  assert.equal(await store.authenticate('nobody', 'correct horse'), null);
});

test('display names keep Chinese; usernames and passwords are checked', async () => {
  assert.equal(mom.displayName, '妈妈');
  await assert.rejects(
    store.createUser({ username: 'MOM', displayName: 'x', password: 'long enough' }),
    /taken/,
  );
  await assert.rejects(
    store.createUser({ username: 'a b', displayName: 'x', password: 'long enough' }),
    FamilyError,
  );
  await assert.rejects(
    store.createUser({ username: 'shorty', displayName: 'x', password: 'short' }),
    /at least 8/,
  );
});

test('a session resolves to its user, slides forward with use, and ends on revoke', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const token = store.createSession(dad.id, 'test', t0);
  assert.equal(store.resolveSession(token, t0 + 1000)?.user.id, dad.id);
  assert.equal(store.resolveSession(token, t0 + 1000)?.refreshed, false);
  // Used again a day later: refreshed, so it now lasts 400 days from then.
  const later = t0 + 86_400_000;
  assert.equal(store.resolveSession(token, later)?.refreshed, true);
  assert.ok(store.resolveSession(token, t0 + SESSION_DAYS * 86_400_000 + 1000));
  // Left unused, a session ends after 400 days.
  const idle = store.createSession(dad.id, 'test', t0);
  assert.equal(store.resolveSession(idle, t0 + (SESSION_DAYS + 1) * 86_400_000), null);
  store.revokeSessions(dad.id);
  assert.equal(store.resolveSession(token, later), null);
  assert.equal(store.resolveSession('not-a-token'), null);
  assert.equal(store.resolveSession(undefined), null);
});

test('session tokens are stored hashed', () => {
  const token = store.createSession(dad.id, 'test');
  const rows = store.db.prepare('SELECT token_hash FROM sessions').all() as {
    token_hash: string;
  }[];
  assert.ok(rows.every((row) => row.token_hash !== token && row.token_hash.length === 64));
  store.revokeSessions(dad.id);
});

test('disabling an account signs it out and refuses its password', async () => {
  const token = store.createSession(dad.id, 'test');
  store.setDisabled(dad.id, true);
  assert.equal(store.resolveSession(token), null);
  assert.equal(await store.authenticate('dad', 'another password'), null);
  store.setDisabled(dad.id, false);
  assert.equal((await store.authenticate('dad', 'another password'))?.id, dad.id);
});

test('a new password signs every device out', async () => {
  const token = store.createSession(dad.id, 'test');
  await store.setPassword(dad.id, 'a brand new one');
  assert.equal(store.resolveSession(token), null);
  assert.equal((await store.authenticate('dad', 'a brand new one'))?.id, dad.id);
});

test('sending twice with one clientId stores one message', () => {
  const first = store.postMessage({ userId: mom.id, clientId: 'retry-0001', body: '你好 👋' });
  const revAfterFirst = store.currentRev();
  const again = store.postMessage({ userId: mom.id, clientId: 'retry-0001', body: '你好 👋' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.message.id, first.message.id);
  assert.equal(store.currentRev(), revAfterFirst);
  // The same clientId from someone else is their own message.
  const other = store.postMessage({ userId: randy.id, clientId: 'retry-0001', body: 'hi' });
  assert.equal(other.created, true);
});

test('messages are normalised, bounded, and never empty', () => {
  const { message } = store.postMessage({
    userId: mom.id,
    clientId: 'norm-0001',
    body: '  a\r\nb  ',
  });
  assert.equal(message.body, 'a\nb');
  assert.throws(
    () => store.postMessage({ userId: mom.id, clientId: 'empty-001', body: '   ' }),
    /empty/,
  );
  assert.throws(
    () => store.postMessage({ userId: mom.id, clientId: 'long-0001', body: '字'.repeat(4001) }),
    /too long/,
  );
});

test('messages survive closing and reopening the database', () => {
  const { message } = store.postMessage({
    userId: mom.id,
    clientId: 'durable-01',
    body: '记得吃饭',
  });
  const reopened = new FamilyStore(openDatabase(path));
  assert.equal(reopened.getMessage(message.id)?.body, '记得吃饭');
  assert.equal(reopened.currentRev(), store.currentRev());
  reopened.db.close();
});

test('changesSince replays new messages and deletions in rev order', () => {
  const start = store.currentRev();
  const a = store.postMessage({ userId: mom.id, clientId: 'replay-001', body: 'a' }).message;
  const b = store.postMessage({ userId: randy.id, clientId: 'replay-002', body: 'b' }).message;
  store.deleteMessage(mom, a.id);
  const changes = store.changesSince(start, 100);
  assert.deepEqual(
    changes.map((m) => [m.id, m.deleted]),
    [
      [b.id, false],
      [a.id, true],
    ],
  );
  assert.equal(changes[1]?.body, '');
});

test('only the author, or an admin, can delete a message', () => {
  const { message } = store.postMessage({ userId: mom.id, clientId: 'del-00001', body: 'oops' });
  assert.throws(() => store.deleteMessage(dad, message.id), /Only its author/);
  assert.equal(store.deleteMessage(randy, message.id).message.deleted, true);
  assert.throws(() => store.deleteMessage(randy, message.id), /No such message/);
});

test('a photo can only be sent by the person who uploaded it', () => {
  const imageId = store.addImage({
    userId: mom.id,
    mime: 'image/jpeg',
    bytes: 10,
    width: 4,
    height: 3,
  });
  assert.throws(
    () => store.postMessage({ userId: dad.id, clientId: 'steal-001', body: '', imageId }),
    /Unknown image/,
  );
  const { message } = store.postMessage({
    userId: mom.id,
    clientId: 'photo-001',
    body: '',
    imageId,
  });
  assert.deepEqual(message.image, { id: imageId, width: 4, height: 3 });
  const removed = store.deleteMessage(mom, message.id);
  assert.equal(removed.imageId, imageId);
  assert.equal(store.getImage(imageId), null);
});

test('history pages backwards, oldest first within a page, without deleted messages', () => {
  for (let i = 0; i < 5; i += 1) {
    store.postMessage({
      userId: dad.id,
      clientId: `page-${String(i).padStart(4, '0')}`,
      body: `p${String(i)}`,
    });
  }
  const newest = store.history(null, 3);
  assert.deepEqual(
    newest.messages.map((m) => m.body),
    ['p2', 'p3', 'p4'],
  );
  assert.equal(newest.hasMore, true);
  const older = store.history(newest.messages[0]?.id ?? 0, 2);
  assert.deepEqual(
    older.messages.map((m) => m.body),
    ['p0', 'p1'],
  );
  assert.ok(store.history(null, 1000).messages.every((m) => !m.deleted));
});

test('deleting an account removes its sign-ins and its messages', async () => {
  const temp = await store.createUser({
    username: 'cousin',
    displayName: 'Cousin',
    password: 'temporary pw',
  });
  const token = store.createSession(temp.id, 'test');
  store.postMessage({ userId: temp.id, clientId: 'cousin-01', body: 'hello' });
  const { messageIds } = store.deleteUser(temp.id);
  assert.equal(messageIds.length, 1);
  assert.equal(store.resolveSession(token), null);
  assert.equal(await store.authenticate('cousin', 'temporary pw'), null);
  assert.ok(!store.members().some((user) => user.id === temp.id));
  assert.equal(store.getMessage(messageIds[0] ?? 0)?.deleted, true);
});

test('a database knows its epoch; renewing it (a restore) changes it, nothing else', () => {
  const epoch = store.epoch();
  const rev = store.currentRev();
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 0);
  assert.notEqual(store.renewEpoch(), epoch);
  assert.equal(store.currentRev(), rev);
});

test('unread counts others’ live messages after the last read rev', () => {
  const before = store.unreadCount(dad.id);
  const a = store.postMessage({ userId: mom.id, clientId: 'unread-0001', body: 'one' }).message;
  store.postMessage({ userId: dad.id, clientId: 'unread-0002', body: 'mine' });
  assert.equal(store.unreadCount(dad.id), before + 1);
  store.markRead(dad.id, a.rev);
  assert.equal(store.unreadCount(dad.id), 0);
});

test('migration 4 undoes rooms: Family’s messages and read positions kept, nothing else dropped', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, 3);
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, created_at, last_read_rev)
           VALUES (1, 'mom', 'Mom', 'x', 0, 2)`);
  db.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev)
           VALUES (1, 'a', 'hello', 0, 1), (1, 'b', 'again', 0, 2), (1, 'c', 'third', 0, 3)`);
  // Read further in Family since the rooms release than users.last_read_rev says.
  db.exec('INSERT INTO room_reads (user_id, room_id, last_read_rev) VALUES (1, 1, 3)');
  migrate(db);
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    SCHEMA_VERSION,
  );
  assert.equal(new FamilyStore(db).history(null, 10).messages.length, 3);
  assert.equal(
    (db.prepare('SELECT last_read_rev FROM users WHERE id = 1').get() as { last_read_rev: number })
      .last_read_rev,
    3,
  );
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'room%'").all();
  assert.deepEqual(tables, []);

  // A message ever sent in another room stops the migration instead of vanishing.
  const kept = new DatabaseSync(':memory:');
  migrate(kept, 3);
  kept.exec(`INSERT INTO users (id, username, display_name, password_hash, created_at)
             VALUES (1, 'mom', 'Mom', 'x', 0)`);
  kept.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev, room_id)
             VALUES (1, 'a', 'in Disc', 0, 1, 2)`);
  assert.throws(() => migrate(kept), /CHECK constraint failed/);
  assert.equal(
    (kept.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    3,
  );
});

test('read receipts: reading stamps each message from someone else, once, with when', () => {
  const sent = store.postMessage({ userId: randy.id, clientId: 'receipt-0001', body: 'read me' });
  const own = store.postMessage({ userId: mom.id, clientId: 'receipt-0002', body: 'mine' });
  assert.deepEqual(store.receipts(sent.message.id)?.read, []);
  assert.ok(store.receipts(sent.message.id)?.unread.includes(mom.id));

  assert.equal(store.markRead(mom.id, own.message.rev, 1000), own.message.rev);
  assert.equal(store.markRead(mom.id, own.message.rev, 2000), null, 'not again');
  const receipts = store.receipts(sent.message.id);
  assert.deepEqual(
    receipts?.read.find((r) => r.userId === mom.id),
    { userId: mom.id, at: 1000 },
  );
  assert.ok(!receipts?.unread.includes(mom.id));
  // Her own message isn't "read" by her.
  const ownReads = store.db
    .prepare('SELECT count(*) AS n FROM message_reads WHERE message_id = ? AND user_id = ?')
    .get(own.message.id, mom.id) as { n: number };
  assert.equal(ownReads.n, 0);
});

test('editing: own text only, within 15 minutes, 5 times; every version kept', () => {
  const t0 = 1_000_000;
  const { message } = store.postMessage({
    userId: dad.id,
    clientId: 'edit-0001',
    body: 'dinner at 6',
    now: t0,
  });
  assert.throws(() => store.editMessage(mom, message.id, 'no', t0 + 1000), /author/);
  const same = store.editMessage(dad, message.id, 'dinner at 6 ', t0 + 1000);
  assert.equal(same.changed, false, 'the same words cost no edit');

  const first = store.editMessage(dad, message.id, 'dinner at 7', t0 + 2000);
  assert.equal(first.message.body, 'dinner at 7');
  assert.equal(first.message.editedAt, t0 + 2000);
  assert.deepEqual(first.message.edits, [{ body: 'dinner at 6', at: t0 + 2000 }]);
  assert.ok(first.message.rev > message.rev, 'an edit moves the rev, for replay');
  assert.equal(first.message.sentRev, message.rev, 'but not when it was sent');
  assert.ok(store.changesSince(message.rev, 10).some((m) => m.id === message.id));

  for (let n = 2; n <= 5; n += 1) store.editMessage(dad, message.id, `at ${String(n)}`, t0 + 3000);
  assert.throws(() => store.editMessage(dad, message.id, 'six', t0 + 4000), /5 times/);
  assert.equal(store.requireMessage(message.id).edits.length, 5);

  const late = store.postMessage({ userId: dad.id, clientId: 'edit-0002', body: 'x', now: t0 });
  assert.throws(
    () => store.editMessage(dad, late.message.id, 'y', t0 + 15 * 60 * 1000 + 1),
    /15 minutes/,
  );
  assert.throws(() => store.editMessage(dad, late.message.id, '  ', t0 + 1), /empty/);
});

test('an edit is no new message: unread counts and read positions ignore it', () => {
  const t0 = Date.now();
  const { message } = store.postMessage({
    userId: dad.id,
    clientId: 'edit-0003',
    body: 'hi',
    now: t0,
  });
  store.markRead(mom.id, store.currentRev());
  const before = store.unreadCount(mom.id);
  store.editMessage(dad, message.id, 'hello', t0 + 1);
  store.react(randy, message.id, 'love');
  assert.equal(store.unreadCount(mom.id), before);
  assert.ok(store.receipts(message.id)?.read.some((r) => r.userId === mom.id));
});

test('undo send: author only, within 2 minutes; nothing of it stays but the fact', () => {
  const t0 = 2_000_000;
  const { message } = store.postMessage({
    userId: dad.id,
    clientId: 'unsend-0001',
    body: 'oops',
    now: t0,
  });
  store.editMessage(dad, message.id, 'oops!', t0 + 10);
  store.react(mom, message.id, 'laugh');
  assert.throws(() => store.unsendMessage(randy, message.id, t0 + 100), /author/);
  assert.throws(() => store.unsendMessage(dad, message.id, t0 + 2 * 60 * 1000 + 1), /2 minutes/);

  const { message: unsent } = store.unsendMessage(dad, message.id, t0 + 100);
  assert.equal(unsent.unsent, true);
  assert.equal(unsent.body, '');
  assert.deepEqual(unsent.edits, []);
  assert.deepEqual(unsent.reactions, []);
  const row = store.db
    .prepare(
      `SELECT body, (SELECT count(*) FROM message_edits WHERE message_id = ?) AS edits,
              (SELECT count(*) FROM reactions WHERE message_id = ?) AS reactions
       FROM messages WHERE id = ?`,
    )
    .get(message.id, message.id, message.id) as { body: string; edits: number; reactions: number };
  assert.deepEqual({ ...row }, { body: '', edits: 0, reactions: 0 }, 'gone from the database too');
  assert.ok(store.history(null, 500).messages.some((m) => m.id === message.id && m.unsent));
  assert.ok(!store.search('oops', 10).messages.some((m) => m.id === message.id));
  assert.throws(() => store.unsendMessage(dad, message.id, t0 + 200), /No such/);
  assert.throws(() => store.react(mom, message.id, 'like'), /No such/);
});

test('undo send takes a photo with it', () => {
  const imageId = store.addImage({
    userId: dad.id,
    mime: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  });
  const { message } = store.postMessage({
    userId: dad.id,
    clientId: 'unsend-0002',
    body: '',
    imageId,
  });
  const { imageId: removed } = store.unsendMessage(dad, message.id);
  assert.equal(removed, imageId);
  assert.equal(store.getImage(imageId), null);
  assert.equal(store.requireMessage(message.id).image, null);
});

test('tapbacks: one per person, changed or taken back', () => {
  const { message } = store.postMessage({ userId: dad.id, clientId: 'tapback-01', body: 'yo' });
  assert.equal(store.react(mom, message.id, 'love', 1).changed, true);
  assert.equal(store.react(mom, message.id, 'love', 2).changed, false);
  store.react(randy, message.id, 'like', 3);
  // A changed Tapback is a new one: it goes to the end.
  assert.deepEqual(store.react(mom, message.id, 'laugh', 4).message.reactions, [
    { userId: randy.id, kind: 'like' },
    { userId: mom.id, kind: 'laugh' },
  ]);
  assert.deepEqual(store.react(mom, message.id, null).message.reactions, [
    { userId: randy.id, kind: 'like' },
  ]);
});

test('migration 7 keeps every message, with the rev it was sent at', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, 6);
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, created_at)
           VALUES (1, 'a', 'A', 'x', 0)`);
  db.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev)
           VALUES (1, 'c1', 'kept', 0, 7)`);
  migrate(db);
  const old = new FamilyStore(db);
  const message = old.history(null, 10).messages[0];
  assert.equal(message?.body, 'kept');
  assert.equal(message?.sentRev, 7);
  assert.deepEqual(message?.reactions, []);
  // A row the previous server writes during a deploy has no sent_rev: its rev stands in.
  db.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev)
           VALUES (1, 'c2', 'overlap', 0, 8)`);
  assert.equal(old.history(null, 10).messages[1]?.sentRev, 8);
  assert.equal(SCHEMA_VERSION, 8);
});

test('the hot queries use indexes, never a scan of every message', () => {
  const plan = (sql: string, ...args: (number | string)[]): string =>
    (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
      .map((row) => row.detail)
      .join(' | ');
  // The orphan cleanup, unread counts and read stamping, as store.ts runs them.
  const orphans = plan(
    `SELECT id FROM images WHERE created_at < ?
     AND NOT EXISTS (SELECT 1 FROM messages WHERE image_id = images.id)`,
    0,
  );
  assert.match(orphans, /messages_image/);
  const unread = plan(
    `SELECT COUNT(*) AS n FROM messages m JOIN users u ON u.id = ?
     WHERE m.rev > u.last_read_rev AND coalesce(m.sent_rev, m.rev) > u.last_read_rev
       AND m.user_id != u.id AND m.deleted_at IS NULL AND m.unsent_at IS NULL`,
    1,
  );
  assert.doesNotMatch(unread, /SCAN m\b/);
  const stamp = plan(
    `SELECT id FROM messages WHERE rev > ? AND coalesce(sent_rev, rev) > ?
     AND coalesce(sent_rev, rev) <= ? AND user_id <> ?`,
    1,
    1,
    2,
    3,
  );
  assert.doesNotMatch(stamp, /SCAN messages/);
});
