import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { text } from 'node:stream/consumers';

import { clearSessionCookie, readSessionCookie, setSessionCookie } from './cookies.ts';
import { loadNotes } from './notes.ts';
import { renderArchive, renderGate } from './pages.ts';
import { createSessionToken, passwordMatches, verifySessionToken } from './session.ts';
import type { PhotoPreview } from './share-preview.ts';
import { findPhotoPreview, findSharePreview } from './share-preview.ts';

export interface ServeConfig {
  /** site/dist — the public, prebuilt static site. Never contains anything under private/. */
  readonly distDir: string;
  readonly notesPath: string;
  readonly privatePhotosDir: string;
  readonly password: string;
  readonly sessionSecret: string;
  /** generated/albums — read to resolve a shared link's ?s= into a real photograph's OG crop. */
  readonly generatedAlbumsDir: string;
  /** Matches astro.config.mjs's `site` — used to build absolute og:image URLs. */
  readonly siteOrigin: string;
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
  return undefined;
}

async function sendFile(
  res: ServerResponse,
  path: string,
  cacheControl?: string,
  onNotFound?: () => void | Promise<void>,
): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    if (onNotFound) {
      await onNotFound();
    } else {
      sendText(res, 404, 'Not found');
    }
    return;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
    ...(cacheControl ? { 'cache-control': cacheControl } : {}),
  });
  createReadStream(path).pipe(res);
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
 * it currently points at (the site default on /photography/share/, but a
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

/** Replaces both description tags' content — only used for /photography/share/'s own count-based text, which has no better page-specific default to preserve (unlike a tag/film-stock page's description, left untouched). */
function rewriteDescription(html: string, description: string): string {
  return html
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${description}">`)
    .replace(
      /<meta property="og:description" content="[^"]*">/,
      `<meta property="og:description" content="${description}">`,
    );
}

function isAuthenticated(config: ServeConfig, req: IncomingMessage): boolean {
  const token = readSessionCookie(req.headers.cookie);
  return verifySessionToken(config.sessionSecret, token);
}

async function readPassword(req: IncomingMessage): Promise<string> {
  const body = await text(req);
  return new URLSearchParams(body).get('password') ?? '';
}

async function route(
  config: ServeConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // Everything under /private is handled here, never falling through to
  // static file serving — private/ is never inside site/dist to begin
  // with, but this keeps the routing itself explicit about the boundary
  // rather than relying only on that filesystem fact.
  if (pathname === '/private' && method === 'GET') {
    if (isAuthenticated(config, req)) {
      sendHtml(res, 200, renderArchive(loadNotes(config.notesPath)));
    } else {
      sendHtml(res, 200, renderGate(false));
    }
    return;
  }

  if (pathname === '/private/login' && method === 'POST') {
    const password = await readPassword(req);
    if (passwordMatches(config.sessionSecret, password, config.password)) {
      const token = createSessionToken(config.sessionSecret);
      res.writeHead(303, { 'set-cookie': setSessionCookie(token), location: '/private' });
      res.end();
    } else {
      sendHtml(res, 401, renderGate(true));
    }
    return;
  }

  if (pathname === '/private/logout' && method === 'POST') {
    res.writeHead(303, { 'set-cookie': clearSessionCookie(), location: '/private' });
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
    await sendFile(res, join(config.privatePhotosDir, file));
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
    // kept) or a generated share link (?s=..., /photography/share/ only)
    // each name real content a link-preview bot can never decode itself —
    // this is the one place either gets reflected into the static HTML,
    // per request, before it's served.
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const photoId = query.get('photo');
    const sharedIds = pathname === '/photography/share/' ? query.get('s') : null;
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
        const preview = await findSharePreview(config.generatedAlbumsDir, sharedIds);
        if (preview !== null) {
          const description = `A shared selection of ${preview.count.toString()} photograph${preview.count === 1 ? '' : 's'}.`;
          html = rewriteDescription(rewriteOgImage(html, config, preview), description);
        }
      }
      sendHtml(res, 200, html);
      return;
    }

    await sendFile(
      res,
      join(config.distDir, relativeWithoutSlash),
      cacheControlFor(relativeWithoutSlash),
      () => sendNotFoundPage(res, config.distDir),
    );
    return;
  }

  sendText(res, 404, 'Not found');
}

function handleRequest(config: ServeConfig, req: IncomingMessage, res: ServerResponse): void {
  route(config, req, res).catch((error: unknown) => {
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
  return createServer((req, res) => {
    handleRequest(config, req, res);
  });
}
