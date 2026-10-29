import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

import { clearSessionCookie, readSessionCookie, setSessionCookie } from './cookies.ts';
import { loadNotes } from './notes.ts';
import { checkHealth } from './health.ts';
import type { FamilyChat } from './family/routes.ts';
import { readStatus, renderSystem } from './system.ts';
import { loadServices, mayViewInfra, probe, renderInfra } from './infra.ts';
import type { WhoisLookup } from './infra.ts';
import { LoginLimiter, clientAddress } from './login-limiter.ts';
import { renderArchive, renderGate } from './pages.ts';
import { createSessionToken, passwordMatches, verifySessionToken } from './session.ts';
import type { PhotoPreview } from './share-preview.ts';
import {
  findPhotoPreview,
  findSharePreview,
  FULL_ID_BYTES,
  PREFIX_BYTES,
} from './share-preview.ts';

export interface ServeConfig {
  /** site/dist — the public, prebuilt static site. Never contains anything under private/. */
  readonly distDir: string;
  readonly notesPath: string;
  readonly privatePhotosDir: string;
  readonly password: string;
  readonly sessionSecret: string;
  /**
   * generated/derivatives — served directly at /p/..., so the build never
   * copies gigabytes of images into dist/ (see docs/decisions.md,
   * 2026-10-24, "Derivatives are served from where ingest writes them").
   */
  readonly derivativesDir: string;
  /** generated/albums — read to resolve a shared link's ?s= into a real photograph's OG crop. */
  readonly generatedAlbumsDir: string;
  /** Matches astro.config.mjs's `site` — used to build absolute og:image URLs. */
  readonly siteOrigin: string;
  /** status/ — what the deploy, watchdog and `pnpm measure` recorded, read by /system. */
  readonly statusDir: string;
  /** infra/services.yaml — /infra's directory of this machine's services (git-ignored). */
  readonly infraServicesPath: string;
  /** Asks tailscaled who a tailnet address is (infra.ts); /infra is a 404 for anyone it can't vouch for. */
  readonly whois: WhoisLookup;
  /** The chats — the family's at /family/, Disc at /disc/ (family/routes.ts); none in a test. */
  readonly chats: readonly FamilyChat[];
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/**
 * Rejects any path carrying a `..` segment — the same guard
 * tools/pipeline's editor server uses for the same reason on the same kind
 * of request (a URL path turned directly into a filesystem read). Kept as
 * its own copy rather than an import: this workspace doesn't depend on
 * tools/pipeline, and three lines isn't worth a cross-workspace reference.
 */
function isSafeRelativePath(relative: string): boolean {
  return relative.length > 0 && !relative.split('/').includes('..');
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendHtml(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(body);
}

/**
 * `/p/<hash>/...` derivatives and Astro's own `/_astro/...` build output are
 * both content-addressed — the filename changes the moment the bytes would,
 * so there is no staleness risk in caching them as hard as a browser and
 * Cloudflare's edge allow. Fonts aren't hash-named but change close to
 * never, so they get a long cache without `immutable`. Everything else
 * (HTML, robots.txt, sitemap.xml, the 404 page) is left with no explicit
 * header — a rebuild reuses the same URL for different bytes, so those need
 * to stay revalidated, not cached hard.
 */
function cacheControlFor(relative: string): string | undefined {
  if (relative.startsWith('p/') || relative.startsWith('_astro/')) {
    return 'public, max-age=31536000, immutable';
  }
  if (relative.startsWith('fonts/')) {
    return 'public, max-age=2592000';
  }
  // Pages keep their URL across deploys, so they're never served from a
  // cache without asking: `no-cache` means "revalidate", which sendFile's
  // ETag answers with a 304 when nothing changed.
  if (relative.endsWith('.html')) return 'no-cache';
  return undefined;
}

/** Responses that must never be stored anywhere: not by the browser, not by Cloudflare. */
const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * Sent with every response. The site is HTTPS-only behind Cloudflare, so
 * HSTS is safe (one year; not includeSubDomains, which would bind hosts
 * this server doesn't own). No page is meant to be framed — the /private
 * login least of all. CSP is deliberately absent for now: the inline grid
 * script and Cloudflare's injected beacon need a considered policy
 * (docs/decisions.md, 2026-10-26).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

/**
 * A static file, with validators: a weak ETag (size and modification time —
 * weak because Cloudflare drops strong ETags when it re-compresses) and
 * Last-Modified, answered with a body-less 304 when the browser already has
 * this version. Every deploy writes new files, so the validators change
 * exactly when the content does.
 */
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  cacheControl?: string,
  onNotFound?: () => void | Promise<void>,
): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>> | null;
  try {
    info = await stat(path);
  } catch {
    info = null;
  }
  if (info === null || !info.isFile()) {
    if (onNotFound) {
      await onNotFound();
    } else {
      sendText(res, 404, 'Not found');
    }
    return;
  }
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
  const headers = {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    etag,
    'last-modified': lastModified,
    ...(cacheControl ? { 'cache-control': cacheControl } : {}),
  };
  if (isFresh(req, etag, info.mtimeMs)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
}

/** Whether the browser's cached copy (If-None-Match, else If-Modified-Since) is still this version. */
function isFresh(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const match = req.headers['if-none-match'];
  if (typeof match === 'string') {
    // Weak comparison: a W/ prefix on either side doesn't matter.
    const strip = (tag: string): string => tag.trim().replace(/^W\//, '');
    return match === '*' || match.split(',').some((tag) => strip(tag) === strip(etag));
  }
  const since = req.headers['if-modified-since'];
  if (typeof since === 'string') {
    const time = Date.parse(since);
    return !Number.isNaN(time) && Math.floor(mtimeMs / 1000) * 1000 <= time;
  }
  return false;
}

/**
 * Astro's own static build emits `dist/404.html` (`src/pages/404.astro`) —
 * this is what makes that page real in production rather than dead code,
 * since a generic static host would pick it up automatically but this
 * process serves files itself. Falls back to a plain stub only if the
 * build hasn't produced one yet.
 */
async function sendNotFoundPage(res: ServerResponse, distDir: string): Promise<void> {
  let body: string;
  try {
    body = await readFile(join(distDir, '404.html'), 'utf8');
  } catch {
    body = '<h1>Not found</h1>';
  }
  sendHtml(res, 404, body);
}

/**
 * Rewrites `og:image` (plus `og:image:width`/`og:image:height`) to a
 * specific photograph — a link-preview bot fetches a URL and reads
 * whatever's in the raw HTML without ever running JavaScript, so no
 * client-side script can do this. Regex-replaces the *content* of
 * whichever `<meta property="og:image">` tag is already there, whatever
 * it currently points at (the site default on /exposures/share/, but a
 * page-specific cover photo on a tag/film-stock/Selected-Work page — see
 * each of those pages' own `image` prop to `<Base>`) rather than matching
 * one known default string, so this works uniformly across every page
 * Browse ever appears on. Width/height are replaced if already present,
 * inserted right after the image tag if not (only /saved//share/ lack
 * them, since neither passes an `image` prop of their own). Returns the
 * input unchanged if no `og:image` tag is found at all.
 */
function rewriteOgImage(html: string, config: ServeConfig, preview: PhotoPreview): string {
  const imagePattern = /<meta property="og:image" content="[^"]*">/;
  if (!imagePattern.test(html)) return html;
  const previewImage = `${config.siteOrigin}${preview.imagePath}`;
  return html
    .replace(/<meta property="og:image:width" content="[^"]*">/, '')
    .replace(/<meta property="og:image:height" content="[^"]*">/, '')
    .replace(
      imagePattern,
      `<meta property="og:image" content="${previewImage}">` +
        `<meta property="og:image:width" content="${preview.width.toString()}">` +
        `<meta property="og:image:height" content="${preview.height.toString()}">`,
    );
}

/** Replaces both description tags' content — only used for /exposures/share/'s own count-based text, which has no better page-specific default to preserve (unlike a tag/film-stock page's description, left untouched). */
function rewriteDescription(html: string, description: string): string {
  return html
    .replace(
      /<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${description}">`,
    )
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${description}">`,
    );
}

/**
 * URLs from before the 2026-10-20 renames, mapped to where that content
 * lives now. These are permanent moves (301): browsers that cached the old
 * `/` → `/photography/selected/` 301 land here and are sent on, and so is
 * anyone following an old shared link. Selected Work moved to the
 * photography front page, so `/photography/selected/` goes to `/exposures/`.
 */
const LEGACY_PREFIXES: readonly (readonly [string, string])[] = [
  ['/photography/selected/', '/exposures/'],
  ['/photography/', '/exposures/'],
  ['/films/', '/pictures/'],
  ['/recipes/', '/dishes/'],
  // Exhibition was renamed Gallery; its links carry their whole state in
  // the query string, which the redirect keeps.
  ['/exposures/exhibition/', '/exposures/gallery/'],
  ['/music/', '/tunes/'],
];

export function legacyRedirect(pathname: string): string | null {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  for (const [from, to] of LEGACY_PREFIXES) {
    if (path === from) return to;
    if (from !== '/photography/selected/' && path.startsWith(from)) {
      return `${to}${pathname.slice(from.length)}`;
    }
  }
  return null;
}

/**
 * Where a page URL that isn't in its canonical form should go: a built page
 * directory named without its trailing slash (`/exposures` → `/exposures/`)
 * or by its index file (`/exposures/index.html` → `/exposures/`). Astro
 * builds every page as `<path>/index.html` and links them all with the
 * slash (`trailingSlash: 'always'`), so the slashed form is the one real
 * address. Null for everything else — a real file, a derivative, a path
 * with no page behind it — so nothing that works today is redirected and a
 * typo still 404s instead of bouncing first.
 */
export async function canonicalPagePath(distDir: string, pathname: string): Promise<string | null> {
  let directory: string;
  if (pathname.endsWith('/index.html')) directory = pathname.slice(0, -'index.html'.length);
  else if (pathname.endsWith('/') || pathname.startsWith('/p/')) return null;
  else directory = `${pathname}/`;
  const relative = `${directory.slice(1)}index.html`;
  if (relative !== 'index.html' && !isSafeRelativePath(relative)) return null;
  try {
    return (await stat(join(distDir, relative))).isFile() ? directory : null;
  } catch {
    return null;
  }
}

function isAuthenticated(config: ServeConfig, req: IncomingMessage): boolean {
  const token = readSessionCookie(req.headers.cookie);
  return verifySessionToken(config.sessionSecret, token);
}

/** A login form is a few dozen bytes; anything past this is not one. */
const MAX_LOGIN_BODY_BYTES = 4096;

async function readPassword(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_LOGIN_BODY_BYTES) return null;
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > MAX_LOGIN_BODY_BYTES) return null;
  }
  return new URLSearchParams(body).get('password') ?? '';
}

