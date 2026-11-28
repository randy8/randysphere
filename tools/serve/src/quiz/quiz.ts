/**
 * /trivia — an original television-style quiz game: rooms, roles, the
 * buzzer, the editor, the catalog. Mounted by tools/serve beside the chats
 * and answers only for its own path; its WebSocket endpoint is /trivia/ws.
 * Nothing here reads anything but private/quiz/ (its database, media and
 * themes) and its own static files.
 *
 * Roles and credentials. Every participant holds a random token for one
 * role in one room — host, co-host, player, spectator or device — sent as
 * the first WebSocket message, never in a URL the server sees (links carry
 * it in the fragment), never logged. The room code is only an address: it
 * lets someone join as a new player or watch, never act as anyone else.
 *
 * One authority per room. A process serves a room while it holds the
 * room's lease (owner + lease_until in the database, renewed every
 * LEASE_MS / 3); a deploy's candidate server, or a second process, finds
 * the lease held and refuses the room rather than run a second copy of it.
 * On SIGTERM the lease is released after a final snapshot, so the next
 * process picks the game up — paused — when the first device reconnects.
 */

import { randomBytes, randomInt } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import type { Duplex } from 'node:stream';
import { extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { clientAddress } from '../login-limiter.ts';
import {
  createCustom,
  deleteEpisode,
  ensureSource,
  importEpisode,
  keyMatches,
  listEpisodes,
  loadEpisode,
  practiceAnswer,
  practiceClue,
  randomGame,
  updateCustom,
} from './catalog.ts';
import { openDatabase } from './db.ts';
import { matches } from './engine/answer.ts';
import type { GameData, Settings } from './engine/types.ts';
import { DEFAULT_SETTINGS } from './engine/types.ts';
import { parseDataset } from './importer.ts';
import { renderPage } from './pages.ts';
import type { PageName } from './pages.ts';
import { MAX_MESSAGE_BYTES, parseMessage } from './protocol.ts';
import { encode, toSvg } from './qr.ts';
import { hashToken, Room, SOLO_SETTINGS } from './room.ts';
import type { Connection } from './room.ts';
import { InvalidGame, parseGame, playable, toFile } from './validate.ts';

const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url));
const DEMO = fileURLToPath(new URL('./data/demo.json', import.meta.url));

export const LEASE_MS = 60_000;
const PING_MS = 2000;
/** No pong for this long and the connection is presumed dead. */
const DEAD_MS = 12_000;
/** A room nobody is connected to is unloaded from memory after this. */
const IDLE_UNLOAD_MS = 30 * 60_000;
/** …and deleted entirely (results are kept) after this. */
const ROOM_TTL_MS = 24 * 60 * 60_000;
export const MAX_ROOMS_IN_MEMORY = 100;
const MAX_CONNECTIONS_PER_ROOM = 24;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_BOARD_BYTES = 512 * 1024;
/** No vowels, no look-alikes: a code can't spell a word or be misread across a room. */
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "media-src 'self' https:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': CSP,
};

const STATIC_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export interface QuizConfig {
  /** private/quiz — quiz.db, media/, themes/. */
  readonly dataDir: string;
  /** The address phones on the LAN can reach this server at directly (docs/quiz.md), if any. */
  readonly lanOrigin?: string | null;
  /** Seed the demonstration set into an empty catalog (on unless a test says otherwise). */
  readonly seedDemo?: boolean;
  /** Structured log lines; never given a token. */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  /** Tests: the per-address limits. */
  readonly limits?: { rooms: number; joins: number; boards: number };
}

/** A fixed window per client address. Small, in memory, forgotten on restart — it slows abuse, nothing more. */
class Window {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'too large');
  const type = req.headers['content-type'] ?? '';
  // A cross-site form can't send application/json without a preflight this server never answers.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'JSON only');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'not JSON');
  }
}

