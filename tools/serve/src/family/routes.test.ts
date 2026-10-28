import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { FamilyChat } from './routes.ts';

let chat: FamilyChat;
let server: Server;
let base: string;
let host: string;
let momCookie: string;
let randyCookie: string;
let dadCookie: string;

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
  chat = new FamilyChat({ dataDir: mkdtempSync(join(tmpdir(), 'family-routes-')) });
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
    chat
      .handle(req, res, new URL(req.url ?? '/', 'http://localhost'))
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
