/**
 * The quiz over real sockets: a Quiz on a throwaway data directory behind
 * the quiz-only server, driven by `ws` clients exactly as phones drive it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { WebSocket } from 'ws';

import { createQuizOnlyServer } from '../server.ts';
import { Room } from './room.ts';
import { Quiz, rawText } from './quiz.ts';

interface Harness {
  quiz: Quiz;
  server: Server;
  base: string;
  dir: string;
}

const harnesses: Harness[] = [];
after(async () => {
  for (const h of [...harnesses]) await stop(h);
});

async function start(
  dir = mkdtempSync(join(tmpdir(), 'quiz-test-')),
  limits?: { rooms: number; joins: number; boards: number },
): Promise<Harness> {
  const quiz = new Quiz({ dataDir: dir, log: () => undefined, ...(limits ? { limits } : {}) });
  const server = createQuizOnlyServer(quiz);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const harness = { quiz, server, base: `http://127.0.0.1:${String(port)}`, dir };
  harnesses.push(harness);
  return harness;
}

async function stop(h: Harness): Promise<void> {
  const index = harnesses.indexOf(h);
  if (index !== -1) harnesses.splice(index, 1);
  h.quiz.close();
  h.server.closeAllConnections();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

async function post(
  h: Harness,
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

type Message = Record<string, unknown> & { type: string };
type View = Record<string, unknown> & { seq: number; phase: string };

class Client {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  view: View | null = null;
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(h: Harness, code: string, token: string) {
    this.ws = new WebSocket(`${h.base.replace('http', 'ws')}/trivia/ws`, {
      headers: { origin: h.base },
    });
    this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', code, token })));
    this.ws.on('message', (data) => {
      const message = JSON.parse(rawText(data)) as Message;
      if (message.type === 'ping') this.ws.send(JSON.stringify({ type: 'pong', n: message['n'] }));
      if (message.type === 'state') this.view = message['view'] as View;
      this.messages.push(message);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async until<T>(
    predicate: () => T | null | undefined | false,
    what = 'condition',
    ms = 3000,
  ): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}; last phase ${this.view?.phase ?? 'none'}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  phase(phase: string): Promise<View> {
    return this.until(() => (this.view?.phase === phase ? this.view : null), `phase ${phase}`);
  }

  /** Sends an action and waits for its acknowledgement. */
  async act(
    action: Record<string, unknown>,
    options: { expect?: number; id?: string } = {},
  ): Promise<Message> {
    const id = options.id ?? `m${String((this.n += 1))}${Math.random().toString(36).slice(2, 8)}`;
    this.ws.send(JSON.stringify({ type: 'act', id, action, expect: options.expect ?? null }));
    return this.until(
      () => this.messages.find((m) => m.type === 'ack' && m['id'] === id),
      `ack ${String(action['type'])}`,
    );
  }

  async must(action: Record<string, unknown>): Promise<void> {
    const ack = await this.act(action);
    assert.equal(ack['ok'], true, `${String(action['type'])}: ${String(ack['error'])}`);
  }

  close(): void {
    this.ws.close();
  }
}