const isObj = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** What a host may choose. Everything else is the rules. */
export function settingsFrom(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const s = isObj(input) ? input : {};
  const roundMinutes = s['roundMinutes'];
  return {
    maxPlayers: bounded(s['maxPlayers'], 1, 6, base.maxPlayers),
    responseMs: bounded(s['responseSeconds'], 2, 60, base.responseMs / 1000) * 1000,
    buzzWindowMs: bounded(s['buzzWindowSeconds'], 2, 60, base.buzzWindowMs / 1000) * 1000,
    wagerResponseMs: bounded(s['wagerResponseSeconds'], 3, 120, base.wagerResponseMs / 1000) * 1000,
    finalMs: bounded(s['finalSeconds'], 10, 180, base.finalMs / 1000) * 1000,
    lockoutMs: bounded(s['lockoutMs'], 0, 1000, base.lockoutMs),
    roundTimeMs:
      typeof roundMinutes === 'number' && roundMinutes > 0
        ? bounded(roundMinutes, 1, 60, 12) * 60_000
        : base.roundTimeMs,
    tiebreak: typeof s['tiebreak'] === 'boolean' ? s['tiebreak'] : base.tiebreak,
  };
}

/** The scheme and host a browser used to reach us (cloudflared sets X-Forwarded-Proto). */
function originOf(req: IncomingMessage): string {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host =
    typeof req.headers.host === 'string' && /^[A-Za-z0-9.:[\]-]{1,255}$/.test(req.headers.host)
      ? req.headers.host
      : 'localhost';
  return `${proto}://${host}`;
}

let connectionIds = 0;

