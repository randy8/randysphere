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
