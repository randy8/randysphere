/**
 * pnpm quiz <command> — the quiz's catalog and records, from the terminal.
 * Works on private/quiz/quiz.db, alongside a running server (WAL).
 *
 *   import <file> --source=NAME --license=TEXT [--url=URL] [--list]
 *                          JSON game files or a CSV/TSV dataset (importer.ts).
 *                          Imported episodes are unlisted until --list or `list-on`.
 *   episodes [--all]       the library (listed only, unless --all)
 *   list-on <id>           offer an episode in the host's library, random boards and practice
 *   list-off <id>
 *   export <id> [file]     an episode or board as a game file (stdout without a file)
 *   delete <id>
 *   results [--limit=N]    finished games, newest first
 *   rooms                  live and recent rooms
 *   bench [--rounds=N]     buzzer arbitration and notification latency, measured in-process
 *   bridge <url> <code> <token> [--keys=123]
 *                          a keyboard as hardware buzzers: each key is a podium (docs/quiz.md)
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { WebSocket } from 'ws';

import {
  ensureSource,
  importEpisode,
  listEpisodes,
  loadEpisode,
  deleteEpisode,
  setListed,
} from './catalog.ts';
import { openDatabase } from './db.ts';
import { parseDataset } from './importer.ts';
import { rawText } from './quiz.ts';
import { toFile } from './validate.ts';

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not find the repository root.');
}

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Map(
  rest
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split('=');
      return [key ?? '', value.length > 0 ? value.join('=') : 'true'] as const;
    }),
);
const args = rest.filter((arg) => !arg.startsWith('--'));
const dbPath = join(repositoryRoot(), 'private', 'quiz', 'quiz.db');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  switch (command) {
    case 'import': {
      const file =
        args[0] ??
        fail('usage: pnpm quiz import <file> --source=NAME --license=TEXT [--url=URL] [--list]');
      const dataset = parseDataset(file, readFileSync(file, 'utf8'));
      const name = flags.get('source') ?? dataset.source?.name;
      const license = flags.get('license') ?? dataset.source?.license;
      // Provenance is not optional: every imported clue says where it came from and on what terms.
      if (!name || !license)
        fail('Say where this came from and on what terms: --source=NAME --license=TEXT');
      const db = openDatabase(dbPath);
      const source = ensureSource(db, {
        name,
        license,
        url: flags.get('url') ?? dataset.source?.url ?? '',
        notes: dataset.source?.notes ?? '',
      });
      let added = 0;
      let replaced = 0;
      for (const game of dataset.games) {
        const result = importEpisode(db, game, source, { listed: flags.has('list') });
        if (result.replaced) replaced += 1;
        else added += 1;
      }
      console.log(
        `${String(added)} added, ${String(replaced)} updated, ${String(dataset.skipped.length)} skipped (source: ${name}).`,
      );
      for (const problem of dataset.skipped.slice(0, 20)) console.log(`  skipped ${problem}`);
      if (!flags.has('list') && added + replaced > 0)
        console.log(
          'Unlisted: offer them with `pnpm quiz list-on <id>` (or re-import with --list).',
        );
      return;
    }
    case 'episodes': {
      const db = openDatabase(dbPath);
      const all = listEpisodes(db, flags.has('all') ? {} : { listed: true });
      for (const episode of all) {
        console.log(
          [
            String(episode.id).padStart(5),
            episode.listed ? 'listed  ' : 'unlisted',
            episode.kind.padEnd(8),
            episode.airDate ?? '          ',
            episode.title,
            episode.source ? `(${episode.source})` : '',
          ].join('  '),
        );
      }
      if (all.length === 0) console.log('Nothing yet.');
      return;
    }
    case 'list-on':
    case 'list-off': {
      const id = Number(args[0]);
      const db = openDatabase(dbPath);
      if (!setListed(db, id, command === 'list-on')) fail(`No episode ${String(args[0])}.`);
      console.log(
        command === 'list-on'
          ? `Episode ${String(id)} is in the library.`
          : `Episode ${String(id)} is unlisted.`,
      );
      return;
    }
    case 'export': {
      const db = openDatabase(dbPath);
      const loaded = loadEpisode(db, Number(args[0]));
      if (!loaded) fail(`No episode ${String(args[0])}.`);
      const text = `${JSON.stringify(toFile(loaded.game, loaded.meta), null, 2)}\n`;
      if (args[1]) writeFileSync(args[1], text);
      else process.stdout.write(text);
      return;
    }
    case 'delete': {
      const db = openDatabase(dbPath);
      if (!deleteEpisode(db, Number(args[0]))) fail(`No episode ${String(args[0])}.`);
      console.log('Deleted.');
      return;
    }
    case 'results': {
      const db = openDatabase(dbPath);
      const games = db
        .prepare(
          'SELECT id, room, mode, title, ended_at, winners FROM games ORDER BY ended_at DESC LIMIT ?',
        )
        .all(Number(flags.get('limit') ?? 20)) as {
        id: number;
        room: string;
        mode: string;
        title: string;
        ended_at: number;
        winners: string;
      }[];
      for (const game of games) {
        console.log(
          `${new Date(game.ended_at).toISOString().slice(0, 16)}  ${game.title}  (${game.mode}, room ${game.room})  winner: ${(JSON.parse(game.winners) as string[]).join(' & ') || 'none'}`,
        );
        const players = db
          .prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY seat')
          .all(game.id) as Record<string, number | string | null>[];
        for (const p of players) {
          console.log(
            `    ${String(p['name']).padEnd(16)} ${String(p['score']).padStart(7)}  coryat ${String(p['coryat']).padStart(6)}  ${String(p['correct'])}/${String(p['incorrect'])} right/wrong  buzz ${String(p['wins'])}/${String(p['buzzes'])}  early ${String(p['premature'])}  median buzz ${p['buzz_ms_median'] === null ? '—' : `${String(p['buzz_ms_median'])} ms (server)`}`,
          );
        }
        const categories = db
          .prepare(
            `SELECT category, SUM(verdict = 'correct') AS right, COUNT(*) AS n FROM game_rulings WHERE game_id = ? AND kind IN ('clue', 'wager')
             GROUP BY category ORDER BY n DESC LIMIT 6`,
          )
          .all(game.id) as { category: string; right: number; n: number }[];
        if (categories.length > 0)
          console.log(
            `    by category: ${categories.map((c) => `${c.category} ${String(c.right)}/${String(c.n)}`).join(', ')}`,
          );
      }
      if (games.length === 0) console.log('No finished games yet.');
      return;
    }
    case 'rooms': {
      const db = openDatabase(dbPath);
      const rooms = db
        .prepare(
          'SELECT code, mode, events, active_at, lease_until, owner FROM rooms ORDER BY active_at DESC LIMIT 50',
        )
        .all() as {
        code: string;
        mode: string;
        events: number;
        active_at: number;
        lease_until: number;
        owner: string | null;
      }[];
      for (const room of rooms) {
        console.log(
          `${room.code}  ${room.mode.padEnd(6)} ${String(room.events).padStart(5)} events  active ${new Date(room.active_at).toISOString().slice(0, 16)}  ${room.lease_until > Date.now() ? `held by ${room.owner ?? '?'}` : 'free'}`,
        );
      }
      return;
    }
    case 'bench':
      return bench(Number(flags.get('rounds') ?? 200));
    case 'bridge':
      return bridge(args[0], args[1], args[2], flags.get('keys') ?? '123456');
    default:
      console.log(
        readFileSync(new URL(import.meta.url), 'utf8')
          .split('*/')[0]
          ?.replace(/^\/\*\*\n?/, '')
          .replace(/^ \* ?/gm, ''),
      );
  }
}