/** A WebSocket frame's text, whatever shape `ws` hands it over in. */
export function rawText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class Quiz {
  readonly db: DatabaseSync;
  readonly rooms = new Map<string, Room>();
  /** This process, as the lease's owner. */
  readonly owner = `${hostname()}:${String(process.pid)}:${randomBytes(4).toString('hex')}`;
  private readonly config: QuizConfig;
  private readonly wss: WebSocketServer;
  private readonly roomLimit: Window;
  private readonly joinLimit: Window;
  private readonly boardLimit: Window;
  private readonly timers: NodeJS.Timeout[] = [];
  private pingCount = 0;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;

  constructor(config: QuizConfig) {
    this.config = config;
    this.log = config.log ?? ((event, fields) => console.log(JSON.stringify({ event, ...fields })));
    this.db = openDatabase(join(config.dataDir, 'quiz.db'));
    if (config.seedDemo !== false) this.seedDemo();
    this.roomLimit = new Window(config.limits?.rooms ?? 30, 60 * 60_000);
    this.joinLimit = new Window(config.limits?.joins ?? 60, 60 * 60_000);
    this.boardLimit = new Window(config.limits?.boards ?? 60, 60 * 60_000);
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    this.timers.push(setInterval(() => this.heartbeat(), PING_MS).unref());
    this.timers.push(setInterval(() => this.renewLeases(), LEASE_MS / 3).unref());
    this.timers.push(setInterval(() => this.cleanup(), 60_000).unref());
  }

  /** The original demonstration set, so a fresh install can play at once. Idempotent. */
  private seedDemo(): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sources WHERE name = 'Demonstration set'")
      .get() as { n: number };
    if (row.n > 0) return;
    const dataset = parseDataset('demo.json', readFileSync(DEMO, 'utf8'));
    const source = ensureSource(
      this.db,
      dataset.source ?? { name: 'Demonstration set', license: 'MIT' },
    );
    for (const game of dataset.games) importEpisode(this.db, game, source, { listed: true });
  }

  // -------------------------------------------------------------------------
  // Rooms

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = Array.from(
        { length: 4 },
        () => CODE_LETTERS[randomInt(CODE_LETTERS.length)],
      ).join('');
      const taken = this.db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code);
      if (!taken && !this.rooms.has(code)) return code;
    }
    throw new HttpError(503, 'no room codes free; try again');
  }

  private takeLease(code: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE rooms SET owner = ?, lease_until = ? WHERE code = ? AND (owner IS NULL OR owner = ? OR lease_until < ?)',
      )
      .run(this.owner, now + LEASE_MS, code, this.owner, now);
    return Number(result.changes) === 1;
  }

  /** The room, loaded from its snapshot if this process doesn't have it yet and nobody else holds it. */
  room(code: string): Room | null {
    const loaded = this.rooms.get(code);
    if (loaded) return loaded.closed ? null : loaded;
    if (this.rooms.size >= MAX_ROOMS_IN_MEMORY) this.evictIdle(true);
    if (this.rooms.size >= MAX_ROOMS_IN_MEMORY) return null;
    if (!this.takeLease(code)) return null;
    const room = Room.load({ db: this.db, code, log: this.log });
    if (!room) return null;
    this.rooms.set(code, room);
    this.log('quiz_room_restored', { room: code, phase: room.state.phase });
    return room;
  }

  createRoom(
    game: GameData,
    options: {
      mode: 'hosted' | 'solo';
      settings: Settings;
      theme: string;
      episodeId: number | null;
    },
  ): Room {
    if (this.rooms.size >= MAX_ROOMS_IN_MEMORY) this.evictIdle(true);
    if (this.rooms.size >= MAX_ROOMS_IN_MEMORY)
      throw new HttpError(503, 'too many games in progress; try again later');
    const code = this.newCode();
    const room = new Room({
      db: this.db,
      code,
      mode: options.mode,
      theme: options.theme,
      episodeId: options.episodeId,
      init: { data: game, settings: options.settings, seed: randomInt(2 ** 31) },
      log: this.log,
    });
    room.insert();
    this.takeLease(code);
    this.rooms.set(code, room);
    this.log('quiz_room_created', { room: code, mode: options.mode, title: game.title });
    return room;
  }

  private unload(room: Room): void {
    room.shutdown();
    for (const connection of room.connections) connection.close(1012, 'moved');
    this.db
      .prepare('UPDATE rooms SET lease_until = 0 WHERE code = ? AND owner = ?')
      .run(room.code, this.owner);
    this.rooms.delete(room.code);
  }

  private evictIdle(force = false): void {
    const now = Date.now();
    const idle = [...this.rooms.values()]
      .filter(
        (room) =>
          room.closed ||
          (room.connections.size === 0 && (force || now - room.activeAt > IDLE_UNLOAD_MS)),
      )
      .sort((a, b) => a.activeAt - b.activeAt);
    for (const room of force ? idle.slice(0, 10) : idle) this.unload(room);
  }

  private renewLeases(): void {
    const update = this.db.prepare('UPDATE rooms SET lease_until = ? WHERE code = ? AND owner = ?');
    for (const room of this.rooms.values())
      update.run(Date.now() + LEASE_MS, room.code, this.owner);
  }

  cleanup(): void {
    this.evictIdle();
    const cutoff = Date.now() - ROOM_TTL_MS;
    const expired = this.db
      .prepare('SELECT code FROM rooms WHERE active_at < ? AND lease_until < ?')
      .all(cutoff, Date.now()) as { code: string }[];
    for (const { code } of expired) {
      if (this.rooms.has(code)) continue;
      this.db.prepare('DELETE FROM rooms WHERE code = ?').run(code);
    }
    if (expired.length > 0) this.log('quiz_rooms_expired', { count: expired.length });
  }

  private heartbeat(): void {
    this.pingCount += 1;
    const now = performance.now();
    for (const room of this.rooms.values()) {
      for (const connection of room.connections) {
        if (now - connection.lastSeen > DEAD_MS) connection.close(4008, 'no heartbeat');
      }
      room.ping(this.pingCount);
      const diag = room.diagnostics();
      for (const connection of room.connections) {
        if (connection.role === 'host' || connection.role === 'cohost') connection.send(diag);
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket

  /** Takes over an HTTP upgrade for /trivia/ws; false for anything else. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // /quiz/ws is the address before the move to /trivia/ (2026-11-28): a
    // page loaded before then still reconnects.
    if (url.pathname !== '/trivia/ws' && url.pathname !== '/quiz/ws') return false;
    // Same-origin only. Tokens travel in messages, not cookies, so this
    // isn't what keeps a room safe — it keeps other sites from using the
    // endpoint at all.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        host = '';
      }
      if (host !== req.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return true;
      }
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, req));
    return true;
  }

  private connect(ws: WebSocket, req: IncomingMessage): void {
    const origin = originOf(req);
    const send = (message: object | string): void => {
      if (ws.readyState === ws.OPEN)
        ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    };
    let bound: { room: Room; connection: Connection } | null = null;
    let budget = 40;
    let refill = performance.now();
    let strikes = 0;
    const helloTimer = setTimeout(() => ws.close(4001, 'hello expected'), 5000);

    ws.on('message', (data, isBinary) => {
      // A token bucket: 20 messages a second, bursts of 40. A held-down
      // buzzer is one press (the client ignores key repeat); this is for
      // anything else.
      const now = performance.now();
      budget = Math.min(40, budget + ((now - refill) / 1000) * 20);
      refill = now;
      if (budget < 1) {
        strikes += 1;
        if (strikes > 100) ws.close(1008, 'rate');
        return;
      }
      budget -= 1;
      const message = isBinary ? null : parseMessage(rawText(data));
      if (!message) {
        strikes += 5;
        send({ type: 'error', error: 'bad message' });
        if (strikes > 100) ws.close(1008, 'bad messages');
        return;
      }
      if (!bound) {
        if (message.type !== 'hello') {
          ws.close(4001, 'hello expected');
          return;
        }
        clearTimeout(helloTimer);
        const room = this.room(message.code);
        if (!room) {
          ws.close(4004, 'no such room');
          return;
        }
        const hash = hashToken(message.token);
        const info = room.tokens.get(hash);
        if (!info) {
          ws.close(4003, 'not admitted');
          return;
        }
        if (room.connections.size >= MAX_CONNECTIONS_PER_ROOM) {
          ws.close(4009, 'room full');
          return;
        }
        const connection: Connection = {
          id: (connectionIds += 1),
          role: info.role,
          playerId: info.playerId,
          tokenHash: hash,
          send,
          close: (code, reason) => ws.close(code, reason),
          rtt: [],
          pings: new Map(),
          sent: 0,
          lost: 0,
          connectedAt: performance.now(),
          lastSeen: performance.now(),
        };
        bound = { room, connection };
        send({
          type: 'welcome',
          role: info.role,
          playerId: info.playerId,
          code: room.code,
          mode: room.mode,
          theme: room.theme,
          joinUrl: `${origin}/trivia/join/${room.code}`,
          lanJoinUrl: this.config.lanOrigin
            ? `${this.config.lanOrigin}/trivia/join/${room.code}`
            : null,
          displayUrl: `${origin}/trivia/display/${room.code}`,
        });
        room.attach(connection);
        return;
      }
      bound.room.handle(
        bound.connection,
        message,
        (kind, token) => `${origin}/trivia/${kind}/${bound?.room.code ?? ''}#${token}`,
      );
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (bound) bound.room.detach(bound.connection);
    });
    ws.on('error', () => ws.terminate());
  }

  // -------------------------------------------------------------------------
  // HTTP

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { pathname } = url;
    // The game lived at /quiz/ until 2026-11-28; its links (and any media
    // address written into a game) keep working. 308 keeps the method and
    // body; a browser carries the #token fragment across on its own.
    if (pathname === '/quiz' || pathname.startsWith('/quiz/')) {
      res.writeHead(308, { location: `/trivia${pathname.slice('/quiz'.length)}${url.search}` });
      res.end();
      return true;
    }
    if (pathname !== '/trivia' && !pathname.startsWith('/trivia/')) return false;
    try {
      await this.route(req, res, url);
    } catch (error) {
      if (error instanceof HttpError) sendJson(res, error.status, { error: error.message });
      else if (error instanceof InvalidGame) sendJson(res, 400, { error: error.message });
      else {
        this.log('quiz_error', { path: pathname, error: String(error) });
        sendJson(res, 500, { error: 'internal error' });
      }
    }
    return true;
  }

  private page(res: ServerResponse, name: PageName, data: Record<string, string> = {}): void {
    res.writeHead(200, PAGE_HEADERS);
    res.end(renderPage(name, data));
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url;
    const method = req.method ?? 'GET';
    const get = method === 'GET' || method === 'HEAD';
    const client = clientAddress(req);
    let match: RegExpMatchArray | null = null;

    if (pathname === '/trivia') {
      res.writeHead(301, { location: '/trivia/' });
      res.end();
      return;
    }
    if (get && pathname === '/trivia/') return this.page(res, 'home');
    if (get && pathname === '/trivia/host/') return this.page(res, 'setup');
    if (get && (match = pathname.match(/^\/trivia\/(host|play|display|solo)\/([A-Z]{4})$/))) {
      return this.page(res, match[1] as PageName, { code: match[2] ?? '' });
    }
    if (
      get &&
      (pathname === '/trivia/join/' || (match = pathname.match(/^\/trivia\/join\/([A-Z]{4})$/)))
    ) {
      return this.page(res, 'join', { code: match?.[1] ?? '' });
    }
    if (get && pathname === '/trivia/solo/') return this.page(res, 'solosetup');
    if (get && pathname === '/trivia/practice/') return this.page(res, 'practice');
    if (get && pathname === '/trivia/edit/') return this.page(res, 'boards');
    if (get && (match = pathname.match(/^\/trivia\/edit\/(\d{1,9})$/)))
      return this.page(res, 'edit', { board: match[1] ?? '' });

    if (get && pathname.startsWith('/trivia/static/'))
      return this.file(
        req,
        res,
        STATIC_DIR,
        pathname.slice('/trivia/static/'.length),
        'public, max-age=300',
      );
    if (
      get &&
      (match = pathname.match(/^\/trivia\/themes\/([a-z0-9-]{1,40})\/([A-Za-z0-9._-]{1,80})$/))
    ) {
      const [, theme = '', file = ''] = match;
      const own = join(STATIC_DIR, 'themes', theme);
      const dir = existsSync(join(own, file)) ? own : join(this.config.dataDir, 'themes', theme);
      return this.file(req, res, dir, file, 'public, max-age=300');
    }
    if (get && (match = pathname.match(/^\/trivia\/media\/([A-Za-z0-9._-]{1,120})$/))) {
      return this.file(
        req,
        res,
        join(this.config.dataDir, 'media'),
        match[1] ?? '',
        'public, max-age=3600',
      );
    }

    // ---- API
    if (get && pathname === '/trivia/api/library') {
      return sendJson(res, 200, {
        episodes: listEpisodes(this.db, { listed: true }),
        themes: this.themes(),
        lan: this.config.lanOrigin ?? null,
      });
    }
    if (get && pathname === '/trivia/api/health') {
      let connections = 0;
      for (const room of this.rooms.values()) connections += room.connections.size;
      return sendJson(res, 200, { ok: true, rooms: this.rooms.size, connections });
    }
    if (method === 'POST' && pathname === '/trivia/api/rooms') {
      if (!this.roomLimit.allow(client))
        throw new HttpError(429, 'too many games started from here; try again later');
      const body = await readJson(req);
      const { game, episodeId } = this.gameFrom(isObj(body) ? body['source'] : null);
      const room = this.createRoom(game, {
        mode: 'hosted',
        settings: settingsFrom(isObj(body) ? body['settings'] : null),
        theme: this.theme(isObj(body) ? body['theme'] : null),
        episodeId,
      });
      const token = room.issue('host', null);
      return sendJson(res, 201, {
        code: room.code,
        token,
        url: `/trivia/host/${room.code}#${token}`,
      });
    }
    if (method === 'POST' && pathname === '/trivia/api/solo') {
      if (!this.roomLimit.allow(client))
        throw new HttpError(429, 'too many games started from here; try again later');
      const body = await readJson(req);
      const { game, episodeId } = this.gameFrom(isObj(body) ? body['source'] : null);
      const room = this.createRoom(game, {
        mode: 'solo',
        settings: settingsFrom({}, { ...DEFAULT_SETTINGS, ...SOLO_SETTINGS }),
        theme: this.theme(isObj(body) ? body['theme'] : null),
        episodeId,
      });
      const joined = room.join(
        isObj(body) && typeof body['name'] === 'string' && body['name'].trim()
          ? body['name']
          : 'Player',
      );
      if ('error' in joined) throw new HttpError(400, joined.error);
      return sendJson(res, 201, {
        code: room.code,
        token: joined.token,
        url: `/trivia/solo/${room.code}#${joined.token}`,
      });
    }
    if ((match = pathname.match(/^\/trivia\/api\/rooms\/([A-Z]{4})(\/[a-z.]+)?$/))) {
      const code = match[1] ?? '';
      const action = match[2] ?? '';
      const room = this.room(code);
      if (!room || room.mode !== 'hosted') throw new HttpError(404, 'no game with that code');
      if (get && action === '') {
        return sendJson(res, 200, {
          code,
          title: room.state.data.title,
          phase: room.state.phase,
          players: room.state.players.filter((player) => !player.removed).length,
          maxPlayers: room.state.settings.maxPlayers,
          theme: room.theme,
        });
      }
      if (method === 'POST' && action === '/join') {
        if (!this.joinLimit.allow(client))
          throw new HttpError(429, 'too many joins from here; try again later');
        const body = await readJson(req);
        const name = isObj(body) && typeof body['name'] === 'string' ? body['name'] : '';
        const joined = room.join(name);
        if ('error' in joined) throw new HttpError(409, joined.error);
        return sendJson(res, 201, {
          token: joined.token,
          playerId: joined.playerId,
          url: `/trivia/play/${code}#${joined.token}`,
        });
      }
      if (method === 'POST' && action === '/watch') {
        if (!this.joinLimit.allow(client))
          throw new HttpError(429, 'too many requests from here; try again later');
        return sendJson(res, 201, { token: room.issue('spectator', null) });
      }
      if (get && action === '/qr.svg') {
        const base =
          url.searchParams.get('via') === 'lan' && this.config.lanOrigin
            ? this.config.lanOrigin
            : originOf(req);
        res.writeHead(200, {
          'content-type': 'image/svg+xml',
          'cache-control': 'private, max-age=300',
        });
        res.end(toSvg(encode(`${base}/trivia/join/${code}`, 'M')));
        return;
      }
      throw new HttpError(404, 'not found');
    }
    if (get && pathname === '/trivia/api/practice') {
      const clue = practiceClue(
        this.db,
        Math.random,
        url.searchParams.get('q')?.slice(0, 60) || null,
      );
      if (!clue) throw new HttpError(404, 'no clues match');
      return sendJson(res, 200, clue);
    }
    if (method === 'POST' && pathname === '/trivia/api/practice/check') {
      const body = await readJson(req);
      const id = isObj(body) && typeof body['id'] === 'number' ? body['id'] : NaN;
      const given =
        isObj(body) && typeof body['response'] === 'string' ? body['response'].slice(0, 300) : '';
      const answer = Number.isInteger(id) ? practiceAnswer(this.db, id) : null;
      if (!answer) throw new HttpError(404, 'no such clue');
      return sendJson(res, 200, {
        correct: matches(given, answer.response, answer.accept),
        ...answer,
      });
    }

    // ---- The editor: a board belongs to whoever holds its key.
    if (method === 'POST' && pathname === '/trivia/api/boards') {
      if (!this.boardLimit.allow(client))
        throw new HttpError(429, 'too many new boards from here; try again later');
      const body = await readJson(req, MAX_BOARD_BYTES);
      const file =
        isObj(body) && body['game'] !== undefined
          ? parseGame(body['game'], { draft: true })
          : parseGame(blankGame(), { draft: true });
      const key = randomBytes(24).toString('base64url');
      const id = createCustom(this.db, file.game, key);
      this.log('quiz_board_created', { board: id });
      return sendJson(res, 201, { id, key, url: `/trivia/edit/${String(id)}#${key}` });
    }
    if ((match = pathname.match(/^\/trivia\/api\/boards\/(\d{1,9})$/))) {
      const id = Number(match[1]);
      const key = req.headers['x-edit-key'];
      if (typeof key !== 'string' || !keyMatches(this.db, id, key))
        throw new HttpError(404, 'no such board, or the wrong key');
      if (get) {
        const loaded = loadEpisode(this.db, id);
        if (!loaded) throw new HttpError(404, 'no such board');
        return sendJson(res, 200, {
          id,
          game: toFile(loaded.game),
          playable: playable(loaded.game),
        });
      }
      if (method === 'PUT') {
        const file = parseGame(await readJson(req, MAX_BOARD_BYTES), { draft: true });
        updateCustom(this.db, id, file.game);
        return sendJson(res, 200, { ok: true, playable: playable(file.game) });
      }
      if (method === 'DELETE') {
        deleteEpisode(this.db, id);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (get && pathname.startsWith('/trivia/')) throw new HttpError(404, 'not found');
    throw new HttpError(405, 'method not allowed');
  }

  /** A game to play: a listed episode, a random board, or a custom board with its key. */
  private gameFrom(source: unknown): { game: GameData; episodeId: number | null } {
    const s = isObj(source) ? source : { type: 'random' };
    if (s['type'] === 'episode' && typeof s['id'] === 'number') {
      const listed = listEpisodes(this.db, { id: s['id'], listed: true })[0];
      const loaded = listed ? loadEpisode(this.db, listed.id) : null;
      if (!loaded) throw new HttpError(404, 'no such episode');
      return { game: loaded.game, episodeId: listed?.id ?? null };
    }
    if (s['type'] === 'board' && typeof s['id'] === 'number' && typeof s['key'] === 'string') {
      if (!keyMatches(this.db, s['id'], s['key']))
        throw new HttpError(404, 'no such board, or the wrong key');
      const loaded = loadEpisode(this.db, s['id']);
      if (!loaded) throw new HttpError(404, 'no such board');
      const problem = playable(loaded.game);
      if (problem) throw new HttpError(400, `This board isn't ready: ${problem}.`);
      return { game: loaded.game, episodeId: s['id'] };
    }
    const query = typeof s['query'] === 'string' ? s['query'].slice(0, 60) : null;
    const game = randomGame(this.db, Math.random, { query });
    if (!game)
      throw new HttpError(409, 'not enough complete categories in the library for a random board');
    return { game, episodeId: null };
  }

  themes(): string[] {
    const names = new Set<string>();
    for (const dir of [join(STATIC_DIR, 'themes'), join(this.config.dataDir, 'themes')]) {
      try {
        for (const name of readdirSync(dir))
          if (/^[a-z0-9-]{1,40}$/.test(name) && existsSync(join(dir, name, 'theme.json')))
            names.add(name);
      } catch {
        // No such directory.
      }
    }
    return [...names].sort();
  }

  private theme(value: unknown): string {
    return typeof value === 'string' && this.themes().includes(value) ? value : 'classic';
  }

  private file(
    req: IncomingMessage,
    res: ServerResponse,
    dir: string,
    relative: string,
    cache: string,
  ): void {
    if (
      !relative ||
      relative.split('/').some((part) => part === '..' || part === '' || part.startsWith('.'))
    ) {
      throw new HttpError(400, 'bad path');
    }
    const path = join(dir, relative);
    let size: number;
    try {
      const info = statSync(path);
      if (!info.isFile()) throw new Error('not a file');
      size = info.size;
    } catch {
      throw new HttpError(404, 'not found');
    }
    const type = STATIC_TYPES[extname(path).toLowerCase()];
    if (!type) throw new HttpError(404, 'not found');
    res.writeHead(200, {
      'content-type': type,
      'content-length': String(size),
      'cache-control': cache,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path).pipe(res);
  }

  /** Final snapshots, leases released, every socket told to reconnect (1012) — then cut after a moment. */
  shutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const room of [...this.rooms.values()]) this.unload(room);
    for (const client of this.wss.clients) client.close(1012, 'restarting');
    setTimeout(() => {
      for (const client of this.wss.clients) client.terminate();
    }, 500).unref();
    this.wss.close();
  }

  /** Tests: shut down and let go of the database at once. */
  close(): void {
    this.shutdown();
    for (const client of this.wss.clients) client.terminate();
    this.db.close();
  }
}

/** A new board: two rounds of six empty categories, a final, a tiebreaker. */
export function blankGame(): Record<string, unknown> {
  const blank = { text: '', response: '' };
  return {
    title: 'Untitled game',
    credit: '',
    rounds: [
      {
        kind: 'board',
        values: [200, 400, 600, 800, 1000],
        wagers: 1,
        questionForm: 'lenient',
        categories: Array.from({ length: 6 }, () => ({
          title: '',
          clues: Array.from({ length: 5 }, () => blank),
        })),
      },
      {
        kind: 'board',
        values: [400, 800, 1200, 1600, 2000],
        wagers: 2,
        questionForm: 'strict',
        categories: Array.from({ length: 6 }, () => ({
          title: '',
          clues: Array.from({ length: 5 }, () => blank),
        })),
      },
      { kind: 'final', category: '', clue: blank },
    ],
    tiebreakers: [{ category: '', clue: blank }],
  };
}
