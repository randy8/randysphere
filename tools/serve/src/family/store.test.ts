import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { migrate, openDatabase } from './db.ts';
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

test('migration 3: every existing message, and how far each person had read, moves into Family', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, 2);
  db.exec(`INSERT INTO users (id, username, display_name, password_hash, created_at, last_read_rev)
           VALUES (1, 'mom', 'Mom', '!', 0, 2), (2, 'dad', 'Dad', '!', 0, 0)`);
  db.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev)
           VALUES (1, 'a-000001', 'one', 1, 1), (2, 'b-000001', 'two', 2, 2), (2, 'b-000002', 'three', 3, 3)`);
  db.exec("UPDATE meta SET value = 3 WHERE key = 'rev'");
  migrate(db);
  const old = new FamilyStore(db);
  assert.deepEqual(
    old.rooms().map((room) => room.slug),
    ['family', 'disc'],
  );
  assert.deepEqual(
    old.history(null, 10).messages.map((m) => [m.body, m.roomId]),
    [
      ['one', 1],
      ['two', 1],
      ['three', 1],
    ],
  );
  assert.equal(old.history(null, 10, 2).messages.length, 0);
  assert.equal(old.unreadCount(1), 1, 'mom had read up to rev 2; "three" is still new');
  assert.equal(old.unreadCount(2), 1, 'dad: only mom’s message counts');
  // A message naming no room still lands in Family: the previous server, mid-deploy.
  db.exec(`INSERT INTO messages (user_id, client_id, body, created_at, rev)
           VALUES (1, 'a-000002', 'four', 4, 4)`);
  assert.equal(old.getMessage(4)?.roomId, 1);
  assert.throws(() =>
    db.exec(`INSERT INTO messages (room_id, user_id, client_id, body, created_at, rev)
             VALUES (99, 1, 'a-000003', 'x', 5, 5)`),
  );
});

test('rooms keep their own history, replies and unread counts', () => {
  const disc = store.roomBySlug('disc');
  assert.ok(disc);
  const inFamily = store.postMessage({ userId: mom.id, clientId: 'rm-fam-001', body: 'family' });
  const inDisc = store.postMessage({
    userId: mom.id,
    roomId: disc.id,
    clientId: 'rm-disc-001',
    body: 'disc',
    // Quoting a message from another room: dropped, not carried across.
    replyTo: inFamily.message.id,
  });
  assert.equal(inDisc.message.replyTo, null);
  assert.ok(!store.history(null, 1000).messages.some((m) => m.id === inDisc.message.id));
  assert.deepEqual(
    store.history(null, 1000, disc.id).messages.map((m) => m.body),
    ['disc'],
  );
  const unread = store.unreadByRoom(dad.id);
  store.markRead(dad.id, store.currentRev(), disc.id);
  assert.equal(store.unreadByRoom(dad.id).get(disc.id), undefined);
  assert.equal(store.unreadByRoom(dad.id).get(1), unread.get(1));
  assert.equal(store.roomSummaries(dad.id).find((r) => r.id === disc.id)?.last?.body, 'disc');
  assert.throws(
    () => store.postMessage({ userId: mom.id, roomId: 404, clientId: 'rm-none-01', body: 'x' }),
    FamilyError,
  );
  const added = store.createRoom({ slug: 'cousins', name: 'Cousins' });
  assert.deepEqual(
    store.rooms().map((room) => room.slug),
    ['family', 'disc', 'cousins'],
  );
  assert.throws(() => store.createRoom({ slug: 'cousins', name: 'Again' }), FamilyError);
  assert.throws(() => store.createRoom({ slug: 'Bad Slug', name: 'x' }), FamilyError);
  assert.equal(store.getRoom(added.id)?.name, 'Cousins');
});