/**
 * Three socket clients on loopback race for the buzzer, `rounds` times.
 * Reports the server's arbitration time (engine only), the broadcast, and
 * press → every client notified, end to end. Loopback: this measures the
 * software, not anyone's Wi-Fi.
 */
async function bench(rounds: number): Promise<void> {
  const { Quiz } = await import('./quiz.ts');
  const { createQuizOnlyServer } = await import('../server.ts');
  const quiz = new Quiz({
    dataDir: mkdtempSync(join(tmpdir(), 'quiz-bench-')),
    log: () => undefined,
    limits: { rooms: 10, joins: 100, boards: 1 },
  });
  const server = createQuizOnlyServer(quiz);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    (await (
      await fetch(`http://${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json()) as Record<string, unknown>;
  const created = await post('/quiz/api/rooms', {
    source: { type: 'random' },
    settings: { buzzWindowSeconds: 60 },
  });
  const code = String(created['code']);
  type View = { seq: number; phase: string; clue?: { responder: string | null } };
  const connectClient = (
    token: string,
  ): Promise<{
    ws: WebSocket;
    view: () => View | null;
    wait: (test: (v: View) => boolean, fresh?: boolean) => Promise<number>;
  }> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://${base}/quiz/ws`, { headers: { origin: `http://${base}` } });
      let view: View | null = null;
      let waiters: { test: (v: View) => boolean; done: (t: number) => void }[] = [];
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', code, token })));
      ws.on('message', (data) => {
        const message = JSON.parse(rawText(data)) as { type: string; view?: View; n?: number };
        if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', n: message.n }));
        if (message.type === 'state' && message.view) {
          view = message.view;
          const now = performance.now();
          waiters = waiters.filter((waiter) =>
            waiter.test(view as View) ? (waiter.done(now), false) : true,
          );
        }
        if (message.type === 'welcome') {
          resolve({
            ws,
            view: () => view,
            // Resolves at once if the state is already there (it may have arrived before anyone asked).
            wait: (test, fresh = false) =>
              new Promise((done) =>
                !fresh && view && test(view)
                  ? done(performance.now())
                  : waiters.push({ test, done }),
              ),
          });
        }
      });
    });
  const host = await connectClient(String(created['token']));
  const players = [];
  for (const name of ['A', 'B', 'C'])
    players.push(
      await connectClient(String((await post(`/quiz/api/rooms/${code}/join`, { name }))['token'])),
    );
  let n = 0;
  const act = (action: object): void =>
    host.ws.send(JSON.stringify({ type: 'act', id: `h${String((n += 1))}`, action, expect: null }));
  act({ type: 'start_game' });
  for (let i = 0; i < 7; i += 1) act({ type: 'intro_next' });
  await host.wait((v) => v.phase === 'board');
  const endToEnd: number[] = [];
  const wins = [0, 0, 0];
  for (let round = 0; round < rounds; round += 1) {
    // Paced under the server's per-connection limit (20 messages a second).
    await new Promise((resolve) => setTimeout(resolve, 80));
    const room = quiz.rooms.get(code);
    if (!room) break;
    // Reuse one clue: reopen it each round by driving the engine's state directly through the host.
    if (round === 0) {
      const cell = room.state.played
        .flatMap((rows, col) => rows.map((played, row) => ({ col, row, played })))
        .find(
          (c) =>
            !c.played &&
            !room.state.wagerCells[0]?.some(([wc, wr]) => wc === c.col && wr === c.row),
        );
      act({ type: 'select', col: cell?.col, row: cell?.row });
      await host.wait((v) => v.phase === 'reading');
      act({ type: 'open' });
    } else {
      // Undo the previous win without scoring: the responder is removed from the attempt list and buzzers reopen.
      const current = room.state.current;
      if (current) {
        current.attempted = [];
        current.responder = null;
      }
      room.state.phase = 'reading';
      room.state.seq += 1;
      act({ type: 'open' });
    }
    await Promise.all(players.map((p) => p.wait((v) => v.phase === 'open')));
    const seq = players[0]?.view()?.seq ?? 0;
    const started = performance.now();
    const notified = Promise.all(
      [host, ...players].map((client) => client.wait((v) => v.phase === 'responding', true)),
    );
    players.forEach((player, index) =>
      player.ws.send(
        JSON.stringify({
          type: 'act',
          id: `b${String(round)}${String(index)}`,
          action: { type: 'buzz', seq },
        }),
      ),
    );
    const times = await notified;
    endToEnd.push(Math.max(...times) - started);
    const responder = host.view()?.clue?.responder ?? '';
    const index = ['p1', 'p2', 'p3'].indexOf(responder);
    if (index >= 0) wins[index] = (wins[index] ?? 0) + 1;
  }
  const room = quiz.rooms.get(code);
  const sorted = [...endToEnd].sort((a, b) => a - b);
  const q = (p: number): string =>
    (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0).toFixed(2);
  console.log(`${String(sorted.length)} contested buzzes, 3 players, loopback`);
  console.log(`  arbitration (engine):  ${JSON.stringify(room?.arbitration.summary())} ms`);
  console.log(`  broadcast (all sends): ${JSON.stringify(room?.broadcastTimings.summary())} ms`);
  console.log(
    `  press → every device notified: p50 ${q(0.5)} ms, p99 ${q(0.99)} ms, max ${q(1)} ms`,
  );
  console.log(`  wins by seat (the first frame sent each round was seat 1's): ${wins.join(' / ')}`);
  for (const client of [host, ...players]) client.ws.close();
  quiz.close();
  server.closeAllConnections();
  server.close();
}

