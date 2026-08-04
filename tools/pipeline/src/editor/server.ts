import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { json } from 'node:stream/consumers';

import { PipelineError } from '../errors.ts';
import { derivativePath } from '../paths.ts';
import type { Paths } from '../paths.ts';
import type { ApplyEditsRequest, SetCoverRequest } from './api.ts';
import {
  applyEdits,
  deleteTagEverywhere,
  listPhotos,
  listTags,
  renameTagEverywhere,
  setCover,
} from './api.ts';

const STATIC_DIRECTORY = join(import.meta.dirname, 'static');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Rejects any path carrying a `..` segment, the only thing that could walk
 * `/media/` or the static root outside its own directory. In practice
 * `new URL()` already collapses dot-segments before `pathname` is ever read
 * (per the WHATWG URL Standard, regardless of what a raw client sent on the
 * wire), so this should never actually fire — kept anyway as an explicit,
 * cheap guard on a code path that reads arbitrary files off disk from
 * network input, rather than resting solely on that platform guarantee.
 */
export function isSafeRelativePath(relative: string): boolean {
  return relative.length > 0 && !relative.split('/').includes('..');
}

async function sendFile(res: ServerResponse, path: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await stat(path)).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    sendText(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
  });
  createReadStream(path).pipe(res);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return await json(req);
  } catch (cause) {
    throw new PipelineError('Request body was not valid JSON.', { cause });
  }
}

async function route(paths: Paths, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && pathname === '/api/photos') {
    sendJson(res, 200, await listPhotos(paths));
    return;
  }
  if (req.method === 'GET' && pathname === '/api/tags') {
    sendJson(res, 200, await listTags(paths));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/edits') {
    const body = (await readJsonBody(req)) as ApplyEditsRequest;
    const result = await applyEdits(paths, body);
    sendJson(res, result.ok ? 200 : 409, result);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/cover') {
    const body = (await readJsonBody(req)) as SetCoverRequest;
    await setCover(paths, body);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/tags/rename') {
    const body = (await readJsonBody(req)) as { from: string; to: string };
    sendJson(res, 200, await renameTagEverywhere(paths, body.from, body.to));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/tags/delete') {
    const body = (await readJsonBody(req)) as { tag: string };
    sendJson(res, 200, await deleteTagEverywhere(paths, body.tag));
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/media/')) {
    const key = pathname.slice('/media/'.length);
    if (!isSafeRelativePath(key)) {
      sendText(res, 400, 'Bad request');
      return;
    }
    await sendFile(res, derivativePath(paths, key));
    return;
  }
  if (req.method === 'GET') {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!isSafeRelativePath(relative)) {
      sendText(res, 400, 'Bad request');
      return;
    }
    await sendFile(res, join(STATIC_DIRECTORY, relative));
    return;
  }
  sendText(res, 404, 'Not found');
}

function handleRequest(paths: Paths, req: IncomingMessage, res: ServerResponse): void {
  route(paths, req, res).catch((error: unknown) => {
    if (error instanceof PipelineError) {
      sendJson(res, 400, { ok: false, message: error.message });
      return;
    }
    console.error(error);
    sendJson(res, 500, { ok: false, message: 'Internal error.' });
  });
}

/** Creates the editor's HTTP server. Binding it to `127.0.0.1` only (never `0.0.0.0`) is the caller's job — this writes to disk with no authentication. */
export function createEditorServer(paths: Paths): Server {
  return createServer((req, res) => {
    handleRequest(paths, req, res);
  });
}