async function hostedGame(h: Harness, settings: Record<string, unknown> = {}) {
  const created = await post(h, '/trivia/api/rooms', {
    source: { type: 'episode', id: 1 },
    settings,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const code = String(created.json['code']);
  const host = new Client(h, code, String(created.json['token']));
  await host.until(() => host.view, 'host state');
  const players: Client[] = [];
  for (const name of ['Ada', 'Grace', 'Alan']) {
    const joined = await post(h, `/trivia/api/rooms/${code}/join`, { name });
    assert.equal(joined.status, 201);
    players.push(new Client(h, code, String(joined.json['token'])));
  }
  for (const player of players) await player.until(() => player.view, 'player state');
  const watch = await post(h, `/trivia/api/rooms/${code}/watch`);
  const display = new Client(h, code, String(watch.json['token']));
  await display.until(() => display.view, 'display state');
  return { code, host, players, display, hostToken: String(created.json['token']) };
}

async function toBoard(host: Client): Promise<void> {
  await host.must({ type: 'start_game' });
  for (let i = 0; i <= 6; i += 1) await host.must({ type: 'intro_next' });
  await host.phase('board');
}

/** An ordinary (non-wager) clue on the current board, from the host's view. */
function ordinaryCell(host: Client): { col: number; row: number } {
  const board = host.view as unknown as {
    host: { board: { categories: { clues: ({ wager: boolean } | null)[] }[] } };
    board: { remaining: boolean[][] };
  };
  for (const [col, category] of board.host.board.categories.entries()) {
    for (const [row, clue] of category.clues.entries()) {
      if (clue && !clue.wager && board.board.remaining[col]?.[row]) return { col, row };
    }
  }
  throw new Error('no ordinary clue left');
}

test('a room code alone admits nobody; a token admits exactly its role', async () => {
  const h = await start();
  const { code, host, players, display } = await hostedGame(h);
  const stranger = new Client(h, code, 'x'.repeat(32));
  await stranger.until(() => stranger.closed, 'close');
  assert.equal(stranger.closed?.code, 4003);
  const crossSite = new WebSocket(`${h.base.replace('http', 'ws')}/trivia/ws`, {
    headers: { origin: 'https://evil.example' },
  });
  const refused = await new Promise<string>((resolve) => {
    crossSite.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
    crossSite.on('error', () => resolve('error'));
  });
  assert.equal(refused, '403');
  await toBoard(host);
  // A player may not act as the host; a spectator may not act at all.
  const player = players[0];
  assert.ok(player);
  for (const action of [
    { type: 'adjust', playerId: 'p1', score: 50000 },
    { type: 'next' },
    { type: 'open' },
    { type: 'reveal' },
  ]) {
    const ack = await player.act(action);
    assert.equal(ack['ok'], false);
  }
  assert.equal((await display.act({ type: 'buzz', seq: 1 }))['ok'], false);
  // Unknown and system-only actions are refused at the protocol.
  player.ws.send(
    JSON.stringify({
      type: 'act',
      id: 'sys1',
      action: { type: 'add_player', id: 'p9', name: 'X' },
    }),
  );
  await player.until(() => player.messages.find((m) => m.type === 'error'), 'error');
  // The host's own view holds the response; nobody else's does.
  const cell = ordinaryCell(host);
  await host.must({ type: 'select', ...cell });
  await host.phase('reading');
  const response = (host.view as unknown as { host: { response: string } }).host.response;
  assert.ok(response.length > 0);
  const leaked = [...players, display].some((client) =>
    JSON.stringify(client.messages).includes(`"${response}"`),
  );
  assert.equal(leaked, false, 'the response reached a player or the display');
});

test('three simultaneous buzzes: exactly one winner, and every device agrees on who', async () => {
  const h = await start();
  const { host, players, display } = await hostedGame(h);
  await toBoard(host);
  const cell = ordinaryCell(host);
  await host.must({ type: 'select', ...cell });
  await host.must({ type: 'open' });
  const open = await host.phase('open');
  // All three press "at once": the frames are written back to back.
  for (const player of players)
    player.ws.send(
      JSON.stringify({
        type: 'act',
        id: `b${String(Math.random()).slice(2)}`,
        action: { type: 'buzz', seq: open.seq },
      }),
    );
  const winner = await host.until(
    () =>
      host.view?.phase === 'responding'
        ? (host.view as unknown as { clue: { responder: string } }).clue.responder
        : null,
    'responder',
  );
  for (const client of [...players, display]) {
    await client.until(
      () =>
        (client.view as unknown as { clue?: { responder?: string } } | null)?.clue?.responder ===
        winner,
      'agreement',
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const wins = host.messages
    .flatMap((m) => (m.type === 'state' ? (m['cues'] as { type: string }[]) : []))
    .filter((cue) => cue.type === 'buzz');
  assert.equal(wins.length, 1, 'exactly one buzz won');
  assert.equal(
    players.flatMap((player) => player.messages.filter((m) => m.type === 'ack')).length,
    3,
    'every press acknowledged',
  );
  // The record is complete enough to replay to the same state.
  host.ws.send(
    JSON.stringify({
      type: 'act',
      id: 'r1',
      action: { type: 'rule', verdict: 'correct' },
      expect: host.view?.seq,
    }),
  );
  await host.phase('clue_end');
  const room = h.quiz.rooms.values().next().value as Room;
  room.flush();
  const replayed = Room.replay(h.quiz.db, room.code);
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(room.state)));
});

test('premature buzz locks out; incorrect reopens for the others; the stale command is refused', async () => {
  const h = await start();
  const { host, players } = await hostedGame(h);
  const [p1, p2] = players;
  assert.ok(p1 && p2);
  await toBoard(host);
  await host.must({ type: 'select', ...ordinaryCell(host) });
  const reading = await host.phase('reading');
  await p1.must({ type: 'buzz', seq: reading.seq });
  await host.until(
    () =>
      host.messages.some(
        (m) =>
          m.type === 'state' &&
          (m['cues'] as { type: string }[]).some((cue) => cue.type === 'lockout'),
      ),
    'lockout cue',
  );
  await host.must({ type: 'open' });
  const open = await host.phase('open');
  // p1 is inside the lockout when p2 presses; p2 wins.
  await p2.must({ type: 'buzz', seq: open.seq });
  const responding = await host.phase('responding');
  const ack = await host.act(
    { type: 'rule', verdict: 'incorrect' },
    { expect: responding.seq - 1 },
  );
  assert.equal(ack['error'], 'stale', 'a ruling aimed at an older state is refused');
  await host.act({ type: 'rule', verdict: 'incorrect' }, { expect: responding.seq });
  await host.phase('open');
  const scores = (host.view as unknown as { players: { id: string; score: number }[] }).players;
  assert.ok((scores.find((player) => player.id === 'p2')?.score ?? 0) < 0);
  assert.equal(
    (await p2.act({ type: 'buzz', seq: host.view?.seq ?? 0 }))['ok'],
    false,
    'p2 already responded',
  );
});

test('a resent message is applied once', async () => {
  const h = await start();
  const { host } = await hostedGame(h);
  await toBoard(host);
  await host.must({ type: 'adjust', playerId: 'p1', score: 100 });
  const first = await host.act({ type: 'adjust', playerId: 'p1', score: 500 }, { id: 'same-id' });
  const seq = host.view?.seq;
  host.ws.send(
    JSON.stringify({
      type: 'act',
      id: 'same-id',
      action: { type: 'adjust', playerId: 'p1', score: 999 },
      expect: null,
    }),
  );
  await host.until(
    () => host.messages.filter((m) => m['id'] === 'same-id').length === 2,
    'second ack',
  );
  assert.equal(first['ok'], true);
  assert.equal(host.view?.seq, seq, 'nothing changed');
});

test('disconnects: a player and the host reconnect into their own seats', async () => {
  const h = await start();
  const created = await post(h, '/trivia/api/rooms', { source: { type: 'random' } });
  const code = String(created.json['code']);
  const host = new Client(h, code, String(created.json['token']));
  const joined = await post(h, `/trivia/api/rooms/${code}/join`, { name: 'Ada' });
  const token = String(joined.json['token']);
  let player = new Client(h, code, token);
  await player.until(() => player.view);
  await host.until(
    () =>
      host.messages.some(
        (m) => m.type === 'state' && (m['presence'] as Record<string, boolean>)['p1'] === true,
      ),
    'present',
  );
  player.close();
  await host.until(
    () =>
      host.messages.at(-1)?.type === 'state' &&
      (host.messages.findLast((m) => m.type === 'state')?.['presence'] as Record<string, boolean>)[
        'p1'
      ] === false,
    'absent',
  );
  player = new Client(h, code, token);
  await player.until(
    () => player.messages.find((m) => m.type === 'welcome' && m['playerId'] === 'p1'),
    'same seat',
  );
  host.close();
  const again = new Client(h, code, String(created.json['token']));
  const welcome = await again.until(
    () => again.messages.find((m) => m.type === 'welcome'),
    'welcome',
  );
  assert.equal(welcome['role'], 'host');
  await again.must({ type: 'start_game' });
});

test('a server restart: the game comes back paused, from its snapshot, and resumes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-restart-'));
  let h = await start(dir);
  const { code, host, players, hostToken } = await hostedGame(h);
  await toBoard(host);
  await host.must({ type: 'select', ...ordinaryCell(host) });
  await host.must({ type: 'open' });
  const open = await host.phase('open');
  const playerToken = (await post(h, `/trivia/api/rooms/${code}/watch`)).json['token'];
  assert.ok(playerToken);
  for (const client of [host, ...players]) client.close();
  await stop(h);
  h = await start(dir);
  const back = new Client(h, code, hostToken);
  const view = await back.until(() => back.view, 'state');
  assert.equal(view.phase, 'open');
  assert.equal((view as unknown as { paused: string }).paused, 'restart');
  await back.must({ type: 'resume' });
  assert.ok((back.view?.seq ?? 0) > open.seq);
  const room = h.quiz.rooms.get(code);
  assert.ok(room);
  room.flush();
  assert.deepEqual(
    JSON.parse(JSON.stringify(Room.replay(h.quiz.db, code))),
    JSON.parse(JSON.stringify(room.state)),
  );
});

