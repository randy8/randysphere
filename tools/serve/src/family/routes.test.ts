import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { DISC } from './chats.ts';
import type { Fetcher, OutboundResponse } from './outbound.ts';
import { FamilyChat } from './routes.ts';

let chat: FamilyChat;
/** The other chat, on the same server: it must share nothing with the family's. */
let disc: FamilyChat;
let server: Server;
let base: string;
let host: string;
let momCookie: string;
let randyCookie: string;
let dadCookie: string;
let dataDir: string;

/** What the stand-in push service received, and what it answers per endpoint. */
const pushed: { endpoint: string; body: Buffer; headers: Record<string, string> }[] = [];
const pushAnswers = new Map<string, number>();
const pushFetch: typeof fetch = async (url, init) => {
  const endpoint = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
  pushed.push({
    endpoint,
    body: Buffer.from(init?.body as Uint8Array),
    headers: init?.headers as Record<string, string>,
  });
  return Promise.resolve(new Response(null, { status: pushAnswers.get(endpoint) ?? 201 }));
};

/** The sites link previews come from, stood in for: each test says what they answer. */
let previewAnswer: Fetcher = () => Promise.reject(new Error('no network in tests'));
const previewFetch: Fetcher = (url, options) => previewAnswer(url, options);
const answer = (
  status: number,
  body: string | Buffer,
  contentType = 'text/html',
): OutboundResponse => ({
  status,
  contentType,
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  url: '',
});
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);

/** A browser's side of a push subscription: its keys, and decryption (RFC 8291). */
function device(name: string): {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  read: (body: Buffer) => Record<string, unknown>;
} {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const subscription = {
    endpoint: `https://web.push.apple.com/${name}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
  const read = (body: Buffer): Record<string, unknown> => {
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 21 + body.readUInt8(20));
    const secret = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
    const derive = (label: string, length: number): Buffer =>
      Buffer.from(
        hkdfSync('sha256', ikm, salt, Buffer.from(`Content-Encoding: ${label}\0`), length),
      );
    const sealed = body.subarray(21 + asPublic.length);
    const decipher = createDecipheriv('aes-128-gcm', derive('aes128gcm', 16), derive('nonce', 12));
    decipher.setAuthTag(sealed.subarray(-16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 0x02);
    return JSON.parse(plain.subarray(0, -1).toString('utf8')) as Record<string, unknown>;
  };
  return { subscription, read };
}

/** Lets the notifier's fire-and-forget sends finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

async function call(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    json?: unknown;
    form?: Record<string, string>;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: base, ...options.headers };
  if (options.cookie) headers['cookie'] = options.cookie;
  let body: string | Buffer | undefined = options.body;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  return fetch(`${base}${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    redirect: 'manual',
  });
}

async function signIn(username: string, password: string): Promise<string> {
  const response = await call('/family/login', { form: { username, password } });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(
    cookie,
    /^family_session=[\w-]+; Path=\/family; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
  );
  return cookie.split(';')[0] ?? '';
}

/** Opens the event stream and collects its events until `done` says stop. */
function stream(
  cookie: string,
  headers: Record<string, string> = {},
  query = '',
): Promise<{
  res: IncomingMessage;
  events: { event: string; id: string; data: unknown }[];
  next: (event: string) => Promise<{ id: string; data: unknown }>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${base}/family/api/events${query}`,
      { headers: { cookie, ...headers } },
      (res) => {
        const events: { event: string; id: string; data: unknown }[] = [];
        const waiters: {
          event: string;
          resolve: (value: { id: string; data: unknown }) => void;
        }[] = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let at;
          while ((at = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            let event = 'message';
            let id = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data === '') continue;
            const parsed = { event, id, data: JSON.parse(data) as unknown };
            const waiter = waiters.findIndex((w) => w.event === event);
            if (waiter !== -1) waiters.splice(waiter, 1)[0]?.resolve(parsed);
            else events.push(parsed);
          }
        });
        resolve({
          res,
          events,
          next: (event) => {
            const queued = events.findIndex((e) => e.event === event);
            if (queued !== -1)
              return Promise.resolve(events.splice(queued, 1)[0] as { id: string; data: unknown });
            return new Promise((done, fail) => {
              waiters.push({ event, resolve: done });
              setTimeout(() => fail(new Error(`no ${event} event`)), 3000).unref();
            });
          },
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'family-routes-'));
  chat = new FamilyChat({ dataDir, pushFetch, previewFetch });
  disc = new FamilyChat({
    chat: DISC,
    dataDir: mkdtempSync(join(tmpdir(), 'disc-routes-')),
    pushFetch,
  });
  await Promise.all([
    chat.store.createUser({
      username: 'mom',
      displayName: '妈妈',
      password: 'correct horse',
      lang: 'zh',
    }),
    chat.store.createUser({
      username: 'randy',
      displayName: 'Randy',
      password: 'battery staple',
      isAdmin: true,
    }),
    chat.store.createUser({ username: 'dad', displayName: 'Dad', password: 'another password' }),
  ]);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    chat
      .handle(req, res, url)
      .then(async (handled) => handled || disc.handle(req, res, url))
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  base = `http://${host}`;
  [momCookie, randyCookie, dadCookie] = await Promise.all([
    signIn('mom', 'correct horse'),
    signIn('randy', 'battery staple'),
    signIn('dad', 'another password'),
  ]);
});

