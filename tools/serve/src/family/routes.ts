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
import { Hub, PRESENCE_MS } from './hub.ts';
import { TokenBucket } from './limits.ts';
import { Notifier } from './notify.ts';
import { FAMILY } from './chats.ts';
import type { ChatIdentity } from './chats.ts';
import { renderAdmin, renderChat, renderLogin, renderPassword, renderSearch } from './pages.ts';
import type { Assets } from './pages.ts';
import { FamilyError, FamilyStore, SESSION_DAYS } from './store.ts';
import type { Lang, Message, User } from './store.ts';
import { isPushEndpoint, isPushKeys, loadVapidKeys, sendPush } from './webpush.ts';
import type { VapidKeys } from './webpush.ts';

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
  "worker-src 'self'",
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
/** At or under this, an upload is a Genmoji or sticker's size, and counts against its own limit. */
const SMALL_UPLOAD_BYTES = 512 * 1024;
const PAGE_SIZE = 50;
const REPLAY_LIMIT = 500;
const SEARCH_LIMIT = 50;
/** A photo uploaded but never sent is kept this long (a slow second request), then removed. */
const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

export interface FamilyConfig {
  /** private/<slug> — chat.db, images/ and vapid.json. Never read by the site build. */
  readonly dataDir: string;
  /** Which chat this is: its address, its sign-in cookie, its name. The family's unless said. */
  readonly chat?: ChatIdentity;
  /**
   * Who push services should contact about this server's notifications
   * (VAPID's `sub`, RFC 8292): the site's address.
   */
  readonly pushSubject?: string;
  /** Tests only: stands in for the push services. */
  readonly pushFetch?: typeof fetch;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Each chat's sign-in is its own cookie, sent only to its own path: a
 * session for one chat is never presented to another, and its token would
 * mean nothing there anyway (another database).
 */
const cookieName = (chat: ChatIdentity): string => `${chat.slug}_session`;

function readCookie(chat: ChatIdentity, header: string | undefined): string | undefined {
  const name = cookieName(chat);
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

function sessionCookie(chat: ChatIdentity, token: string): string {
  return `${cookieName(chat)}=${token}; Path=/${chat.slug}; Max-Age=${String(SESSION_DAYS * 86400)}; HttpOnly; Secure; SameSite=Lax`;
}

const clearCookie = (chat: ChatIdentity): string =>
  `${cookieName(chat)}=; Path=/${chat.slug}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

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

function publicUser(user: User): {
  id: number;
  name: string;
  active: boolean;
  lastReadRev: number;
} {
  // lastReadRev: how far they've read — the receipts under your messages.
  return {
    id: user.id,
    name: user.displayName,
    active: user.disabledAt === null,
    lastReadRev: user.lastReadRev,
  };
}

/**
 * One chat — the family's at /family/, or Disc at /disc/ — mounted by
 * server.ts. Each instance is a separate world: its own database and
 * accounts, its own cookie, its own path; nothing links one to another.
 * Owns its database,
 * its live connections, and its rate limits. Every route below resolves
 * the session first; there is no path to a message, a photo, or the event
 * stream that doesn't.
 */
export class FamilyChat {
  readonly store: FamilyStore;
  readonly hub = new Hub();
  readonly #config: FamilyConfig;
  readonly #chat: ChatIdentity;
  /** `/family` or `/disc`: every path this chat answers starts with it. */
  readonly #base: string;
  readonly #imagesDir: string;
  readonly #static = new Map<string, { body: Buffer; hash: string }>();
  readonly #assets: Assets;
  readonly #loginByAddress = new LoginLimiter();
  readonly #loginByName = new LoginLimiter();
  readonly #sends = new TokenBucket(30, 1);
  readonly #uploads = new TokenBucket(20, 1 / 30);
  /** Genmoji and stickers: small, and several to a message. */
  readonly #smallUploads = new TokenBucket(60, 1 / 2);
  readonly #typing = new TokenBucket(2, 0.5);
  readonly #pushTests = new TokenBucket(3, 1 / 60);
  readonly #notifier: Notifier;
  readonly #push: { keys: VapidKeys; subject: string; fetch?: typeof fetch };
  readonly #cleanup: NodeJS.Timeout;

  constructor(config: FamilyConfig) {
    this.#config = config;
    this.#chat = config.chat ?? FAMILY;
    this.#base = `/${this.#chat.slug}`;
    this.#imagesDir = join(config.dataDir, 'images');
    // Owner-only: other accounts on this machine can't read the conversation.
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(config.dataDir, 0o700);
    this.store = new FamilyStore(openDatabase(join(config.dataDir, 'chat.db')));
    this.store.pruneExpiredSessions();
    const names = readdirSync(STATIC_DIR).sort();
    const bodies = new Map(names.map((name) => [name, readFileSync(join(STATIC_DIR, name))]));
    // The page's scripts are ES modules importing each other by relative
    // path, with no build step. All of them share one version — a hash of
    // every script — stamped onto each import here, so a deploy that
    // changes any module gives every URL a new version (and each stays
    // immutable in the browser's cache meanwhile).
    const scripts = names.filter((name) => name.endsWith('.js') && name !== 'sw.js');
    const scriptVersion = createHash('sha256')
      .update(Buffer.concat(scripts.map((name) => bodies.get(name) ?? Buffer.alloc(0))))
      .digest('hex')
      .slice(0, 12);
    for (const [name, raw] of bodies) {
      const isScript = scripts.includes(name);
      const body = isScript
        ? Buffer.from(
            raw
              .toString('utf8')
              .replace(
                /(\bfrom\s*|\bimport\s*\(\s*)(['"])\.\/([\w-]+\.js)\2/g,
                `$1$2./$3?v=${scriptVersion}$2`,
              ),
          )
        : raw;
      this.#static.set(name, {
        body,
        hash: isScript
          ? scriptVersion
          : createHash('sha256').update(body).digest('hex').slice(0, 12),
      });
    }
    this.#assets = {
      url: (name) => `${this.#base}/static/${name}?v=${this.#static.get(name)?.hash ?? '0'}`,
      modules: scripts.filter((name) => name !== 'chat.js'),
      base: this.#base,
      chat: this.#chat,
    };
    this.#push = {
      keys: loadVapidKeys(join(config.dataDir, 'vapid.json')),
      subject: config.pushSubject ?? `https://randyliang.net${this.#base}/`,
      ...(config.pushFetch ? { fetch: config.pushFetch } : {}),
    };
    this.#notifier = new Notifier({
      store: this.store,
      hub: this.hub,
      chat: this.#chat,
      ...this.#push,
    });
    void this.removeOrphans();
    this.#cleanup = setInterval(() => void this.removeOrphans(), 60 * 60 * 1000);
    this.#cleanup.unref();
  }

  shutdown(): void {
    clearInterval(this.#cleanup);
    this.hub.shutdown();
    // Copies what the WAL holds into chat.db, so the file is whole after
    // every stop and deploy (it had sat at 4 KB, everything in the WAL).
    // PASSIVE: never waits on another connection, such as a deploy's
    // candidate server, so it can't hold up the stop.
    try {
      this.store.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // Already closed, or busy: the next automatic checkpoint does it.
    }
  }

  /** Deletes photos that were uploaded and never sent (see ORPHAN_AFTER_MS). */
  async removeOrphans(now: number = Date.now()): Promise<number> {
    const ids = this.store.takeOrphanImages(now - ORPHAN_AFTER_MS);
    for (const id of ids) await rm(join(this.#imagesDir, id), { force: true });
    if (ids.length > 0) this.hub.record('orphan-photos-removed', null, String(ids.length));
    return ids.length;
  }

  #session(req: IncomingMessage, res: ServerResponse | null): User | null {
    const token = readCookie(this.#chat, req.headers.cookie);
    const session = this.store.resolveSession(token);
    if (!session) return null;
    // A session in use re-sends its cookie now and then, so the browser's
    // copy expires no sooner than the server's.
    if (session.refreshed && token && res)
      res.setHeader('set-cookie', sessionCookie(this.#chat, token));
    return session.user;
  }

  /** Handles a request under this chat's path; false if `pathname` isn't one. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    if (pathname !== this.#base && !pathname.startsWith(`${this.#base}/`)) return false;
    const method = req.method ?? 'GET';
    // Never over plain HTTP: a password typed there would cross the
    // internet unencrypted, and the Secure cookie wouldn't stick anyway.
    // cloudflared says which scheme the visitor used; believed only from
    // loopback, as clientAddress() believes CF-Connecting-IP.
    if (arrivedOverHttp(req)) {
      res.writeHead(308, {
        location: `https://${String(req.headers.host)}${req.url ?? `${this.#base}/`}`,
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
        console.error(
          `${this.#chat.slug}:`,
          error instanceof Error ? error.stack : 'unknown error',
        );
        sendJson(res, 500, { error: 'Something went wrong.' });
      }
    }
    return true;
  }

  async #route(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const { pathname } = url;

    if (pathname === this.#base) {
      redirect(res, `${this.#base}/`);
      return;
    }

    // Stylesheet, script, icon: the same for everyone and nothing private
    // in them, so served without a session (the sign-in page needs them).
    if (pathname.startsWith(`${this.#base}/static/`) && (method === 'GET' || method === 'HEAD')) {
      const file = this.#static.get(pathname.slice(`${this.#base}/static/`.length));
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

    // The service worker: notifications only (static/sw.js has no fetch
    // handler, so nothing private is ever cached by it). Served from
    // the chat's own path, which is what scopes it there; never cached,
    // so a deploy's new version is found on the next visit.
    if (pathname === `${this.#base}/sw.js` && (method === 'GET' || method === 'HEAD')) {
      const file = this.#static.get('sw.js');
      if (!file) throw new HttpError(404, 'Not found.');
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        'content-security-policy': "default-src 'none'",
        'x-robots-tag': 'noindex',
      });
      res.end(method === 'HEAD' ? undefined : file.body);
      return;
    }

    if (pathname === `${this.#base}/manifest.webmanifest` && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/manifest+json',
        'cache-control': 'no-cache',
        'x-robots-tag': 'noindex',
      });
      res.end(
        JSON.stringify({
          id: `${this.#base}/`,
          name: this.#chat.name,
          short_name: this.#chat.name,
          description: this.#chat.description,
          start_url: `${this.#base}/`,
          scope: `${this.#base}/`,
          display: 'standalone',
          background_color: '#fbfaf8',
          theme_color: '#fbfaf8',
          icons: [
            { src: this.#assets.url('icon-180.png'), sizes: '180x180', type: 'image/png' },
            { src: this.#assets.url('icon-192.png'), sizes: '192x192', type: 'image/png' },
            { src: this.#assets.url('icon-512.png'), sizes: '512x512', type: 'image/png' },
            {
              src: this.#assets.url('icon-maskable-512.png'),
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        }),
      );
      return;
    }

    if (pathname === `${this.#base}/login` && method === 'POST') {
      await this.#login(req, res);
      return;
    }

    if (pathname === `${this.#base}/logout` && method === 'POST') {
      const token = readCookie(this.#chat, req.headers.cookie);
      const user = this.#session(req, null);
      this.store.deleteSession(token);
      if (user) this.hub.record('signed-out', user.id);
      redirect(res, `${this.#base}/`, { 'set-cookie': clearCookie(this.#chat) });
      return;
    }

    const me = this.#session(req, res);

    if (pathname === `${this.#base}/` && (method === 'GET' || method === 'HEAD')) {
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

    // Searching this chat (pages.ts renderSearch): this chat's database
    // only, so only the conversation the searcher is signed in to.
    if (pathname === `${this.#base}/search` && (method === 'GET' || method === 'HEAD')) {
      if (!me) {
        redirect(res, `${this.#base}/`);
        return;
      }
      const query = (url.searchParams.get('q') ?? '').slice(0, 100).trim();
      const found = this.store.search(query, SEARCH_LIMIT);
      sendPage(
        res,
        200,
        renderSearch({
          assets: this.#assets,
          me,
          members: this.store.members(),
          query,
          results: found.messages,
          hasMore: found.hasMore,
        }),
      );
      return;
    }

    // Choosing your own password (pages.ts renderPassword): a page, so a
    // signed-out visit goes to sign in.
    if (pathname === `${this.#base}/password` || pathname === `${this.#base}/password/keep`) {
      if (!me) {
        redirect(res, `${this.#base}/`);
        return;
      }
      if (pathname === `${this.#base}/password` && (method === 'GET' || method === 'HEAD')) {
        sendPage(res, 200, renderPassword(this.#assets, me, me.suggestNewPassword));
        return;
      }
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (pathname === `${this.#base}/password/keep`) {
        this.store.keepPassword(me.id);
      } else {
        const form = await readForm(req);
        try {
          await this.store.changeOwnPassword(
            me.id,
            (form.get('password') ?? '').slice(0, 1024),
            readCookie(this.#chat, req.headers.cookie) ?? '',
          );
        } catch (error) {
          if (!(error instanceof FamilyError)) throw error;
          sendPage(
            res,
            400,
            renderPassword(this.#assets, me, me.suggestNewPassword, error.message),
          );
          return;
        }
        this.hub.record('password-changed', me.id);
      }
      redirect(res, `${this.#base}/`);
      return;
    }

    // The admin pages don't admit to existing for anyone else.
    if (pathname === `${this.#base}/admin` || pathname.startsWith(`${this.#base}/admin/`)) {
      if (!me?.isAdmin) throw new HttpError(404, 'Not found.');
      await this.#admin(req, res, url, method, me);
      return;
    }

    if (!me) {
      // A page navigation gets the sign-in screen; a script gets a 401 it can act on.
      if (method === 'POST' && pathname === `${this.#base}/send`) {
        redirect(res, `${this.#base}/`);
        return;
      }
      throw new HttpError(401, 'Not signed in.');
    }

    // The no-JavaScript composer: a plain form post, then back to the page.
    if (pathname === `${this.#base}/send` && method === 'POST') {
      const form = await readForm(req);
      this.#post(me, {
        clientId: form.get('clientId') ?? '',
        body: form.get('body') ?? '',
      });
      redirect(res, `${this.#base}/`);
      return;
    }

    if (pathname === `${this.#base}/api/history` && method === 'GET') {
      const before = Number.parseInt(url.searchParams.get('before') ?? '', 10);
      const page = this.store.history(Number.isFinite(before) ? before : null, PAGE_SIZE);
      sendJson(res, 200, {
        ...page,
        rev: this.store.currentRev(),
        epoch: this.store.epoch(),
        now: Date.now(),
        members: this.store.members().map(publicUser),
        lastReadRev: me.lastReadRev,
      });
      return;
    }

    if (pathname === `${this.#base}/api/events` && method === 'GET') {
      this.#events(req, res, url, me);
      return;
    }

    if (pathname === `${this.#base}/api/messages` && method === 'POST') {
      const body = await readJson(req);
      const result = this.#post(me, body);
      sendJson(res, result.created ? 201 : 200, { message: result.message });
      return;
    }

    // Info on a message: who read it and when. Its author's to see, as in
    // WhatsApp — everyone else sees only the line under the newest message.
    const receiptsMatch = new RegExp(`^${this.#base}/api/messages/(\\d+)/receipts$`).exec(pathname);
    if (receiptsMatch && method === 'GET') {
      const id = Number(receiptsMatch[1]);
      const message = this.store.getMessage(id);
      if (!message || message.deleted || message.unsent || message.userId !== me.id) {
        throw new HttpError(404, 'Not found.');
      }
      sendJson(res, 200, this.store.receipts(id));
      return;
    }

    // Changes to a message — an edit, Undo Send, a Tapback — reach every
    // open page as one 'update' carrying the whole message, and a reconnect
    // replays them (the message's rev moved; see #events).
    const changeMatch = new RegExp(`^${this.#base}/api/messages/(\\d+)(/unsend|/reaction)?$`).exec(
      pathname,
    );
    if (changeMatch && (method === 'PATCH' || method === 'POST')) {
      const id = Number(changeMatch[1]);
      const action = changeMatch[2] ?? '';
      if (!this.#sends.take(String(me.id))) throw new HttpError(429, 'Slow down a little.');
      const body = await readJson(req);
      let message: Message;
      let changed = true;
      if (action === '' && method === 'PATCH') {
        ({ message, changed } = this.store.editMessage(
          me,
          id,
          typeof body['body'] === 'string' ? body['body'] : '',
        ));
        if (changed) this.hub.record('message-edited', me.id, `#${String(id)}`);
      } else if (action === '/unsend' && method === 'POST') {
        const result = this.store.unsendMessage(me, id);
        message = result.message;
        for (const image of result.imageIds) {
          await rm(join(this.#imagesDir, image), { force: true });
        }
        this.hub.record('message-unsent', me.id, `#${String(id)}`);
      } else if (action === '/reaction' && method === 'POST') {
        const emoji = typeof body['emoji'] === 'string' ? body['emoji'] : '';
        const on = body['on'] !== false;
        ({ message, changed } = this.store.react(me, id, emoji, on));
        if (changed && on) void this.#notifier.reacted(message, me, emoji);
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
      if (changed) this.hub.broadcast('update', message, { id: message.rev });
      sendJson(res, 200, { message });
      return;
    }

    const deleteMatch = new RegExp(`^${this.#base}/api/messages/(\\d+)$`).exec(pathname);
    if (deleteMatch && method === 'DELETE') {
      const { message, imageIds } = this.store.deleteMessage(me, Number(deleteMatch[1]));
      for (const image of imageIds) await rm(join(this.#imagesDir, image), { force: true });
      this.hub.broadcast('delete', { id: message.id, rev: message.rev }, { id: message.rev });
      this.hub.record('message-deleted', me.id, `#${String(message.id)}`);
      sendJson(res, 200, { id: message.id, rev: message.rev });
      return;
    }

    if (pathname === `${this.#base}/api/images` && method === 'POST') {
      await this.#upload(req, res, url, me);
      return;
    }

    const imageMatch = new RegExp(`^${this.#base}/images/([0-9a-f]{32})$`).exec(pathname);
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

    if (
      pathname.startsWith(`${this.#base}/api/push`) ||
      pathname === `${this.#base}/api/presence`
    ) {
      await this.#pushRoute(req, res, pathname, method, me);
      return;
    }

    if (pathname === `${this.#base}/api/typing` && method === 'POST') {
      if (this.#typing.take(String(me.id)))
        this.hub.broadcast('typing', { userId: me.id }, { except: me.id });
      res.writeHead(204, PRIVATE_HEADERS);
      res.end();
      return;
    }

    if (pathname === `${this.#base}/api/read` && method === 'POST') {
      const body = await readJson(req);
      if (typeof body['rev'] === 'number' && Number.isInteger(body['rev'])) {
        const rev = this.store.markRead(me.id, body['rev']);
        // A read receipt, live: every open page moves this person's mark.
        if (rev !== null) this.hub.broadcast('read', { userId: me.id, rev });
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
    // A starter password: offered the chance to choose their own first.
    redirect(res, user.suggestNewPassword ? `${this.#base}/password` : `${this.#base}/`, {
      'set-cookie': sessionCookie(this.#chat, token),
    });
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
    const glyphs = Array.isArray(body['glyphs'])
      ? body['glyphs'].filter((id): id is string => typeof id === 'string')
      : [];
    const replyTo = typeof body['replyTo'] === 'number' ? body['replyTo'] : null;
    // Only what the request says, and never who it's from: the author is `me`.
    const result = this.store.postMessage({
      userId: me.id,
      clientId,
      body: text,
      imageId,
      glyphs,
      replyTo,
    });
    if (result.created) {
      this.hub.broadcast('message', result.message, { id: result.message.rev });
      void this.#notifier.messagePosted(result.message);
    } else {
      this.hub.record('duplicate-send-absorbed', me.id, `#${String(result.message.id)}`);
    }
    return result;
  }

  async #upload(req: IncomingMessage, res: ServerResponse, url: URL, me: User): Promise<void> {
    const small = Number(req.headers['content-length'] ?? Infinity) <= SMALL_UPLOAD_BYTES;
    if (!(small ? this.#smallUploads : this.#uploads).take(String(me.id))) {
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
    const token = readCookie(this.#chat, req.headers.cookie);
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
    const rev = this.store.currentRev();
    const epoch = this.store.epoch();
    this.hub.send(connection, 'hello', {
      rev,
      epoch,
      // The server's clock, so a page can tell how long Edit and Undo Send last.
      now: Date.now(),
      stream: connection.id,
      members: this.store.members().map(publicUser),
    });
    // A page that last saw another database (a restore since), or revs
    // this one hasn't reached, can't be brought up to date by replay: it
    // starts over. So does one too far behind for replay to be cheaper.
    const claimed = Number(url.searchParams.get('epoch') ?? epoch);
    const foreign = claimed !== epoch || (Number.isFinite(after) && after > rev);
    // Everything since what this client last saw, before anything new: the
    // store is synchronous, so nothing can be broadcast in between.
    if (foreign) {
      this.hub.send(connection, 'reset', {});
      this.hub.record('reset-after-restore', me.id);
    } else if (Number.isFinite(after) && after > 0) {
      const missed = this.store.changesSince(after, REPLAY_LIMIT + 1);
      if (missed.length > REPLAY_LIMIT) {
        this.hub.send(connection, 'reset', {});
      } else {
        for (const message of missed) {
          if (message.deleted)
            this.hub.send(connection, 'delete', { id: message.id, rev: message.rev }, message.rev);
          // Sent before this page's last event: it has it, and this is a change to it.
          else if (message.sentRev <= after)
            this.hub.send(connection, 'update', message, message.rev);
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

  /** Notification subscriptions for this device, and its "I'm looking" signal. */
  async #pushRoute(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    method: string,
    me: User,
  ): Promise<void> {
    const token = readCookie(this.#chat, req.headers.cookie) ?? '';

    if (pathname === `${this.#base}/api/push` && method === 'GET') {
      const mine = this.store.pushSubscriptionFor(token);
      sendJson(res, 200, {
        publicKey: this.#notifier.publicKey,
        subscribed: mine !== null,
        endpoint: mine?.endpoint ?? null,
        preview: mine?.preview ?? false,
      });
      return;
    }

    if (pathname === `${this.#base}/api/push` && method === 'POST') {
      const body = await readJson(req);
      const endpoint = typeof body['endpoint'] === 'string' ? body['endpoint'] : '';
      const keys = (body['keys'] ?? {}) as Record<string, unknown>;
      const p256dh = typeof keys['p256dh'] === 'string' ? keys['p256dh'] : '';
      const auth = typeof keys['auth'] === 'string' ? keys['auth'] : '';
      if (!isPushEndpoint(endpoint) || !isPushKeys(p256dh, auth)) {
        this.hub.record('push-subscription-refused', me.id);
        throw new HttpError(400, 'That isn’t a push subscription this server can use.');
      }
      this.store.savePushSubscription({
        endpoint,
        sessionToken: token,
        userId: me.id,
        p256dh,
        auth,
        preview: body['preview'] === true,
      });
      this.hub.record('push-subscribed', me.id, new URL(endpoint).hostname);
      sendJson(res, 200, { subscribed: true });
      return;
    }

    if (pathname === `${this.#base}/api/push/remove` && method === 'POST') {
      const body = await readJson(req);
      if (typeof body['endpoint'] === 'string') {
        this.store.deletePushSubscription(body['endpoint'], me.id);
      }
      this.hub.record('push-unsubscribed', me.id);
      sendJson(res, 200, { subscribed: false });
      return;
    }

    // "Send a test": proves the whole path to this one device.
    if (pathname === `${this.#base}/api/push/test` && method === 'POST') {
      const mine = this.store.pushSubscriptionFor(token);
      const target = mine
        ? this.store.pushTargets(me.id).find((t) => t.endpoint === mine.endpoint)
        : undefined;
      if (!target) throw new HttpError(404, 'Notifications aren’t on for this device.');
      if (!this.#pushTests.take(String(me.id))) throw new HttpError(429, 'Wait a minute.');
      const zh = me.lang === 'zh';
      const { outcome, status } = await sendPush(
        target,
        {
          title: zh ? this.#chat.zhName : this.#chat.name,
          body: zh ? '通知已开启。' : 'Notifications are on.',
          tag: `${this.#chat.slug}-test`,
          messageId: 0,
          badge: this.store.unreadCount(me.id),
        },
        this.#push,
      );
      this.store.recordPush(target.endpoint, outcome);
      this.hub.record('push-test', me.id, `${outcome} ${String(status)}`);
      sendJson(res, outcome === 'sent' ? 200 : 502, { outcome });
      return;
    }

    if (pathname === `${this.#base}/api/presence` && method === 'POST') {
      const body = await readJson(req);
      const connection = this.hub.get(Number(body['stream']));
      // Only one's own stream: nobody can silence someone else's notifications.
      if (connection?.userId === me.id) {
        connection.visibleUntil = body['visible'] === true ? Date.now() + PRESENCE_MS : 0;
      }
      res.writeHead(204, PRIVATE_HEADERS);
      res.end();
      return;
    }

    throw new HttpError(404, 'Not found.');
  }

  async #admin(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    me: User,
  ): Promise<void> {
    const { pathname } = url;
    if (pathname === `${this.#base}/admin` && method === 'GET') {
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
      redirect(res, `${this.#base}/admin?notice=${encodeURIComponent(notice)}`);
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
        case `${this.#base}/admin/create`: {
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
        case `${this.#base}/admin/rename`: {
          const user = this.store.rename(target().id, form.get('displayName') ?? '');
          this.store.setLang(user.id, toLang(form.get('lang')));
          refreshMembers();
          back(`Saved ${user.displayName}.`);
          return;
        }
        case `${this.#base}/admin/password`: {
          const user = target();
          await this.store.setPassword(user.id, form.get('password') ?? '');
          this.hub.disconnectUser(user.id);
          this.hub.record('password-reset', user.id);
          back(`New password set for ${user.displayName}; their devices are signed out.`);
          return;
        }
        case `${this.#base}/admin/revoke`: {
          const user = target();
          this.store.revokeSessions(user.id);
          this.hub.disconnectUser(user.id);
          this.hub.record('sessions-revoked', user.id);
          back(`${user.displayName} is signed out everywhere.`);
          return;
        }
        case `${this.#base}/admin/disable`:
        case `${this.#base}/admin/enable`: {
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
        case `${this.#base}/admin/delete`: {
          const user = target();
          if (user.id === me.id) throw new FamilyError('You can’t delete yourself.');
          if ((form.get('confirm') ?? '').trim().toLowerCase() !== user.username.toLowerCase()) {
            throw new FamilyError(`Type “${user.username}” to confirm.`);
          }
          this.hub.disconnectUser(user.id);
          const { messageIds, imageIds, reactedIds } = this.store.deleteUser(user.id);
          for (const id of imageIds) await rm(join(this.#imagesDir, id), { force: true });
          for (const id of messageIds) {
            const message = this.store.requireMessage(id);
            this.hub.broadcast('delete', { id, rev: message.rev }, { id: message.rev });
          }
          for (const id of reactedIds) {
            const message = this.store.requireMessage(id);
            this.hub.broadcast('update', message, { id: message.rev });
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