test('one authority: a second process sharing the database refuses a room the first one holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-lease-'));
  const a = await start(dir);
  const created = await post(a, '/trivia/api/rooms', { source: { type: 'random' } });
  const b = await start(dir);
  const intruder = new Client(b, String(created.json['code']), String(created.json['token']));
  await intruder.until(() => intruder.closed, 'refusal');
  assert.equal(intruder.closed?.code, 4004);
});

test('concurrent rooms are independent', async () => {
  const h = await start();
  const one = await hostedGame(h);
  const two = await hostedGame(h);
  assert.notEqual(one.code, two.code);
  await toBoard(one.host);
  assert.equal(two.host.view?.phase, 'lobby');
  const ack = await one.players[0]?.act({ type: 'buzz', seq: 1 });
  assert.equal(ack?.['ok'], false);
  assert.equal(
    two.players[0]?.messages.some(
      (m) => m.type === 'state' && (m['view'] as View).phase === 'board',
    ),
    false,
  );
});

test('timers are the server’s: an unanswered clue expires on its own', async () => {
  const h = await start();
  const { host } = await hostedGame(h, { buzzWindowSeconds: 2 });
  await toBoard(host);
  await host.must({ type: 'select', ...ordinaryCell(host) });
  await host.must({ type: 'open' });
  await host.phase('open');
  const ended = await host.until(
    () => (host.view?.phase === 'clue_end' ? host.view : null),
    'expiry',
    4000,
  );
  assert.ok(ended);
  assert.ok(
    host.messages.some(
      (m) =>
        m.type === 'state' &&
        (m['cues'] as { type: string }[]).some((cue) => cue.type === 'time_up'),
    ),
  );
});