after(async () => {
  chat.shutdown();
  disc.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('signed out, the chat is only a sign-in screen, unindexed and uncached', async () => {
  chat.store.postMessage({ userId: 1, clientId: 'secret-0001', body: 'a private thing' });
  const response = await call('/family/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /action="\/family\/login"/);
  assert.ok(!html.includes('a private thing'));
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(response.headers.get('content-security-policy') ?? '', /script-src 'self'/);
});

test('every private endpoint refuses a visitor with no session, or a forged one', async () => {
  const imageId = chat.store.addImage({
    userId: 1,
    mime: 'image/png',
    bytes: 1,
    width: 1,
    height: 1,
  });
  const paths: [string, string][] = [
    ['GET', '/family/api/history'],
    ['GET', '/family/api/events'],
    ['POST', '/family/api/messages'],
    ['DELETE', '/family/api/messages/1'],
    ['POST', '/family/api/images'],
    ['GET', `/family/images/${imageId}`],
    ['POST', '/family/api/typing'],
    ['POST', '/family/api/read'],
  ];
  for (const cookie of [undefined, 'family_session=forged-token-value']) {
    for (const [method, path] of paths) {
      const response = await call(path, { method, ...(cookie ? { cookie } : {}) });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.ok(!(await response.text()).includes('private thing'));
    }
    // The members page doesn't admit to existing.
    assert.equal((await call('/family/admin', cookie ? { cookie } : {})).status, 404);
  }
});

test('a wrong password says so discreetly; five in a row lock that name out', async () => {
  // A guesser of its own (CF-Connecting-IP is believed from loopback, as from cloudflared).
  const guesser = { 'cf-connecting-ip': '203.0.113.9' };
  const wrong = await call('/family/login', {
    form: { username: 'grandpa', password: 'nope nope' },
    headers: guesser,
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.match(await wrong.text(), /Incorrect username or password/);
  for (let i = 0; i < 4; i += 1) {
    await call('/family/login', {
      form: { username: 'grandpa', password: 'nope' },
      headers: guesser,
    });
  }
  // Locked from that address, whoever it tries…
  const locked = await call('/family/login', {
    form: { username: 'mom', password: 'correct horse' },
    headers: guesser,
  });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  // …and that name is locked from anywhere, so spreading guesses across addresses doesn't help.
  const elsewhere = await call('/family/login', {
    form: { username: 'grandpa', password: 'nope' },
    headers: { 'cf-connecting-ip': '198.51.100.4' },
  });
  assert.equal(elsewhere.status, 429);
  // Everyone else signs in as usual.
  assert.equal(
    (await call('/family/login', { form: { username: 'mom', password: 'correct horse' } })).status,
    303,
  );
});

test('signed in, the page is the conversation, and message text is escaped', async () => {
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'xss-000001', body: '<img src=x onerror=alert(1)>' },
  });
  const html = await (await call('/family/', { cookie: dadCookie })).text();
  assert.match(html, /data-messages/);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<img src=x'));
});

test('the author is whoever is signed in, whatever the request claims', async () => {
  const response = await call('/family/api/messages', {
    cookie: dadCookie,
    json: { clientId: 'imperson-01', body: 'I am mom', userId: 1, user_id: 1, author: 'mom' },
  });
  const { message } = (await response.json()) as { message: { userId: number } };
  assert.equal(response.status, 201);
  assert.equal(message.userId, chat.store.findUserByUsername('dad')?.id);
});

test('a retried send returns the original message instead of a duplicate', async () => {
  const send = (): Promise<Response> =>
    call('/family/api/messages', {
      cookie: momCookie,
      json: { clientId: 'twice-00001', body: '饺子好了' },
    });
  const [a, b] = await Promise.all([send(), send()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 201]);
  const ids = await Promise.all(
    [a, b].map(async (r) => ((await r.json()) as { message: { id: number } }).message.id),
  );
  assert.equal(ids[0], ids[1]);
});

test('a request from another site is refused, even with a valid session', async () => {
  const response = await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'csrf-000001', body: 'forged' },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
  const form = await call('/family/admin/create', {
    cookie: randyCookie,
    form: { username: 'intruder', displayName: 'x', password: 'whatever123' },
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(form.status, 403);
  assert.equal(chat.store.findUserByUsername('intruder'), null);
});

test('messages reach everyone else live, and a reconnect replays what it missed', async () => {
  const dad = await stream(dadCookie);
  const hello = await dad.next('hello');
  const startRev = (hello.data as { rev: number }).rev;

  const sent = (await (
    await call('/family/api/messages', {
      cookie: momCookie,
      json: { clientId: 'live-000001', body: '吃了吗？' },
    })
  ).json()) as { message: { id: number; rev: number } };
  const live = await dad.next('message');
  assert.equal((live.data as { body: string }).body, '吃了吗？');
  assert.equal(live.id, String(sent.message.rev));
  dad.close();

  // While dad is away: one new message, one deletion.
  const missed = (await (
    await call('/family/api/messages', {
      cookie: momCookie,
      json: { clientId: 'live-000002', body: '在吗' },
    })
  ).json()) as { message: { id: number } };
  await call(`/family/api/messages/${String(sent.message.id)}`, {
    method: 'DELETE',
    cookie: momCookie,
  });

  const back = await stream(dadCookie, { 'last-event-id': String(sent.message.rev) });
  await back.next('hello');
  assert.equal(((await back.next('message')).data as { id: number }).id, missed.message.id);
  assert.equal(((await back.next('delete')).data as { id: number }).id, sent.message.id);
  back.close();

  // ?after= works for a first connection, too.
  const fresh = await stream(dadCookie, {}, `?after=${String(startRev)}`);
  await fresh.next('hello');
  assert.ok(fresh.events.length > 0 || (await fresh.next('message')));
  fresh.close();
});

test('only the author or an admin can delete; the deletion reaches open streams', async () => {
  const { message } = (await (
    await call('/family/api/messages', {
      cookie: momCookie,
      json: { clientId: 'delete-0001', body: 'typo' },
    })
  ).json()) as { message: { id: number } };
  assert.equal(
    (
      await call(`/family/api/messages/${String(message.id)}`, {
        method: 'DELETE',
        cookie: dadCookie,
      })
    ).status,
    400,
  );
  const mom = await stream(momCookie);
  await mom.next('hello');
  assert.equal(
    (
      await call(`/family/api/messages/${String(message.id)}`, {
        method: 'DELETE',
        cookie: randyCookie,
      })
    ).status,
    200,
  );
  assert.equal(((await mom.next('delete')).data as { id: number }).id, message.id);
  mom.close();
});

test('photos: only real images are accepted, and only members can see them', async () => {
  const notImage = await call('/family/api/images?w=10&h=10', {
    cookie: momCookie,
    body: Buffer.from('<svg onload=alert(1)>'),
    headers: { 'content-type': 'image/jpeg' },
  });
  assert.equal(notImage.status, 415);

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const upload = await call('/family/api/images?w=1200&h=900', {
    cookie: momCookie,
    body: jpeg,
    headers: { 'content-type': 'text/html' },
  });
  assert.equal(upload.status, 201);
  const { imageId } = (await upload.json()) as { imageId: string };

  const seen = await call(`/family/images/${imageId}`, { cookie: dadCookie });
  assert.equal(seen.status, 200);
  assert.equal(seen.headers.get('content-type'), 'image/jpeg');
  assert.equal(seen.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await seen.arrayBuffer()), jpeg);

  assert.equal((await call(`/family/images/${imageId}`)).status, 401);
  assert.equal((await call('/family/images/..%2F..%2Fchat.db', { cookie: dadCookie })).status, 404);
  assert.equal((await call('/family/images/../chat.db', { cookie: dadCookie })).status, 404);
});

test('a revoked member is signed out, open streams included', async () => {
  const cookie = await signIn('dad', 'another password');
  const dad = await stream(cookie);
  await dad.next('hello');
  const revoke = await call('/family/admin/revoke', {
    cookie: randyCookie,
    form: { id: String(chat.store.findUserByUsername('dad')?.id) },
  });
  assert.equal(revoke.status, 303);
  await dad.next('signed-out');
  assert.equal((await call('/family/api/history', { cookie })).status, 401);
  dadCookie = await signIn('dad', 'another password');
});

test('the members page: admins only; it creates accounts and resets passwords', async () => {
  assert.equal((await call('/family/admin', { cookie: momCookie })).status, 404);
  const page = await call('/family/admin', { cookie: randyCookie });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('妈妈'));

  const created = await call('/family/admin/create', {
    cookie: randyCookie,
    form: { username: 'jiejie', displayName: '姐姐', password: 'sister pw 1', lang: 'zh' },
  });
  assert.equal(created.status, 303);
  assert.match(decodeURIComponent(created.headers.get('location') ?? ''), /Added 姐姐/);
  const user = chat.store.findUserByUsername('jiejie');
  assert.equal(user?.displayName, '姐姐');
  assert.equal(user?.lang, 'zh');

  const reset = await call('/family/admin/password', {
    cookie: randyCookie,
    form: { id: String(user?.id), password: 'sister pw 2' },
  });
  assert.equal(reset.status, 303);
  assert.ok(await chat.store.authenticate('jiejie', 'sister pw 2'));
});

test('signing out ends the session on the server, not only in the browser', async () => {
  const cookie = await signIn('mom', 'correct horse');
  const out = await call('/family/logout', { method: 'POST', cookie });
  assert.equal(out.status, 303);
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal((await call('/family/api/history', { cookie })).status, 401);
  assert.equal((await call('/family/api/history', { cookie: momCookie })).status, 200);
});

test('without JavaScript, the form posts a message and returns to the page', async () => {
  const response = await call('/family/send', {
    cookie: momCookie,
    form: { clientId: 'nojs-1-12345678', body: '没有脚本也能发' },
  });
  assert.equal(response.status, 303);
  assert.ok(
    (await (await call('/family/', { cookie: momCookie })).text()).includes('没有脚本也能发'),
  );
});

test('static files are public and versioned; nothing else under /family/static is', async () => {
  const page = await (await call('/family/')).text();
  const css = /href="(\/family\/static\/family\.css\?v=[0-9a-f]+)"/.exec(page)?.[1] ?? '';
  const response = await call(css);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.notEqual((await call('/family/static/../store.ts')).status, 200);
  assert.equal((await call('/family/static/..%2Fstore.ts')).status, 404);
  assert.equal((await call('/family/static/chat.db')).status, 404);
  assert.ok(host.length > 0);
});

test('plain HTTP through the tunnel is sent to HTTPS before anything else happens', async () => {
  const response = await call('/family/api/history?x=1', {
    cookie: momCookie,
    headers: { 'x-forwarded-proto': 'http' },
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), `https://${host}/family/api/history?x=1`);
  const https = await call('/family/api/history', {
    cookie: momCookie,
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(https.status, 200);
});

test('notifications: a device subscribes; everyone but the author is told, generically by default', async () => {
  const phone = device('dad-phone');
  // Only a real push service's address, with real keys.
  for (const bad of [
    { ...phone.subscription, endpoint: 'https://127.0.0.1/family/' },
    { ...phone.subscription, endpoint: 'http://web.push.apple.com/x' },
    { ...phone.subscription, keys: { p256dh: 'AAAA', auth: 'BBBB' } },
  ]) {
    assert.equal((await call('/family/api/push', { cookie: dadCookie, json: bad })).status, 400);
  }
  assert.equal(
    (await call('/family/api/push', { cookie: dadCookie, json: phone.subscription })).status,
    200,
  );
  const state = (await (await call('/family/api/push', { cookie: dadCookie })).json()) as {
    subscribed: boolean;
    publicKey: string;
    preview: boolean;
  };
  assert.equal(state.subscribed, true);
  assert.equal(state.preview, false);
  assert.match(state.publicKey, /^[\w-]{87}$/);
  // Mom's own device (another session) isn't subscribed: not her business.
  assert.equal(
    (
      (await (await call('/family/api/push', { cookie: momCookie })).json()) as {
        subscribed: boolean;
      }
    ).subscribed,
    false,
  );

  pushed.length = 0;
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'push-0000001', body: '晚饭好了' },
  });
  await settle();
  const toDad = pushed.filter((p) => p.endpoint === phone.subscription.endpoint);
  assert.equal(toDad.length, 1);
  assert.equal(toDad[0]?.headers['content-encoding'], 'aes128gcm');
  assert.equal(toDad[0]?.headers['topic'], 'family');
  const payload = phone.read(toDad[0]?.body ?? Buffer.alloc(0));
  assert.equal(payload['body'], 'New message');
  assert.equal(payload['title'], 'Family');
  assert.ok(!JSON.stringify(payload).includes('晚饭'), 'no message text without Preview');
  assert.ok(Number(payload['badge']) >= 1);

  // Preview on: the sender's name and the text, still encrypted end to end.
  await call('/family/api/push', {
    cookie: dadCookie,
    json: { ...phone.subscription, preview: true },
  });
  pushed.length = 0;
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'push-0000002', body: '快回来吃饭' },
  });
  await settle();
  const preview = phone.read(
    pushed.find((p) => p.endpoint === phone.subscription.endpoint)?.body ?? Buffer.alloc(0),
  );
  assert.equal(preview['title'], '妈妈');
  assert.equal(preview['body'], '快回来吃饭');
  assert.ok(
    !toDad[0]?.body.includes(Buffer.from('快回来')),
    'the push service sees ciphertext only',
  );

  // The author's own devices are never notified of their own message.
  pushed.length = 0;
  await call('/family/api/messages', {
    cookie: dadCookie,
    json: { clientId: 'push-0000003', body: 'coming' },
  });
  await settle();
  assert.equal(pushed.filter((p) => p.endpoint === phone.subscription.endpoint).length, 0);
});