/**
 * The hardware abstraction, by example: a device token (host console →
 * "Hardware buzzer token") and one message per press, { type: 'press',
 * seat }. An ESP32 or a USB adapter would send the same frames; here a
 * keyboard does — key 1 is the leftmost podium.
 */
function bridge(
  url: string | undefined,
  code: string | undefined,
  token: string | undefined,
  keys: string,
): void {
  if (!url || !code || !token)
    fail('usage: pnpm quiz bridge <wss://host/quiz/ws> <CODE> <device token> [--keys=123]');
  const ws = new WebSocket(url, {
    headers: { origin: new URL(url.replace(/^ws/, 'http')).origin },
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', code, token })));
  ws.on('message', (data) => {
    const message = JSON.parse(rawText(data)) as { type: string; n?: number };
    if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', n: message.n }));
    if (message.type === 'welcome')
      console.log(
        `Connected to ${code}. Press ${keys.split('').join(', ')} for podiums 1–${String(keys.length)}; Ctrl-C to stop.`,
      );
  });
  ws.on('close', (closeCode, reason) => {
    console.log(`Closed (${String(closeCode)} ${reason.toString()}).`);
    process.exit(0);
  });
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    for (const char of chunk.toString()) {
      if (char === '\u0003') process.exit(0);
      const seat = keys.indexOf(char);
      if (seat >= 0 && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'press', seat }));
    }
  });
}

await main();
