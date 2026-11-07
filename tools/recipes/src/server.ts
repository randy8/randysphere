import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { Screenshot } from './extract.ts';
import { checkUrl, draftRecipe, readCaption, saveRecipe, status } from './importer.ts';
import type { ImporterDeps } from './importer.ts';

/**
 * The importer's local web page and its JSON API. Like `pnpm run edit`, it
 * writes to the repository with no authentication, so the CLI binds it to
 * 127.0.0.1 only. Loopback alone isn't enough for a page that writes files:
 * any website open in the same browser can send requests to 127.0.0.1, and
 * a DNS-rebinding page can even read the answers. So every request must name
 * this server in its Host header, and every write must be JSON (which a
 * cross-site form can't send without a CORS preflight this server never
 * approves) from this server's own origin.
 */

const STATIC_DIRECTORY = join(import.meta.dirname, 'static');

interface StaticFile {
  readonly path: string;
  readonly type: string;
}

export interface ServerOptions {
  /** The site's self-hosted Newsreader, so the importer reads like Dishes. */
  readonly fontsDirectory: string;
}

function staticFiles(fontsDirectory: string): ReadonlyMap<string, StaticFile> {
  return new Map([
    ['/', { path: join(STATIC_DIRECTORY, 'index.html'), type: 'text/html; charset=utf-8' }],
    ['/app.js', { path: join(STATIC_DIRECTORY, 'app.js'), type: 'text/javascript; charset=utf-8' }],
    [
      '/styles.css',
      { path: join(STATIC_DIRECTORY, 'styles.css'), type: 'text/css; charset=utf-8' },
    ],
    [
      '/fonts/newsreader-variable.woff2',
      { path: join(fontsDirectory, 'newsreader-variable.woff2'), type: 'font/woff2' },
    ],
    [
      '/fonts/newsreader-variable-italic.woff2',
      { path: join(fontsDirectory, 'newsreader-variable-italic.woff2'), type: 'font/woff2' },
    ],
  ]);
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

/** 1 MB for links and drafts; a draft request carries up to four screenshots, downscaled in the page first. */
const SMALL_BODY = 1024 * 1024;
const DRAFT_BODY = 24 * 1024 * 1024;

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit)
      throw new HttpError(
        413,
        'That’s too much to send at once — try fewer or smaller screenshots.',
      );
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request wasn’t valid JSON.');
  }
}

export const MAX_SCREENSHOTS = 4;
/** The API's own per-image limit. */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/** The image type from its first bytes — the declared type is never trusted. */
export function sniffImage(bytes: Buffer): Screenshot['mediaType'] | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  return null;
}

export function parseScreenshots(value: unknown): Screenshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Screenshots must be a list.');
  if (value.length > MAX_SCREENSHOTS) {
    throw new HttpError(400, `Up to ${String(MAX_SCREENSHOTS)} screenshots at a time.`);
  }
  return value.map((item: unknown) => {
    const data = typeof item === 'string' ? item.replace(/^data:[^,]*,/, '') : '';
    if (!/^[A-Za-z0-9+/]+=*$/.test(data))
      throw new HttpError(400, 'A screenshot couldn’t be read.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_SCREENSHOT_BYTES)
      throw new HttpError(413, 'A screenshot is larger than 5 MB.');
    const mediaType = sniffImage(bytes);
    if (mediaType === null)
      throw new HttpError(415, 'Screenshots must be JPEG, PNG, WebP or GIF images.');
    return { mediaType, data };
  });
}

/** True for `127.0.0.1:<port>` and `localhost:<port>` — the only names this server answers to. */
export function isOwnHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;
}

function guardWrite(req: IncomingMessage, port: number): void {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  const origin = req.headers.origin;
  if (origin !== undefined && !isOwnHost(origin.replace(/^http:\/\//, ''), port)) {
    throw new HttpError(403, 'Forbidden.');
  }
}

async function route(
  deps: ImporterDeps,
  files: ReadonlyMap<string, StaticFile>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // The port actually bound, so the check holds whatever --port said.
  const port = req.socket.localPort ?? 0;
  if (!isOwnHost(req.headers.host, port)) throw new HttpError(421, 'Misdirected request.');
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET') {
    if (pathname === '/api/status') {
      sendJson(res, 200, await status(deps));
      return;
    }
    const file = files.get(pathname);
    if (file === undefined) throw new HttpError(404, 'Not found.');
    send(res, 200, file.type, await readFile(file.path));
    return;
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  guardWrite(req, port);

  if (pathname === '/api/check') {
    const body = (await readJson(req, SMALL_BODY)) as { url?: unknown };
    const result = checkUrl(deps, body.url);
    sendJson(res, 200, result.ok ? { ok: true, url: result.reel.url } : result);
    return;
  }
  if (pathname === '/api/caption') {
    const body = (await readJson(req, SMALL_BODY)) as { url?: unknown };
    sendJson(res, 200, await readCaption(deps, body.url));
    return;
  }
  if (pathname === '/api/draft') {
    const body = (await readJson(req, DRAFT_BODY)) as Record<string, unknown>;
    sendJson(
      res,
      200,
      await draftRecipe(deps, {
        url: body['url'],
        text: body['text'],
        textFromCaption: body['textFromCaption'],
        creator: body['creator'],
        creatorName: body['creatorName'],
        screenshots: parseScreenshots(body['screenshots']),
      }),
    );
    return;
  }
  if (pathname === '/api/save') {
    const body = await readJson(req, SMALL_BODY);
    const result = saveRecipe(deps, body);
    sendJson(res, result.ok ? 201 : 409, result);
    return;
  }
  throw new HttpError(404, 'Not found.');
}

/** The importer's server. Binding it to 127.0.0.1 only is the caller's job — it writes with no authentication. */
export function createImporterServer(deps: ImporterDeps, options: ServerOptions): Server {
  const files = staticFiles(options.fontsDirectory);
  return createServer((req, res) => {
    route(deps, files, req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, message: error.message });
        return;
      }
      console.error(error);
      sendJson(res, 500, {
        ok: false,
        message: 'Something went wrong in the importer. See its terminal.',
      });
    });
  });
}