test('notifications: not while the conversation is on screen; again once it is put away', async () => {
  const phone = device('randy-phone');
  await call('/family/api/push', { cookie: randyCookie, json: phone.subscription });
  const open = await stream(randyCookie);
  const hello = (await open.next('hello')).data as { stream: number };
  const toRandy = (): number =>
    pushed.filter((p) => p.endpoint === phone.subscription.endpoint).length;

  pushed.length = 0;
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'seen-0000001', body: 'a' },
  });
  await settle();
  assert.equal(toRandy(), 0, 'reading it already');

  // Someone else can't claim his stream is hidden (or visible).
  await call('/family/api/presence', {
    cookie: dadCookie,
    json: { stream: hello.stream, visible: false },
  });
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'seen-0000002', body: 'b' },
  });
  await settle();
  assert.equal(toRandy(), 0);

  await call('/family/api/presence', {
    cookie: randyCookie,
    json: { stream: hello.stream, visible: false },
  });
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'seen-0000003', body: 'c' },
  });
  await settle();
  assert.equal(toRandy(), 1, 'tab hidden: notified');
  open.close();
});

test('notifications: an expired subscription is forgotten; signing out stops that device', async () => {
  const old = device('dad-old-tablet');
  await call('/family/api/push', { cookie: dadCookie, json: old.subscription });
  pushAnswers.set(old.subscription.endpoint, 410);
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'gone-0000001', body: 'x' },
  });
  await settle();
  const rows = chat.store.db
    .prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint = ?')
    .all(old.subscription.endpoint);
  assert.equal(rows.length, 0);

  // A sign-in of its own, subscribed, then signed out: the subscription goes with it.
  const laptop = await signIn('mom', 'correct horse');
  const mac = device('mom-mac');
  await call('/family/api/push', { cookie: laptop, json: mac.subscription });
  assert.equal(chat.store.pushDeviceCount(chat.store.findUserByUsername('mom')?.id ?? 0), 1);
  await call('/family/logout', { cookie: laptop, form: {} });
  assert.equal(chat.store.pushDeviceCount(chat.store.findUserByUsername('mom')?.id ?? 0), 0);
});

