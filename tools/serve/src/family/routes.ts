import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LoginLimiter, clientAddress } from '../login-limiter.ts';
import { openDatabase } from './db.ts';
import { Hub } from './hub.ts';
import { TokenBucket } from './limits.ts';
import { GROUP_NAME, renderAdmin, renderChat, renderLogin } from './pages.ts';
import type { Assets } from './pages.ts';
import { FamilyError, FamilyStore, SESSION_DAYS } from './store.ts';
import type { Lang, Message, User } from './store.ts';

const COOKIE = 'family_session';
const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url));

/**
 * The whole chat is first-party: no inline script, nothing from another
 * origin (which matters twice here — a message can't run code, and a page
 * opened from mainland China depends on no host that might be blocked).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': CSP,
};

const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

const IMAGE_TYPES: readonly (readonly [string, (b: Buffer) => boolean])[] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    'image/png',
    (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'image/webp',
    (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
];

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const PAGE_SIZE = 50;
const REPLAY_LIMIT = 500;

export interface FamilyConfig {
  /** private/family — chat.db and images/. Never read by the site build. */
  readonly dataDir: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/family; Max-Age=${String(SESSION_DAYS * 86400)}; HttpOnly; Secure; SameSite=Lax`;
}

const CLEAR_COOKIE = `${COOKIE}=; Path=/family; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'Too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) throw new HttpError(413, 'Too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }
  try {
    const value: unknown = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Falls through.
  }
  throw new HttpError(400, 'Bad JSON.');
}

/**
 * Cross-site request forgery: the cookie is SameSite=Lax, which already
 * keeps it off cross-site POSTs; this is the second lock. A browser always
 * says where a POST came from (Origin, or Sec-Fetch-Site); anything that
 * names another site is refused.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function arrivedOverHttp(req: IncomingMessage): boolean {
  return (
    LOOPBACK.has(req.socket.remoteAddress ?? '') &&
    req.headers['x-forwarded-proto'] === 'http' &&
    typeof req.headers.host === 'string' &&
    /^[a-z0-9.-]+(:\d+)?$/i.test(req.headers.host)
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...PRIVATE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...PRIVATE_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    ...headers,
  });
  res.end(html);
}

function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(303, { ...PRIVATE_HEADERS, location, ...headers });
  res.end();
}

const toLang = (value: unknown): Lang => (value === 'zh' ? 'zh' : 'en');

function publicUser(user: User): { id: number; name: string; active: boolean } {
  return { id: user.id, name: user.displayName, active: user.disabledAt === null };
}

/**
 * The family chat, mounted at /family/ by server.ts. Owns its database,
 * its live connections, and its rate limits. Every route below resolves
 * the session first; there is no path to a message, a photo, or the event
 * stream that doesn't.
 */
export class FamilyChat {
  readonly store: FamilyStore;
  readonly hub = new Hub();
  readonly #config: FamilyConfig;
  readonly #imagesDir: string;
  readonly #static = new Map<string, { body: Buffer; hash: string }>();
  readonly #assets: Assets;
  readonly #loginByAddress = new LoginLimiter();
  readonly #loginByName = new LoginLimiter();
  readonly #sends = new TokenBucket(30, 1);
  readonly #uploads = new TokenBucket(20, 1 / 30);
  readonly #typing = new TokenBucket(2, 0.5);