test('a hardware device presses for a podium; the host sees diagnostics', async () => {
  const h = await start();
  const { code, host } = await hostedGame(h);
  host.ws.send(JSON.stringify({ type: 'manage', id: 'dev1', op: 'device_link' }));
  const link = await host.until(
    () => host.messages.find((m) => m.type === 'link' && m['kind'] === 'device'),
    'device token',
  );
  const device = new Client(h, code, String(link['token']));
  await device.until(() => device.messages.find((m) => m.type === 'welcome'));
  await toBoard(host);
  await host.must({ type: 'select', ...ordinaryCell(host) });
  await host.must({ type: 'open' });
  await host.phase('open');
  device.ws.send(JSON.stringify({ type: 'press', seat: 1 }));
  const responding = await host.phase('responding');
  assert.equal((responding as unknown as { clue: { responder: string } }).clue.responder, 'p2');
  const diag = await host.until(
    () =>
      host.messages.findLast((m) => m.type === 'diag' && (m['arbitration'] as { n: number }).n > 0),
    'diagnostics',
    5000,
  );
  assert.ok((diag['connections'] as unknown[]).length >= 5);
});

test('rate limits and limits on players', async () => {
  const h = await start(undefined, { rooms: 2, joins: 50, boards: 1 });
  assert.equal((await post(h, '/trivia/api/rooms', { source: { type: 'random' } })).status, 201);
  const second = await post(h, '/trivia/api/rooms', { source: { type: 'random' } });
  assert.equal((await post(h, '/trivia/api/rooms', { source: { type: 'random' } })).status, 429);
  const code = String(second.json['code']);
  for (const name of ['A', 'B', 'C'])
    assert.equal((await post(h, `/trivia/api/rooms/${code}/join`, { name })).status, 201);
  const fourth = await post(h, `/trivia/api/rooms/${code}/join`, { name: 'D' });
  assert.equal(fourth.status, 409);
  assert.equal((await post(h, '/trivia/api/boards')).status, 201);
  assert.equal((await post(h, '/trivia/api/boards')).status, 429);
  const form = await fetch(`${h.base}/trivia/api/rooms/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=b',
  });
  assert.equal(form.status, 415);
});

test('editor: a board belongs to its key; drafts save; an incomplete board cannot be hosted', async () => {
  const h = await start();
  const created = await post(h, '/trivia/api/boards');
  const id = Number(created.json['id']);
  const key = String(created.json['key']);
  const wrong = await fetch(`${h.base}/trivia/api/boards/${String(id)}`, {
    headers: { 'x-edit-key': 'nope' },
  });
  assert.equal(wrong.status, 404);
  const got = (await (
    await fetch(`${h.base}/trivia/api/boards/${String(id)}`, { headers: { 'x-edit-key': key } })
  ).json()) as { game: Record<string, unknown>; playable: string | null };
  assert.match(got.playable ?? '', /no clues/);
  const notReady = await post(h, '/trivia/api/rooms', { source: { type: 'board', id, key } });
  assert.equal(notReady.status, 400);
  const game = got.game as {
    rounds: {
      categories?: { title: string; clues: { text: string; response: string }[] }[];
      category?: string;
      clue?: { text: string; response: string };
    }[];
    tiebreakers: unknown[];
  };
  for (const round of game.rounds) {
    if (round.categories) {
      round.categories.forEach((category, col) => {
        category.title = `Cat ${String(col)}`;
        category.clues = category.clues.map((_, row) => ({
          text: `Clue ${String(col)}-${String(row)}`,
          response: `Resp ${String(col)}-${String(row)}`,
        }));
      });
    } else {
      round.category = 'Final';
      round.clue = { text: 'Final clue', response: 'Final response' };
    }
  }
  game.tiebreakers = [];
  const put = await fetch(`${h.base}/trivia/api/boards/${String(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-edit-key': key },
    body: JSON.stringify(game),
  });
  assert.equal(((await put.json()) as { playable: string | null }).playable, null);
  const hosted = await post(h, '/trivia/api/rooms', { source: { type: 'board', id, key } });
  assert.equal(hosted.status, 201);
  // Custom boards are never in the public library.
  const library = (await (await fetch(`${h.base}/trivia/api/library`)).json()) as {
    episodes: { id: number }[];
  };
  assert.equal(
    library.episodes.some((episode) => episode.id === id),
    false,
  );
});

test('single player: typed responses are judged, and the player may overrule', async () => {
  const h = await start();
  const created = await post(h, '/trivia/api/solo', {
    source: { type: 'episode', id: 1 },
    name: 'Solo',
  });
  assert.equal(created.status, 201);
  const player = new Client(h, String(created.json['code']), String(created.json['token']));
  await player.until(() => (player.view?.phase === 'board' ? player.view : null), 'board', 8000);
  const room = h.quiz.rooms.get(String(created.json['code']));
  assert.ok(room);
  // Choose an ordinary clue and answer it right.
  let cell: { col: number; row: number } | null = null;
  room.state.played.forEach((rows, col) =>
    rows.forEach((played, row) => {
      if (!cell && !played && !room.state.wagerCells[0]?.some(([c, r]) => c === col && r === row))
        cell = { col, row };
    }),
  );
  assert.ok(cell);
  await player.must({ type: 'select', ...(cell as { col: number; row: number }) });
  const reading = await player.phase('reading');
  player.ws.send(JSON.stringify({ type: 'narrated', seq: reading.seq }));
  const open = await player.phase('open');
  await player.must({ type: 'buzz', seq: open.seq });
  await player.phase('responding');
  const response = room.state.current?.clue.response ?? '';
  player.ws.send(JSON.stringify({ type: 'answer', id: 'a1', text: `What is ${response}?` }));
  await player.until(() => room.state.rulings.length === 1, 'ruling');
  assert.equal(room.state.rulings[0]?.verdict, 'correct');
  assert.ok((room.state.players[0]?.score ?? 0) > 0);
});

test('LAN listener: nothing but the quiz', async () => {
  const h = await start();
  assert.equal((await fetch(`${h.base}/exposures/`)).status, 404);
  assert.equal((await fetch(`${h.base}/private`)).status, 404);
  const page = await fetch(`${h.base}/trivia/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
});

test('the old /quiz/ address redirects to /trivia/, method, path and query kept', async () => {
  const h = await start();
  const page = await fetch(`${h.base}/quiz/host/ABCD?x=1`, { redirect: 'manual' });
  assert.equal(page.status, 308);
  assert.equal(page.headers.get('location'), '/trivia/host/ABCD?x=1');
  const bare = await fetch(`${h.base}/quiz`, { redirect: 'manual' });
  assert.equal(bare.headers.get('location'), '/trivia');
  const created = await fetch(`${h.base}/quiz/api/boards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(created.status, 201);
  assert.equal((await fetch(`${h.base}/quizzes/`)).status, 404);
});