test('notifications: a test reaches only this device, and is rate limited', async () => {
  const phone = device('dad-test');
  const own = await signIn('dad', 'another password');
  assert.equal((await call('/family/api/push/test', { cookie: own, form: {} })).status, 404);
  await call('/family/api/push', { cookie: own, json: phone.subscription });
  pushed.length = 0;
  assert.equal((await call('/family/api/push/test', { cookie: own, json: {} })).status, 200);
  assert.deepEqual(
    pushed.map((p) => p.endpoint),
    [phone.subscription.endpoint],
  );
  assert.equal(phone.read(pushed[0]?.body ?? Buffer.alloc(0))['body'], 'Notifications are on.');
  await call('/family/api/push/test', { cookie: own, json: {} });
  await call('/family/api/push/test', { cookie: own, json: {} });
  assert.equal((await call('/family/api/push/test', { cookie: own, json: {} })).status, 429);
});

test('a page from a replaced database, or ahead of this one, starts over instead of replaying', async () => {
  const history = (await (await call('/family/api/history', { cookie: dadCookie })).json()) as {
    rev: number;
    epoch: number;
  };
  const same = await stream(
    dadCookie,
    {},
    `?after=${String(history.rev)}&epoch=${String(history.epoch)}`,
  );
  const hello = (await same.next('hello')).data as { epoch: number; stream: number };
  assert.equal(hello.epoch, history.epoch);
  assert.ok(hello.stream > 0);
  await settle();
  assert.ok(!same.events.some((e) => e.event === 'reset'));
  same.close();

  const restored = await stream(dadCookie, {}, `?after=${String(history.rev)}&epoch=12345`);
  await restored.next('reset');
  restored.close();
  const ahead = await stream(dadCookie, { 'last-event-id': String(history.rev + 1000) });
  await ahead.next('reset');
  ahead.close();
});