  constructor(config: FamilyConfig) {
    this.#config = config;
    this.#imagesDir = join(config.dataDir, 'images');
    // Owner-only: other accounts on this machine can't read the conversation.
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.store = new FamilyStore(openDatabase(join(config.dataDir, 'chat.db')));
    this.store.pruneExpiredSessions();
    for (const name of readdirSync(STATIC_DIR)) {
      const body = readFileSync(join(STATIC_DIR, name));
      this.#static.set(name, {
        body,
        hash: createHash('sha256').update(body).digest('hex').slice(0, 12),
      });
    }
    this.#assets = {
      url: (name) => `/family/static/${name}?v=${this.#static.get(name)?.hash ?? '0'}`,
    };
  }

  shutdown(): void {
    this.hub.shutdown();
  }

  #session(req: IncomingMessage, res: ServerResponse | null): User | null {
    const token = readCookie(req.headers.cookie);
    const session = this.store.resolveSession(token);
    if (!session) return null;
    // A session in use re-sends its cookie now and then, so the browser's
    // copy expires no sooner than the server's.
    if (session.refreshed && token && res) res.setHeader('set-cookie', sessionCookie(token));
    return session.user;
  }

  /** Handles a /family request; false if `pathname` isn't one. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (pathname !== '/family' && !pathname.startsWith('/family/')) return false;
    const method = req.method ?? 'GET';
    // Never over plain HTTP: a password typed there would cross the
    // internet unencrypted, and the Secure cookie wouldn't stick anyway.
    // cloudflared says which scheme the visitor used; believed only from
    // loopback, as clientAddress() believes CF-Connecting-IP.
    if (arrivedOverHttp(req)) {
      res.writeHead(308, {
        location: `https://${String(req.headers.host)}${req.url ?? '/family/'}`,
      });
      res.end();
      return true;
    }
    try {
      if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
        throw new HttpError(403, 'Cross-site request refused.');
      }
      await this.#route(req, res, url, method);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else if (error instanceof FamilyError) {
        sendJson(res, 400, { error: error.message });
      } else {
        // The stack only: a request body (a message) is never logged.
        console.error('family:', error instanceof Error ? error.stack : 'unknown error');
        sendJson(res, 500, { error: 'Something went wrong.' });
      }
    }
    return true;
  }

  async #route(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const { pathname } = url;

    if (pathname === '/family') {
      redirect(res, '/family/');
      return;
    }

    // Stylesheet, script, icon: the same for everyone and nothing private
    // in them, so served without a session (the sign-in page needs them).
    if (pathname.startsWith('/family/static/') && (method === 'GET' || method === 'HEAD')) {
      const file = this.#static.get(pathname.slice('/family/static/'.length));
      if (!file) throw new HttpError(404, 'Not found.');
      const current = url.searchParams.get('v') === file.hash;
      res.writeHead(200, {
        'content-type': STATIC_TYPES[extname(pathname)] ?? 'application/octet-stream',
        'cache-control': current ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-robots-tag': 'noindex',
      });
      res.end(method === 'HEAD' ? undefined : file.body);
      return;
    }

    if (pathname === '/family/manifest.webmanifest' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/manifest+json',
        'cache-control': 'no-cache',
        'x-robots-tag': 'noindex',
      });
      res.end(
        JSON.stringify({
          name: GROUP_NAME,
          short_name: GROUP_NAME,
          start_url: '/family/',
          scope: '/family/',
          display: 'standalone',
          background_color: '#fbfaf8',
          theme_color: '#fbfaf8',
          icons: [{ src: this.#assets.url('icon-180.png'), sizes: '180x180', type: 'image/png' }],
        }),
      );
      return;
    }

    if (pathname === '/family/login' && method === 'POST') {
      await this.#login(req, res);
      return;
    }

    if (pathname === '/family/logout' && method === 'POST') {
      const token = readCookie(req.headers.cookie);
      const user = this.#session(req, null);
      this.store.deleteSession(token);
      if (user) this.hub.record('signed-out', user.id);
      redirect(res, '/family/', { 'set-cookie': CLEAR_COOKIE });
      return;
    }

    const me = this.#session(req, res);

    if (pathname === '/family/' && (method === 'GET' || method === 'HEAD')) {
      if (!me) {
        sendPage(res, 200, renderLogin(this.#assets, null));
        return;
      }
      sendPage(
        res,
        200,
        renderChat({
          assets: this.#assets,
          me,
          members: this.store.members(),
          recent: this.store.history(null, PAGE_SIZE).messages,
        }),
      );
      return;
    }

    // The admin pages don't admit to existing for anyone else.
    if (pathname === '/family/admin' || pathname.startsWith('/family/admin/')) {
      if (!me?.isAdmin) throw new HttpError(404, 'Not found.');
      await this.#admin(req, res, url, method, me);
      return;
    }

    if (!me) {
      // A page navigation gets the sign-in screen; a script gets a 401 it can act on.
      if (method === 'POST' && pathname === '/family/send') {
        redirect(res, '/family/');
        return;
      }
      throw new HttpError(401, 'Not signed in.');
    }

    // The no-JavaScript composer: a plain form post, then back to the page.
    if (pathname === '/family/send' && method === 'POST') {
      const form = await readForm(req);
      this.#post(me, {
        clientId: form.get('clientId') ?? '',
        body: form.get('body') ?? '',
      });
      redirect(res, '/family/');
      return;
    }

    if (pathname === '/family/api/history' && method === 'GET') {
      const before = Number.parseInt(url.searchParams.get('before') ?? '', 10);
      const page = this.store.history(Number.isFinite(before) ? before : null, PAGE_SIZE);
      sendJson(res, 200, {
        ...page,
        rev: this.store.currentRev(),
        members: this.store.members().map(publicUser),
        lastReadRev: me.lastReadRev,
      });
      return;
    }

    if (pathname === '/family/api/events' && method === 'GET') {
      this.#events(req, res, url, me);
      return;
    }

    if (pathname === '/family/api/messages' && method === 'POST') {
      const body = await readJson(req);
      const result = this.#post(me, body);
      sendJson(res, result.created ? 201 : 200, { message: result.message });
      return;
    }

    const deleteMatch = /^\/family\/api\/messages\/(\d+)$/.exec(pathname);
    if (deleteMatch && method === 'DELETE') {
      const { message, imageId } = this.store.deleteMessage(me, Number(deleteMatch[1]));
      if (imageId !== null) await rm(join(this.#imagesDir, imageId), { force: true });
      this.hub.broadcast('delete', { id: message.id, rev: message.rev }, { id: message.rev });
      this.hub.record('message-deleted', me.id, `#${String(message.id)}`);
      sendJson(res, 200, { id: message.id, rev: message.rev });
      return;
    }

    if (pathname === '/family/api/images' && method === 'POST') {
      await this.#upload(req, res, url, me);
      return;
    }

    const imageMatch = /^\/family\/images\/([0-9a-f]{32})$/.exec(pathname);
    if (imageMatch && (method === 'GET' || method === 'HEAD')) {
      const id = imageMatch[1] ?? '';
      const image = this.store.getImage(id);
      if (!image) throw new HttpError(404, 'Not found.');
      res.writeHead(200, {
        'content-type': image.mime,
        // Private: the browser may keep it (it never changes), Cloudflare may not.
        'cache-control': 'private, max-age=31536000, immutable',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-robots-tag': 'noindex, nofollow',
      });
      if (method === 'HEAD') res.end();
      else
        createReadStream(join(this.#imagesDir, id))
          .on('error', () => res.destroy())
          .pipe(res);
      return;
    }

    if (pathname === '/family/api/typing' && method === 'POST') {
      if (this.#typing.take(String(me.id)))
        this.hub.broadcast('typing', { userId: me.id }, { except: me.id });
      res.writeHead(204, PRIVATE_HEADERS);
      res.end();
      return;
    }

    if (pathname === '/family/api/read' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body['rev'] === 'number' && Number.isInteger(body['rev'])) {
        this.store.markRead(me.id, body['rev']);
      }
      res.writeHead(204, PRIVATE_HEADERS);
      res.end();
      return;
    }

    throw new HttpError(404, 'Not found.');
  }

  async #login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req);
    const form = await readForm(req);
    const username = (form.get('username') ?? '').trim().slice(0, 64);
    const password = (form.get('password') ?? '').slice(0, 1024);
    const nameKey = username.toLowerCase();
    const wait = Math.max(
      this.#loginByAddress.retryAfterMs(address),
      this.#loginByName.retryAfterMs(nameKey),
    );
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      this.hub.record('sign-in-locked', null, username);
      sendPage(
        res,
        429,
        renderLogin(
          this.#assets,
          `Too many attempts. Try again in ${String(minutes)} min. · 尝试次数过多，请 ${String(minutes)} 分钟后再试。`,
          username,
        ),
        { 'retry-after': String(Math.ceil(wait / 1000)) },
      );
      return;
    }
    const user = await this.store.authenticate(username, password);
    if (!user) {
      this.#loginByAddress.recordFailure(address);
      this.#loginByName.recordFailure(nameKey);
      this.hub.record('sign-in-failed', null, username);
      sendPage(
        res,
        401,
        renderLogin(
          this.#assets,
          'Incorrect username or password. · 用户名或密码不正确。',
          username,
        ),
      );
      return;
    }
    this.#loginByAddress.recordSuccess(address);
    this.#loginByName.recordSuccess(nameKey);
    const token = this.store.createSession(user.id, String(req.headers['user-agent'] ?? ''));
    this.hub.record('signed-in', user.id, String(req.headers['cf-ipcountry'] ?? ''));
    redirect(res, '/family/', { 'set-cookie': sessionCookie(token) });
  }

  #post(me: User, body: Record<string, unknown>): { message: Message; created: boolean } {
    const clientId = body['clientId'];
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(clientId)) {
      throw new HttpError(400, 'Missing clientId.');
    }
    if (!this.#sends.take(String(me.id))) {
      this.hub.record('send-rate-limited', me.id);
      throw new HttpError(429, 'Slow down a little.');
    }
    const text = typeof body['body'] === 'string' ? body['body'] : '';
    const imageId = typeof body['imageId'] === 'string' ? body['imageId'] : null;
    const replyTo = typeof body['replyTo'] === 'number' ? body['replyTo'] : null;
    // Only what the request says, and never who it's from: the author is `me`.
    const result = this.store.postMessage({
      userId: me.id,
      clientId,
      body: text,
      imageId,
      replyTo,
    });
    if (result.created) {
      this.hub.broadcast('message', result.message, { id: result.message.rev });
    } else {
      this.hub.record('duplicate-send-absorbed', me.id, `#${String(result.message.id)}`);
    }
    return result;
  }

  async #upload(req: IncomingMessage, res: ServerResponse, url: URL, me: User): Promise<void> {
    if (!this.#uploads.take(String(me.id))) {
      this.hub.record('upload-rate-limited', me.id);
      throw new HttpError(429, 'Too many photos at once. Wait a minute.');
    }
    const bytes = await readBody(req, MAX_IMAGE_BYTES);
    // The type comes from the bytes, never from what the request claims.
    const mime = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0];
    if (!mime) {
      this.hub.record('upload-rejected', me.id, 'not an image');
      throw new HttpError(415, 'That file isn’t a photo this chat can show.');
    }
    const dimension = (name: string): number => {
      const value = Number.parseInt(url.searchParams.get(name) ?? '', 10);
      return Number.isFinite(value) ? Math.min(Math.max(value, 1), 20000) : 1;
    };
    await mkdir(this.#imagesDir, { recursive: true, mode: 0o700 });
    const id = this.store.addImage({
      userId: me.id,
      mime,
      bytes: bytes.length,
      width: dimension('w'),
      height: dimension('h'),
    });
    await writeFile(join(this.#imagesDir, id), bytes, { mode: 0o600 });
    sendJson(res, 201, { imageId: id });
  }

  #events(req: IncomingMessage, res: ServerResponse, url: URL, me: User): void {
    const token = readCookie(req.headers.cookie);
    const lastEventId = req.headers['last-event-id'];
    const after = Number.parseInt(
      typeof lastEventId === 'string' ? lastEventId : (url.searchParams.get('after') ?? '0'),
      10,
    );
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      ...PRIVATE_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-transform',
      'x-accel-buffering': 'no',
    });
    // A short retry: the browser comes back in 2 s after a drop.
    res.write('retry: 2000\n\n');

    const connection = this.hub.open({
      userId: me.id,
      country: String(req.headers['cf-ipcountry'] ?? ''),
      userAgent: String(req.headers['user-agent'] ?? ''),
      stillAuthorized: () => this.store.resolveSession(token) !== null,
      lastRev: Number.isFinite(after) ? after : 0,
      res,
    });
    this.hub.send(connection, 'hello', {
      rev: this.store.currentRev(),
      members: this.store.members().map(publicUser),
    });
    // Everything since what this client last saw, before anything new: the
    // store is synchronous, so nothing can be broadcast in between.
    if (Number.isFinite(after) && after > 0) {
      const missed = this.store.changesSince(after, REPLAY_LIMIT + 1);
      if (missed.length > REPLAY_LIMIT) {
        this.hub.send(connection, 'reset', {});
      } else {
        for (const message of missed) {
          if (message.deleted)
            this.hub.send(connection, 'delete', { id: message.id, rev: message.rev }, message.rev);
          else this.hub.send(connection, 'message', message, message.rev);
        }
        if (missed.length > 0)
          this.hub.record('replayed-after-reconnect', me.id, `${String(missed.length)} events`);
      }
    }
    this.hub.record('stream-opened', me.id, connection.country);
    res.on('close', () => {
      this.hub.record('stream-closed', me.id);
    });
  }

  async #admin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    me: User,
  ): Promise<void> {
    const { pathname } = url;
    if (pathname === '/family/admin' && method === 'GET') {
      const users = this.store.listUsers();
      let dbBytes = 0;
      for (const suffix of ['', '-wal']) {
        try {
          dbBytes += statSync(join(this.#config.dataDir, `chat.db${suffix}`)).size;
        } catch {
          // Not there yet.
        }
      }
      sendPage(
        res,
        200,
        renderAdmin({
          assets: this.#assets,
          me,
          users,
          sessions: new Map(users.map((user) => [user.id, this.store.sessions(user.id)])),
          connections: this.hub.connections(),
          stats: { ...this.store.stats(), dbBytes },
          events: this.hub.events,
          startedAt: this.hub.startedAt,
          notice: url.searchParams.get('notice'),
        }),
      );
      return;
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found.');

    const form = await readForm(req);
    const back = (notice: string): void => {
      redirect(res, `/family/admin?notice=${encodeURIComponent(notice)}`);
    };
    const target = (): User => {
      const user = this.store.getUser(Number(form.get('id')));
      if (!user || user.username.startsWith('deleted-')) throw new FamilyError('No such member.');
      return user;
    };
    const refreshMembers = (): void => {
      this.hub.broadcast('members', { members: this.store.members().map(publicUser) });
    };

    try {
      switch (pathname) {
        case '/family/admin/create': {
          const user = await this.store.createUser({
            username: form.get('username') ?? '',
            displayName: form.get('displayName') ?? '',
            password: form.get('password') ?? '',
            lang: toLang(form.get('lang')),
          });
          refreshMembers();
          this.hub.record('member-added', user.id);
          back(`Added ${user.displayName}. They sign in as “${user.username}”.`);
          return;
        }
        case '/family/admin/rename': {
          const user = this.store.rename(target().id, form.get('displayName') ?? '');
          this.store.setLang(user.id, toLang(form.get('lang')));
          refreshMembers();
          back(`Saved ${user.displayName}.`);
          return;
        }
        case '/family/admin/password': {
          const user = target();
          await this.store.setPassword(user.id, form.get('password') ?? '');
          this.hub.disconnectUser(user.id);
          this.hub.record('password-reset', user.id);
          back(`New password set for ${user.displayName}; their devices are signed out.`);
          return;
        }
        case '/family/admin/revoke': {
          const user = target();
          this.store.revokeSessions(user.id);
          this.hub.disconnectUser(user.id);
          this.hub.record('sessions-revoked', user.id);
          back(`${user.displayName} is signed out everywhere.`);
          return;
        }
        case '/family/admin/disable':
        case '/family/admin/enable': {
          const user = target();
          if (user.id === me.id) throw new FamilyError('You can’t disable yourself.');
          const disable = pathname.endsWith('/disable');
          this.store.setDisabled(user.id, disable);
          if (disable) this.hub.disconnectUser(user.id);
          refreshMembers();
          this.hub.record(disable ? 'member-disabled' : 'member-enabled', user.id);
          back(`${user.displayName} is ${disable ? 'disabled' : 'enabled again'}.`);
          return;
        }
        case '/family/admin/delete': {
          const user = target();
          if (user.id === me.id) throw new FamilyError('You can’t delete yourself.');
          if ((form.get('confirm') ?? '').trim().toLowerCase() !== user.username.toLowerCase()) {
            throw new FamilyError(`Type “${user.username}” to confirm.`);
          }
          this.hub.disconnectUser(user.id);
          const { messageIds, imageIds } = this.store.deleteUser(user.id);
          for (const id of imageIds) await rm(join(this.#imagesDir, id), { force: true });
          for (const id of messageIds) {
            const message = this.store.requireMessage(id);
            this.hub.broadcast('delete', { id, rev: message.rev }, { id: message.rev });
          }
          refreshMembers();
          this.hub.record('member-deleted', null, user.displayName);
          back(`Deleted ${user.displayName} and ${String(messageIds.length)} messages.`);
          return;
        }
        default:
          throw new HttpError(404, 'Not found.');
      }
    } catch (error) {
      if (error instanceof FamilyError) {
        back(error.message);
        return;
      }
      throw error;
    }
  }
}