async function route(
  config: ServeConfig,
  limiter: LoginLimiter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const method = req.method ?? 'GET';

  // Each chat answers for all of its own path, session first, and never
  // falls through to static files (family/routes.ts).
  for (const chat of config.chats) if (await chat.handle(req, res, url)) return;

  // Readiness, for the deploy's candidate check and the watchdog: 200 when
  // this process can serve the site (health.ts), 503 with what's missing
  // otherwise. Never cached — Cloudflare included.
  // The engineering status page: public but unlisted and not indexed,
  // read-only — it renders what jobs recorded and runs only the same cheap
  // health check as /healthz (system.ts).
  if (
    (pathname === '/system' || pathname === '/system/') &&
    (method === 'GET' || method === 'HEAD')
  ) {
    let health = null;
    try {
      health = await checkHealth(config);
    } catch {
      // Shown as Unknown.
    }
    const html = renderSystem({
      now: new Date(),
      health,
      files: await readStatus(config.statusDir),
    });
    sendHtml(res, 200, method === 'HEAD' ? '' : html, {
      'cache-control': 'no-cache',
      'x-robots-tag': 'noindex',
    });
    return;
  }

  // The service directory: the owner's own devices on the tailnet only,
  // decided by the connection itself and tailscaled (infra.ts), never by a
  // header. Everyone else — the public site through the Cloudflare tunnel,
  // the LAN, loopback — gets exactly the site's ordinary 404, so its
  // existence isn't confirmed either.
  if (pathname === '/infra' || pathname === '/infra/') {
    if ((method !== 'GET' && method !== 'HEAD') || !(await mayViewInfra(req, config.whois))) {
      await sendNotFoundPage(res, config.distDir);
      return;
    }
    const groups = await loadServices(config.infraServicesPath);
    const here = (req.socket.localAddress ?? '').replace(/^::ffff:/, '');
    const urls = (groups ?? []).flatMap((group) => group.services.map((service) => service.url));
    const states = await Promise.all(
      urls.map(async (url) => [url, await probe(here, url)] as const),
    );
    const html = renderInfra(groups, new Map(states), new Date());
    sendHtml(res, 200, method === 'HEAD' ? '' : html, {
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    });
    return;
  }

  if (pathname === '/healthz' && (method === 'GET' || method === 'HEAD')) {
    const health = await checkHealth(config);
    res.writeHead(health.ok ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : JSON.stringify(health));
    return;
  }

  // Everything under /private is handled here, never falling through to
  // static file serving — private/ is never inside site/dist to begin
  // with, but this keeps the routing itself explicit about the boundary
  // rather than relying only on that filesystem fact.
  if (pathname === '/private' && (method === 'GET' || method === 'HEAD')) {
    if (isAuthenticated(config, req)) {
      sendHtml(res, 200, renderArchive(loadNotes(config.notesPath)), NO_STORE);
    } else {
      sendHtml(res, 200, renderGate(null), NO_STORE);
    }
    return;
  }

  if (pathname === '/private/login' && method === 'POST') {
    const client = clientAddress(req);
    const wait = limiter.retryAfterMs(client);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      res.writeHead(429, {
        ...NO_STORE,
        'content-type': 'text/html; charset=utf-8',
        'retry-after': String(Math.ceil(wait / 1000)),
      });
      res.end(
        renderGate(
          `Too many attempts. Try again in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`,
        ),
      );
      return;
    }
    const password = await readPassword(req);
    if (password === null) {
      sendText(res, 413, 'Payload too large');
      return;
    }
    if (passwordMatches(config.sessionSecret, password, config.password)) {
      limiter.recordSuccess(client);
      const token = createSessionToken(config.sessionSecret);
      res.writeHead(303, {
        ...NO_STORE,
        'set-cookie': setSessionCookie(token),
        location: '/private',
      });
      res.end();
    } else {
      limiter.recordFailure(client);
      sendHtml(res, 401, renderGate('Wrong password.'), NO_STORE);
    }
    return;
  }

  if (pathname === '/private/logout' && method === 'POST') {
    res.writeHead(303, { ...NO_STORE, 'set-cookie': clearSessionCookie(), location: '/private' });
    res.end();
    return;
  }

  if (pathname.startsWith('/private/photos/') && method === 'GET') {
    if (!isAuthenticated(config, req)) {
      sendText(res, 401, 'Unauthorized');
      return;
    }
    const file = decodeURIComponent(pathname.slice('/private/photos/'.length));
    if (!isSafeRelativePath(file)) {
      sendText(res, 400, 'Bad request');
      return;
    }
    await sendFile(req, res, join(config.privatePhotosDir, file), 'private, no-store');
    return;
  }

  // Astro's static build turns astro.config.mjs's `redirects` entry into a
  // real page (dist/index.html) that only redirects via
  // `<meta http-equiv="refresh">` — there's no server at build time to issue
  // a real HTTP redirect. Serving that page as-is means a visitor briefly
  // sees its own title/body ("Redirecting to: /exposures/")
  // before the refresh fires. This process *is* a server, so it redirects
  // "/" for real instead, before that file is ever read. Must match
  // astro.config.mjs's own `'/': '/exposures/'` entry, which
  // still matters for `astro dev` (a real redirect there too) and for a
  // generic static host serving dist/ directly.
  //
  // 302, not 301: browsers cache a 301 indefinitely, and this target has
  // already moved three times (/photography/, /photography/selected/,
  // /exposures/) — a cached 301 kept returning visitors on a URL that no
  // longer exists.
  const legacy = method === 'GET' || method === 'HEAD' ? legacyRedirect(pathname) : null;
  if (legacy !== null) {
    const { search } = new URL(req.url ?? '/', 'http://localhost');
    // Straight to the canonical address, not via a second redirect for
    // its missing trailing slash (/recipes/miso-soup → /dishes/miso-soup/).
    const target = (await canonicalPagePath(config.distDir, legacy)) ?? legacy;
    res.writeHead(301, { location: `${target}${search}` });
    res.end();
    return;
  }

  // /exposures → /exposures/, keeping any query string (a fragment never
  // reaches the server; the browser carries it across the redirect).
  if (method === 'GET' || method === 'HEAD') {
    const canonical = await canonicalPagePath(config.distDir, pathname);
    if (canonical !== null) {
      const { search } = new URL(req.url ?? '/', 'http://localhost');
      res.writeHead(301, { location: `${canonical}${search}` });
      res.end();
      return;
    }
  }

  if (pathname === '/' && (method === 'GET' || method === 'HEAD')) {
    res.writeHead(302, { location: '/exposures/' });
    res.end();
    return;
  }

  // Everything else: the public, prebuilt static site (`pnpm build` must
  // have run first — this process never runs Astro itself).
  if (method === 'GET' || method === 'HEAD') {
    const relative =
      pathname === '/' || pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const relativeWithoutSlash = relative.slice(1);
    if (!isSafeRelativePath(relativeWithoutSlash)) {
      sendText(res, 400, 'Bad request');
      return;
    }

    // A visitor's own copied address-bar URL (?photo=<id>, set by
    // browse.ts's replaceHash alongside the #photo-<id> hash it's always
    // kept) or a generated share link (?s=..., /exposures/share/ only)
    // each name real content a link-preview bot can never decode itself —
    // this is the one place either gets reflected into the static HTML,
    // per request, before it's served.
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const photoId = query.get('photo');
    // `?p=` carries 4-byte id prefixes (current links); `?s=` full ids (older ones).
    const shortShare = pathname === '/exposures/share/' ? query.get('p') : null;
    const sharedIds = pathname === '/exposures/share/' ? (shortShare ?? query.get('s')) : null;
    if (relativeWithoutSlash.endsWith('.html') && (photoId !== null || sharedIds !== null)) {
      let html: string;
      try {
        html = await readFile(join(config.distDir, relativeWithoutSlash), 'utf8');
      } catch {
        await sendNotFoundPage(res, config.distDir);
        return;
      }
      if (photoId !== null) {
        const preview = await findPhotoPreview(config.generatedAlbumsDir, photoId);
        if (preview !== null) html = rewriteOgImage(html, config, preview);
      } else if (sharedIds !== null) {
        const preview = await findSharePreview(
          config.generatedAlbumsDir,
          sharedIds,
          shortShare === null ? FULL_ID_BYTES : PREFIX_BYTES,
        );
        if (preview !== null) {
          const description = `A shared selection of ${preview.count.toString()} photograph${preview.count === 1 ? '' : 's'}.`;
          html = rewriteDescription(rewriteOgImage(html, config, preview), description);
        }
      }
      sendHtml(res, 200, html, { 'cache-control': 'no-cache' });
      return;
    }

    const root = relativeWithoutSlash.startsWith('p/') ? config.derivativesDir : config.distDir;
    await sendFile(
      req,
      res,
      join(root, relativeWithoutSlash),
      cacheControlFor(relativeWithoutSlash),
      () => sendNotFoundPage(res, config.distDir),
    );
    return;
  }

  sendText(res, 404, 'Not found');
}

function handleRequest(
  config: ServeConfig,
  limiter: LoginLimiter,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  route(config, limiter, req, res).catch((error: unknown) => {
    console.error(error);
    sendText(res, 500, 'Internal error');
  });
}

/**
 * The public site (site/dist/, already built by `pnpm build`) plus one
 * password-gated route, /private. Binding this to every interface (not
 * 127.0.0.1-only, unlike the editor server) is intentional, not an
 * oversight of that same invariant — the editor server has no
 * authentication at all and that binding is what makes it safe; this
 * server exists specifically to be reachable over the network and gates
 * access with a real session instead.
 */
export function createPrivateSiteServer(config: ServeConfig): Server {
  // One per server, so failed logins are counted for this process alone.
  const limiter = new LoginLimiter();
  return createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handleRequest(config, limiter, req, res);
  });
}