test('the service worker and manifest: served at the chat’s scope, never cached stale', async () => {
  const worker = await call('/family/sw.js');
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.match(worker.headers.get('content-type') ?? '', /javascript/);
  const source = await worker.text();
  assert.match(source, /addEventListener\('push'/);
  assert.ok(!/addEventListener\('fetch'/.test(source), 'it caches nothing');
  const manifest = (await (await call('/family/manifest.webmanifest')).json()) as {
    scope: string;
    icons: { sizes: string; purpose?: string }[];
  };
  assert.equal(manifest.scope, '/family/');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.equal((await call((icon as unknown as { src: string }).src)).status, 200);
  }
});

test('the page’s modules import each other at one shared version, and are preloaded', async () => {
  const page = await (await call('/family/', { cookie: momCookie })).text();
  const main = /src="(\/family\/static\/chat\.js\?v=([0-9a-f]+))"/.exec(page);
  assert.ok(main);
  const version = main[2] ?? '';
  assert.match(
    page,
    new RegExp(`rel="modulepreload" href="/family/static/sheet\\.js\\?v=${version}"`),
  );
  const script = await (await call(main[1] ?? '')).text();
  assert.match(script, new RegExp(`from '\\./sheet\\.js\\?v=${version}'`));
  assert.ok(!/from '\.\/[\w-]+\.js'/.test(script), 'no unversioned import left');
});

test('a photo uploaded but never sent is removed after a day', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = (await (
    await call('/family/api/images?w=1&h=1', {
      cookie: momCookie,
      body: png,
      headers: { 'content-type': 'image/png' },
    })
  ).json()) as { imageId: string };
  const sentUpload = (await (
    await call('/family/api/images?w=1&h=1', {
      cookie: momCookie,
      body: png,
      headers: { 'content-type': 'image/png' },
    })
  ).json()) as { imageId: string };
  await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'orphan-00001', body: '', imageId: sentUpload.imageId },
  });
  assert.equal(await chat.removeOrphans(Date.now()), 0, 'not yet: the message may still be coming');
  assert.ok((await chat.removeOrphans(Date.now() + 25 * 3600 * 1000)) >= 1);
  assert.equal((await call(`/family/images/${upload.imageId}`, { cookie: momCookie })).status, 404);
  assert.ok(!existsSync(join(dataDir, 'images', upload.imageId)));
  assert.equal(
    (await call(`/family/images/${sentUpload.imageId}`, { cookie: momCookie })).status,
    200,
  );
});

test('a broadcast racing a stream that was just ended is dropped, not a crash', async () => {
  const open = await stream(dadCookie);
  await open.next('hello');
  for (const connection of chat.hub.connections()) connection.res.end();
  // Before 'close' arrives: the old code wrote after end, an unhandled 'error'.
  chat.hub.broadcast('typing', { userId: 1 });
  chat.hub.heartbeat();
  await settle();
  open.close();
});

test('Disc is a chat of its own at /disc/: its own accounts and cookie, and no way to Family', async () => {
  await disc.store.createUser({
    username: 'randy',
    displayName: 'Randy',
    password: 'disc password',
  });
  // The family's sign-in means nothing here, under either cookie name.
  const familyToken = randyCookie.split('=')[1] ?? '';
  for (const cookie of [randyCookie, `disc_session=${familyToken}`]) {
    assert.equal((await call('/disc/api/history', { cookie })).status, 401);
    assert.match(await (await call('/disc/', { cookie })).text(), /action="\/disc\/login"/);
  }
  // Disc's accounts are its own: the family password doesn't open it.
  const refused = await call('/disc/login', {
    form: { username: 'randy', password: 'battery staple' },
  });
  assert.ok(!(refused.headers.get('set-cookie') ?? '').includes('disc_session=ey'));
  const response = await call('/disc/login', {
    form: { username: 'randy', password: 'disc password' },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/disc/');
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^disc_session=[\w-]+; Path=\/disc; /);
  const discCookie = setCookie.split(';')[0] ?? '';
  // …and its sign-in, in turn, opens nothing of the family's.
  const discToken = discCookie.split('=')[1] ?? '';
  assert.equal(
    (await call('/family/api/history', { cookie: `family_session=${discToken}` })).status,
    401,
  );

  // A message there stays there.
  const sent = await call('/disc/api/messages', {
    cookie: discCookie,
    json: { clientId: 'disc-00000001', body: 'Saturday at the course?' },
  });
  assert.equal(sent.status, 201);
  const familyHistory = (await (
    await call('/family/api/history', { cookie: randyCookie })
  ).json()) as {
    messages: { body: string }[];
  };
  assert.ok(!familyHistory.messages.some((m) => m.body === 'Saturday at the course?'));

  // The page names Disc, and nothing on it leads to /family.
  const html = await (await call('/disc/', { cookie: discCookie })).text();
  assert.match(html, /<title>Disc<\/title>/);
  assert.match(html, /Saturday at the course\?/);
  assert.doesNotMatch(html, /["'`]\/family\b/, 'the Disc page links to Family');
  assert.match(html, /"base":"\/disc"/);
  const manifest = (await (await call('/disc/manifest.webmanifest')).json()) as Record<
    string,
    string
  >;
  assert.equal(manifest['name'], 'Disc');
  assert.equal(manifest['scope'], '/disc/');
});

test('a starter password: offered the chance to choose another once, never required', async () => {
  await disc.store.createUser({
    username: 'chris',
    displayName: 'Chris',
    password: 'chris',
    suggestNewPassword: true,
  });
  const signInAs = async (
    password: string,
  ): Promise<{ status: number; to: string; cookie: string }> => {
    const response = await call('/disc/login', { form: { username: 'chris', password } });
    return {
      status: response.status,
      to: response.headers.get('location') ?? '',
      cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    };
  };
  const first = await signInAs('chris');
  assert.equal(first.to, '/disc/password');
  const page = await (await call('/disc/password', { cookie: first.cookie })).text();
  assert.match(page, /starter password/);
  assert.match(page, /Not Now/);

  // "Not Now": the next sign-in goes straight to the chat.
  assert.equal(
    (await call('/disc/password/keep', { method: 'POST', cookie: first.cookie })).status,
    303,
  );
  assert.equal((await signInAs('chris')).to, '/disc/');

  // Choosing one (from the menu): too short is refused and says why…
  const other = await signInAs('chris');
  const short = await call('/disc/password', { cookie: first.cookie, form: { password: 'short' } });
  assert.equal(short.status, 400);
  assert.match(await short.text(), /at least 8/);
  // …a good one keeps this device signed in and signs out the others.
  const changed = await call('/disc/password', {
    cookie: first.cookie,
    form: { password: 'a better one' },
  });
  assert.equal(changed.status, 303);
  assert.equal((await call('/disc/api/history', { cookie: first.cookie })).status, 200);
  assert.equal((await call('/disc/api/history', { cookie: other.cookie })).status, 401);
  assert.equal((await signInAs('chris')).status, 401);
  assert.equal((await signInAs('a better one')).to, '/disc/');
  // Signed out, the page is the sign-in screen's.
  assert.equal((await call('/disc/password')).headers.get('location'), '/disc/');
});

test('search finds this chat’s messages only, never deleted ones, and works signed in only', async () => {
  chat.store.postMessage({ userId: 1, clientId: 'search-00001', body: 'Frisbee golf at noon?' });
  const gone = chat.store.postMessage({
    userId: 1,
    clientId: 'search-00002',
    body: 'frisbee secret',
  });
  chat.store.deleteMessage(chat.store.requireUser(1), gone.message.id);
  const discRandy = await call('/disc/login', {
    form: { username: 'randy', password: 'disc password' },
  });
  const discCookie = (discRandy.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  await call('/disc/api/messages', {
    cookie: discCookie,
    json: { clientId: 'disc-search-01', body: 'frisbee in Disc only' },
  });

  const html = await (await call('/family/search?q=FRISBEE', { cookie: randyCookie })).text();
  assert.match(html, /<mark>Frisbee<\/mark> golf at noon\?/);
  assert.ok(!html.includes('secret'), 'a deleted message was found');
  assert.ok(!html.includes('in Disc only'), 'another chat’s message was found');
  assert.match(html, /href="\/family\/#m\d+"/);

  const disc = await (await call('/disc/search?q=frisbee', { cookie: discCookie })).text();
  assert.match(disc, /<mark>frisbee<\/mark> in Disc only/);
  assert.ok(!disc.includes('golf at noon'));
  // A LIKE wildcard is searched for, not obeyed.
  assert.match(
    await (await call('/family/search?q=%25', { cookie: randyCookie })).text(),
    /No messages found/,
  );
  // Signed out (or signed in to the other chat): the sign-in screen, no results.
  assert.equal((await call('/disc/search?q=frisbee')).headers.get('location'), '/disc/');
  assert.equal(
    (await call('/disc/search?q=frisbee', { cookie: randyCookie })).headers.get('location'),
    '/disc/',
  );
});

test('read receipts: a read is announced live, and Info is the author’s alone', async () => {
  const open = await stream(randyCookie);
  await open.next('hello');
  const posted = (await (
    await call('/family/api/messages', {
      cookie: randyCookie,
      json: { clientId: 'receipt-route-1', body: 'did you see this?' },
    })
  ).json()) as { message: { id: number; rev: number } };
  await call('/family/api/read', { cookie: momCookie, json: { rev: posted.message.rev } });
  const read = await open.next('read');
  const mom = chat.store.findUserByUsername('mom');
  assert.deepEqual(read.data, { userId: mom?.id, rev: posted.message.rev });
  open.close();

  const info = await call(`/family/api/messages/${String(posted.message.id)}/receipts`, {
    cookie: randyCookie,
  });
  assert.equal(info.status, 200);
  const receipts = (await info.json()) as { read: { userId: number; at: number | null }[] };
  assert.ok(receipts.read.some((r) => r.userId === mom?.id && typeof r.at === 'number'));
  // Not the author: as if there were nothing there.
  assert.equal(
    (
      await call(`/family/api/messages/${String(posted.message.id)}/receipts`, {
        cookie: momCookie,
      })
    ).status,
    404,
  );
  // Members carry how far each has read, for the line under the newest message.
  const history = (await (await call('/family/api/history', { cookie: randyCookie })).json()) as {
    members: { id: number; lastReadRev: number }[];
  };
  assert.ok(
    (history.members.find((m) => m.id === mom?.id)?.lastReadRev ?? 0) >= posted.message.rev,
  );
});

test('edit, undo send and tapbacks: own messages only, live to every open page', async () => {
  const open = await stream(momCookie);
  await open.next('hello');
  const send = async (clientId: string, body: string): Promise<{ id: number; rev: number }> =>
    (
      (await (
        await call('/family/api/messages', { cookie: dadCookie, json: { clientId, body } })
      ).json()) as { message: { id: number; rev: number } }
    ).message;
  const posted = await send('change-route-1', 'see you at 5');
  await open.next('message');
  const path = `/family/api/messages/${String(posted.id)}`;

  assert.equal(
    (await call(path, { method: 'PATCH', cookie: momCookie, json: { body: 'hacked' } })).status,
    400,
  );
  const edited = await call(path, { method: 'PATCH', cookie: dadCookie, json: { body: 'at 6' } });
  assert.equal(edited.status, 200);
  const update = await open.next('update');
  const live = update.data as { body: string; edits: { body: string }[]; rev: number };
  assert.equal(live.body, 'at 6');
  assert.deepEqual(
    live.edits.map((e) => e.body),
    ['see you at 5'],
  );
  assert.equal(update.id, String(live.rev));

  assert.equal(
    (await call(`${path}/reaction`, { cookie: momCookie, json: { emoji: 'wave' } })).status,
    400,
  );
  await call(`${path}/reaction`, { cookie: momCookie, json: { emoji: '🦖', on: true } });
  const reacted = (await open.next('update')).data as { reactions: { emoji: string }[] };
  assert.deepEqual(
    reacted.reactions.map((r) => r.emoji),
    ['🦖'],
  );
  open.close();

  // A page that missed it all gets the changes as updates, not as new messages.
  const replay = await stream(momCookie, {}, `?after=${String(posted.rev)}`);
  await replay.next('hello');
  assert.ok(((await replay.next('update')).data as { id: number }).id === posted.id);
  replay.close();

  assert.equal((await call(`${path}/unsend`, { cookie: momCookie, json: {} })).status, 400);
  const unsent = await call(`${path}/unsend`, { cookie: dadCookie, json: {} });
  const gone = ((await unsent.json()) as { message: Record<string, unknown> }).message;
  assert.equal(gone['unsent'], true);
  assert.equal(gone['body'], '');
  const history = await (await call('/family/api/history', { cookie: momCookie })).text();
  assert.ok(!history.includes('at 6') && !history.includes('see you at 5'));
  const page = await (await call('/family/', { cookie: momCookie })).text();
  assert.match(page, /Dad撤回了一条信息/);
});

test('link previews: a Spotify link gets a card after delivery, never before; its artwork is private', async () => {
  const asked: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  // Released by the test below; this only keeps a failure from stalling the rest.
  setTimeout(() => release(), 5000).unref();
  previewAnswer = async (url, options) => {
    asked.push(url);
    // Every request is fenced to Spotify's own hosts.
    assert.equal(options.allowHost('open.spotify.com') || options.allowHost('i.scdn.co'), true);
    assert.equal(options.allowHost('localhost'), false);
    await held;
    if (url.startsWith('https://open.spotify.com/oembed?')) {
      return answer(
        200,
        JSON.stringify({
          title: 'Never Gonna Give You Up\u202e',
          thumbnail_url: 'https://i.scdn.co/image/abc',
          thumbnail_width: 300,
          thumbnail_height: 300,
        }),
        'application/json',
      );
    }
    if (url === 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT') {
      return answer(
        200,
        '<html><head><meta property="og:description" content="Rick Astley &amp; Co · Whenever You Need Somebody · Song · 1987"></head>',
      );
    }
    if (url === 'https://i.scdn.co/image/abc') return answer(200, JPEG, 'image/jpeg');
    return answer(404, '');
  };

  const dad = await stream(dadCookie);
  await dad.next('hello');
  const body =
    'listen <script>https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=abc123 and www.example.com/a?utm_source=x&id=2';
  const response = await call('/family/api/messages', {
    cookie: momCookie,
    json: { clientId: 'links-00001', body },
  });
  assert.equal(response.status, 201);
  const { message } = (await response.json()) as {
    message: {
      id: number;
      body: string;
      links: { raw: string; url: string; text: string; preview: unknown }[];
    };
  };
  // Stored as written; shown without the share id and tracking.
  assert.equal(message.body, body);
  assert.deepEqual(
    message.links.map((link) => [link.url, link.text, link.preview]),
    [
      [
        'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
        'open.spotify.com/track/4cOdK2wGLETKBW3P…',
        null,
      ],
      ['https://www.example.com/a?id=2', 'www.example.com/a?id=2', null],
    ],
  );
  assert.equal(((await dad.next('message')).data as { id: number }).id, message.id);

  release();
  const update = (await dad.next('update')).data as {
    id: number;
    links: {
      preview: { title: string; subtitle: string; kind: string; image: { id: string } } | null;
    }[];
  };
  assert.equal(update.id, message.id);
  const preview = update.links[0]?.preview;
  assert.ok(preview);
  assert.equal(preview.title, 'Never Gonna Give You Up');
  assert.equal(preview.subtitle, 'Rick Astley & Co');
  assert.equal(preview.kind, 'track');
  assert.equal(update.links[1]?.preview, null);
  dad.close();

  const art = await call(`/family/previews/${preview.image.id}`, { cookie: dadCookie });
  assert.equal(art.status, 200);
  assert.equal(art.headers.get('content-type'), 'image/jpeg');
  assert.match(art.headers.get('cache-control') ?? '', /^private/);
  assert.equal((await call(`/family/previews/${preview.image.id}`)).status, 401);
  assert.equal((await call(`/disc/previews/${preview.image.id}`)).status, 401);

  // Without JavaScript: the card, escaped, and the text's links cleaned.
  const page = await (await call('/family/', { cookie: dadCookie })).text();
  assert.match(
    page,
    /class="bubble link-card" data-provider="spotify" href="https:\/\/open.spotify.com\/track\/4cOdK2wGLETKBW3PvgPWqT"/,
  );
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /href="https:\/\/www.example.com\/a\?id=2"/);
  assert.doesNotMatch(page, /utm_source|si=abc123/);

  // Sent again: already known, so nothing is fetched.
  const before = asked.length;
  await call('/family/api/messages', {
    cookie: dadCookie,
    json: {
      clientId: 'links-00002',
      body: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
    },
  });
  await chat.previewer.idle();
  assert.equal(asked.length, before);
});

test('link previews: when Spotify has nothing, the link stays a plain link', async () => {
  previewAnswer = () => Promise.resolve(answer(404, ''));
  const response = await call('/family/api/messages', {
    cookie: momCookie,
    json: {
      clientId: 'links-00003',
      body: 'https://open.spotify.com/album/0000000000000000000000',
    },
  });
  const { message } = (await response.json()) as { message: { id: number } };
  await chat.previewer.idle();
  const stored = chat.store.requireMessage(message.id);
  assert.equal(stored.links[0]?.preview, null);
  assert.equal(chat.store.previewStatus(stored.links[0]?.url ?? '')?.status, 'failed');
});
