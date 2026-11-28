/**
 * A live game: the engine's state, the connections watching it, the
 * clock, and the record. This process is the room's only authority while
 * it holds the room's lease (quiz.ts); every action passes through `act`,
 * which is synchronous from the engine to the last socket write:
 *
 *   validate (protocol.ts) → engine.apply → broadcast every projection →
 *   acknowledge the sender → schedule the timer → queue the record
 *
 * The record (event log, snapshot, results) is written by `flush`, on a
 * later turn of the event loop — never between a buzz arriving and every
 * device hearing who won.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { matches } from './engine/answer.ts';
import {
  activePlayers,
  apply,
  createGame,
  findPlayer,
  nextDeadline,
  restore,
} from './engine/game.ts';
import type { Action, Actor, Result } from './engine/game.ts';
import { hostView, playerView, publicView } from './engine/project.ts';
import type { Cue, GameData, GameState, Settings } from './engine/types.ts';
import type { ClientMessage, ManageOp } from './protocol.ts';

export type Role = 'host' | 'cohost' | 'player' | 'spectator' | 'device';
export type Mode = 'hosted' | 'solo';

export interface TokenInfo {
  readonly role: Role;
  readonly playerId: string | null;
}

export interface Connection {
  readonly id: number;
  role: Role;
  playerId: string | null;
  tokenHash: string;
  /** An object is sent as JSON; a string is already JSON (a broadcast serialises once per role). */
  send(message: object | string): void;
  close(code: number, reason: string): void;
  /** Recent round trips, ms (application-level ping/pong). */
  rtt: number[];
  pings: Map<number, number>;
  sent: number;
  lost: number;
  connectedAt: number;
  lastSeen: number;
}

export interface InitData {
  readonly data: GameData;
  readonly settings: Settings;
  readonly seed: number;
}

interface LoggedEvent {
  readonly at: number;
  readonly mono: number;
  readonly role: string;
  readonly playerId: string | null;
  readonly action: object;
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');
export const newToken = (): string => randomBytes(24).toString('base64url');

const RECENT_IDS = 200;

/** Server-side timing of the buzzer path, for the host's diagnostics and `pnpm quiz bench`. */
export class Timings {
  private samples: number[] = [];
  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > 500) this.samples.shift();
  }
  summary(): { n: number; p50: number; p99: number; max: number } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return {
      n: sorted.length,
      p50: round(at(0.5)),
      p99: round(at(0.99)),
      max: round(sorted.at(-1) ?? 0),
    };
  }
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export const SOLO_SETTINGS: Partial<Settings> = {
  maxPlayers: 1,
  responseMs: 20000,
  wagerResponseMs: 25000,
  buzzWindowMs: 8000,
  tiebreak: false,
};

export interface RoomOptions {
  readonly db: DatabaseSync;
  readonly code: string;
  readonly mode: Mode;
  readonly theme: string;
  readonly episodeId: number | null;
  readonly init: InitData;
  readonly now?: () => number;
  /** Logged without tokens: structured, one line per event worth knowing. */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export class Room {
  readonly code: string;
  readonly mode: Mode;
  readonly theme: string;
  readonly episodeId: number | null;
  readonly init: InitData;
  state: GameState;
  readonly tokens = new Map<string, TokenInfo>();
  readonly connections = new Set<Connection>();
  readonly arbitration = new Timings();
  readonly broadcastTimings = new Timings();
  activeAt = Date.now();
  createdAt = Date.now();
  closed = false;
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly log: (event: string, fields: Record<string, unknown>) => void;
  private timer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private autoKey = '';
  private pending: LoggedEvent[] = [];
  private flushQueued = false;
  private eventCount = 0;
  private resultsWritten = -1;
  private readonly recent = new Map<string, Map<string, object>>();
  private nextPlayer = 1;
  /** Single player: the last typed response and how it was judged. */
  private judged: { text: string; verdict: string; response: string } | null = null;

  constructor(options: RoomOptions, existing?: { state: GameState; events: number }) {
    this.db = options.db;
    this.code = options.code;
    this.mode = options.mode;
    this.theme = options.theme;
    this.episodeId = options.episodeId;
    this.init = options.init;
    this.clock = options.now ?? (() => performance.now());
    this.log = options.log ?? (() => undefined);
    if (existing) {
      this.state = existing.state;
      this.eventCount = existing.events;
      this.nextPlayer =
        Math.max(0, ...this.state.players.map((player) => Number(player.id.slice(1)))) + 1;
    } else {
      this.state = createGame(options.init.data, options.init.settings, options.init.seed);
    }
  }

  // -------------------------------------------------------------------------
  // Creation and restoration

  /** Writes a new room's row. Tokens are added with `issue`. */
  insert(): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rooms (code, mode, episode_id, theme, init_json, snapshot, saved_at, events, created_at, active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        this.code,
        this.mode,
        this.episodeId,
        this.theme,
        JSON.stringify(this.init),
        this.snapshot(),
        this.clock(),
        now,
        now,
      );
  }

  /** The state without the game data (init_json holds that). */
  private snapshot(): string {
    const { data: _data, ...rest } = this.state;
    return JSON.stringify(rest);
  }

  static load(options: Omit<RoomOptions, 'init' | 'mode' | 'theme' | 'episodeId'>): Room | null {
    const row = options.db.prepare('SELECT * FROM rooms WHERE code = ?').get(options.code) as
      | {
          mode: Mode;
          episode_id: number | null;
          theme: string;
          init_json: string;
          snapshot: string;
          saved_at: number;
          events: number;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    const init = JSON.parse(row.init_json) as InitData;
    const state = {
      ...(JSON.parse(row.snapshot) as Omit<GameState, 'data'>),
      data: init.data,
    } as GameState;
    const room = new Room(
      { ...options, mode: row.mode, theme: row.theme, episodeId: row.episode_id, init },
      { state, events: row.events },
    );
    room.createdAt = row.created_at;
    for (const token of options.db
      .prepare('SELECT hash, role, player_id FROM tokens WHERE room = ? AND revoked_at IS NULL')
      .all(options.code) as {
      hash: string;
      role: Role;
      player_id: string | null;
    }[]) {
      room.tokens.set(token.hash, { role: token.role, playerId: token.player_id });
    }
    // A new process, a new monotonic clock: comes back paused (engine restore).
    const now = room.clock();
    restore(room.state, row.saved_at, now);
    room.record({ type: '__restore', savedAt: row.saved_at, now }, 'system', null, now);
    room.flush();
    return room;
  }

  /** Rebuilds a game from its first state and its log — the record is complete enough to replay. */
  static replay(db: DatabaseSync, code: string): GameState | null {
    const row = db.prepare('SELECT init_json FROM rooms WHERE code = ?').get(code) as
      { init_json: string } | undefined;
    if (!row) return null;
    const init = JSON.parse(row.init_json) as InitData;
    const state = createGame(init.data, init.settings, init.seed);
    for (const event of db
      .prepare('SELECT role, player_id, action, mono FROM events WHERE room = ? ORDER BY n')
      .all(code) as {
      role: string;
      player_id: string | null;
      action: string;
      mono: number;
    }[]) {
      const action = JSON.parse(event.action) as
        Action | { type: '__restore'; savedAt: number; now: number };
      if (action.type === '__restore') {
        restore(state, action.savedAt, action.now);
        continue;
      }
      const actor: Actor =
        event.role === 'player' && event.player_id
          ? { role: 'player', playerId: event.player_id }
          : event.role === 'host'
            ? { role: 'host' }
            : { role: 'system' };
      apply(state, action, actor, event.mono);
    }
    return state;
  }

  /** A new credential for this room. Only its hash is kept. */
  issue(role: Role, playerId: string | null): string {
    const token = newToken();
    const hash = hashToken(token);
    this.db
      .prepare(
        'INSERT INTO tokens (hash, room, role, player_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hash, this.code, role, playerId, Date.now());
    this.tokens.set(hash, { role, playerId });
    return token;
  }

  revoke(predicate: (info: TokenInfo, hash: string) => boolean): void {
    for (const [hash, info] of this.tokens) {
      if (!predicate(info, hash)) continue;
      this.tokens.delete(hash);
      this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?').run(Date.now(), hash);
      for (const connection of this.connections) {
        if (connection.tokenHash === hash) connection.close(4003, 'revoked');
      }
    }
  }

  /** Seats a new player and returns their credential. */
  join(name: string): { token: string; playerId: string } | { error: string } {
    const playerId = `p${String(this.nextPlayer)}`;
    const result = this.act({ type: 'add_player', id: playerId, name }, { role: 'system' });
    if (!result.ok) return { error: result.error };
    this.nextPlayer += 1;
    return { token: this.issue('player', playerId), playerId };
  }

  // -------------------------------------------------------------------------
  // The path every action takes

  act(action: Action, actor: Actor, now: number = this.clock()): Result {
    const started = this.clock();
    const result = apply(this.state, action, actor, now);
    if (!result.ok) return result;
    const arbitrated = this.clock();
    if (action.type === 'buzz') this.arbitration.add(arbitrated - started);
    // A late press changes no one's screen; everything else is sent to everyone.
    if (!(result.cues.length === 1 && result.cues[0]?.type === 'late'))
      this.broadcast(result.cues, now);
    if (action.type === 'buzz') this.broadcastTimings.add(this.clock() - arbitrated);
    this.schedule();
    this.record(action, actor.role, actor.role === 'player' ? actor.playerId : null, now);
    this.activeAt = Date.now();
    if (this.mode === 'solo') this.autopilot();
    return result;
  }

  private record(action: object, role: string, playerId: string | null, mono: number): void {
    this.pending.push({ at: Date.now(), mono, role, playerId, action });
    if (!this.flushQueued) {
      this.flushQueued = true;
      setImmediate(() => this.flush());
    }
  }

  /** Writes queued events, the snapshot and (once the game is over) the results, in one transaction. */
  flush(): void {
    this.flushQueued = false;
    if (this.pending.length === 0 && this.closed) return;
    const events = this.pending;
    this.pending = [];
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const insert = this.db.prepare(
        'INSERT INTO events (room, n, at, mono, role, player_id, action) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const event of events) {
        this.eventCount += 1;
        insert.run(
          this.code,
          this.eventCount,
          event.at,
          event.mono,
          event.role,
          event.playerId,
          JSON.stringify(event.action),
        );
      }
      this.db
        .prepare(
          'UPDATE rooms SET snapshot = ?, saved_at = ?, events = ?, active_at = ? WHERE code = ?',
        )
        .run(this.snapshot(), this.clock(), this.eventCount, this.activeAt, this.code);
      if (this.state.phase === 'game_over' && this.resultsWritten !== this.state.seq) {
        this.writeResults();
        this.resultsWritten = this.state.seq;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Nothing open.
      }
      this.pending = [...events, ...this.pending];
      this.log('quiz_flush_failed', { room: this.code, error: String(error) });
    }
  }

  private writeResults(): void {
    const state = this.state;
    const existing = this.db.prepare('SELECT game_id FROM rooms WHERE code = ?').get(this.code) as {
      game_id: number | null;
    };
    if (existing.game_id !== null)
      this.db.prepare('DELETE FROM games WHERE id = ?').run(existing.game_id);
    const gameId = Number(
      this.db
        .prepare(
          'INSERT INTO games (room, mode, episode_id, title, started_at, ended_at, winners) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          this.code,
          this.mode,
          this.episodeId,
          state.data.title,
          this.createdAt,
          Date.now(),
          JSON.stringify(state.winners.map((id) => findPlayer(state, id)?.name ?? id)),
        ).lastInsertRowid,
    );
    this.db.prepare('UPDATE rooms SET game_id = ? WHERE code = ?').run(gameId, this.code);
    const seatOf = new Map(state.players.map((player) => [player.id, player.seat]));
    const insertPlayer = this.db.prepare(
      `INSERT INTO game_players (game_id, seat, name, score, coryat, correct, incorrect, buzzes, wins, premature,
        wager_clues, wager_correct, wager_net, final_wager, final_correct, buzz_ms_median)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const player of activePlayers(state)) {
      const stats = player.stats;
      const finalVerdict = state.final?.verdicts[player.id];
      insertPlayer.run(
        gameId,
        player.seat,
        player.name,
        player.score,
        stats.coryat,
        stats.correct,
        stats.incorrect,
        stats.buzzes,
        stats.wins,
        stats.premature,
        stats.wagerClues,
        stats.wagerCorrect,
        stats.wagerNet,
        state.final?.wagers[player.id] ?? null,
        finalVerdict === undefined ? null : finalVerdict === 'correct' ? 1 : 0,
        median(stats.buzzMs),
      );
    }
    const insertRuling = this.db.prepare(
      'INSERT INTO game_rulings (game_id, n, round, kind, category, value, amount, seat, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const ruling of state.rulings) {
      insertRuling.run(
        gameId,
        ruling.id,
        ruling.round,
        ruling.kind,
        ruling.category,
        ruling.value,
        ruling.amount,
        seatOf.get(ruling.playerId) ?? -1,
        ruling.verdict,
      );
    }
    this.log('quiz_game_over', {
      room: this.code,
      game: gameId,
      players: activePlayers(state).length,
    });
  }

  // -------------------------------------------------------------------------
  // The clock

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadline = nextDeadline(this.state);
    if (deadline === null || this.closed) return;
    const delay = Math.max(0, deadline - this.clock());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.act({ type: 'tick' }, { role: 'system' });
      this.schedule();
    }, delay + 1);
  }

  // -------------------------------------------------------------------------
  // What each connection sees

  private presence(): Record<string, boolean> {
    const online: Record<string, boolean> = {};
    for (const player of this.state.players) online[player.id] = false;
    for (const connection of this.connections)
      if (connection.playerId) online[connection.playerId] = true;
    return online;
  }

  viewFor(connection: Pick<Connection, 'role' | 'playerId'>, now: number = this.clock()): object {
    const state = this.state;
    switch (connection.role) {
      case 'host':
      case 'cohost':
        return hostView(state, now);
      case 'player':
        return connection.playerId
          ? playerView(state, connection.playerId, now)
          : publicView(state, now);
      default:
        return publicView(state, now);
    }
  }

  private broadcast(cues: Cue[], now: number): void {
    const presence = this.presence();
    // One projection per role (and per player), not per connection.
    const cache = new Map<string, string>();
    for (const connection of this.connections) {
      const key =
        connection.role === 'player'
          ? `p:${connection.playerId ?? ''}`
          : connection.role === 'cohost'
            ? 'host'
            : connection.role;
      let payload = cache.get(key);
      if (payload === undefined) {
        payload = JSON.stringify({
          type: 'state',
          view: this.viewFor(connection, now),
          cues,
          presence,
          mode: this.mode,
          judged: this.mode === 'solo' ? this.judged : null,
        });
        cache.set(key, payload);
      }
      connection.send(payload);
    }
  }

  /** The current state to one connection (on connect, or after a refused command). */
  sendState(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: 'state',
        view: this.viewFor(connection),
        cues: [],
        presence: this.presence(),
        mode: this.mode,
        judged: this.mode === 'solo' ? this.judged : null,
      }),
    );
  }

  attach(connection: Connection): void {
    this.connections.add(connection);
    this.activeAt = Date.now();
    this.sendState(connection);
    // Everyone's podium shows who is connected.
    if (connection.role === 'player') this.broadcast([], this.clock());
    if (this.mode === 'solo') this.autopilot();
  }

  detach(connection: Connection): void {
    this.connections.delete(connection);
    this.activeAt = Date.now();
    if (connection.role === 'player') this.broadcast([], this.clock());
  }

  // -------------------------------------------------------------------------
  // Messages from a connection

  private remember(connection: Connection, id: string, reply: object): void {
    let seen = this.recent.get(connection.tokenHash);
    if (!seen) {
      seen = new Map();
      this.recent.set(connection.tokenHash, seen);
    }
    seen.set(id, reply);
    if (seen.size > RECENT_IDS) seen.delete(seen.keys().next().value ?? '');
  }

  private replayed(connection: Connection, id: string): boolean {
    const reply = this.recent.get(connection.tokenHash)?.get(id);
    if (!reply) return false;
    connection.send(reply);
    return true;
  }

  actorFor(connection: Connection): Actor | null {
    if (connection.role === 'host' || connection.role === 'cohost') return { role: 'host' };
    if (connection.role === 'player' && connection.playerId)
      return { role: 'player', playerId: connection.playerId };
    return null;
  }

  handle(
    connection: Connection,
    message: ClientMessage,
    links: (kind: string, token: string) => string,
  ): void {
    connection.lastSeen = this.clock();
    switch (message.type) {
      case 'pong': {
        const sentAt = connection.pings.get(message.n);
        if (sentAt !== undefined) {
          connection.pings.delete(message.n);
          connection.rtt.push(this.clock() - sentAt);
          if (connection.rtt.length > 30) connection.rtt.shift();
        }
        return;
      }
      case 'act': {
        if (this.replayed(connection, message.id)) return;
        const actor = this.actorFor(connection);
        let reply: object;
        if (!actor) reply = { type: 'ack', id: message.id, ok: false, error: 'not allowed' };
        else if (
          message.expect !== null &&
          message.expect !== this.state.seq &&
          message.action.type !== 'buzz'
        ) {
          reply = { type: 'ack', id: message.id, ok: false, error: 'stale', seq: this.state.seq };
          this.sendState(connection);
        } else if (
          this.mode === 'solo' &&
          actor.role === 'player' &&
          message.action.type === 'buzz' &&
          this.state.phase === 'open'
        ) {
          // Single player: the clock decides nothing; a press is a press.
          const result = this.act(message.action, actor);
          reply = {
            type: 'ack',
            id: message.id,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
            seq: this.state.seq,
          };
        } else {
          const result = this.act(message.action, actor);
          reply = {
            type: 'ack',
            id: message.id,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
            seq: this.state.seq,
          };
        }
        this.remember(connection, message.id, reply);
        connection.send(reply);
        return;
      }
      case 'press': {
        if (connection.role !== 'device') return;
        const player = activePlayers(this.state).find(
          (candidate) => candidate.seat === message.seat,
        );
        if (!player) return;
        // Hardware sees no state: arrival alone decides, so it carries the current seq.
        this.act({ type: 'buzz', seq: this.state.seq }, { role: 'player', playerId: player.id });
        return;
      }
      case 'answer':
        if (this.replayed(connection, message.id)) return;
        this.remember(connection, message.id, { type: 'ack', id: message.id, ok: true });
        this.soloAnswer(connection, message.text);
        connection.send({ type: 'ack', id: message.id, ok: true });
        return;
      case 'appeal':
        if (this.replayed(connection, message.id)) return;
        this.remember(connection, message.id, { type: 'ack', id: message.id, ok: true });
        this.soloAppeal(connection);
        connection.send({ type: 'ack', id: message.id, ok: true });
        return;
      case 'narrated':
        if (this.mode === 'solo' && connection.role === 'player' && message.seq === this.state.seq)
          this.narrated();
        return;
      case 'manage': {
        if (this.replayed(connection, message.id)) return;
        const reply = this.manage(connection, message.op, message.playerId, message.id, links);
        this.remember(connection, message.id, reply);
        connection.send(reply);
        return;
      }
      case 'hello':
        return;
    }
  }

  private manage(
    connection: Connection,
    op: ManageOp,
    playerId: string | null,
    id: string,
    links: (kind: string, token: string) => string,
  ): object {
    const isHost = connection.role === 'host';
    if (connection.role !== 'host' && connection.role !== 'cohost')
      return { type: 'ack', id, ok: false, error: 'not allowed' };
    switch (op) {
      case 'cohost_link':
        if (!isHost) break;
        return { type: 'link', id, kind: 'cohost', url: links('host', this.issue('cohost', null)) };
      case 'rejoin_link': {
        // A player whose phone lost its credential gets their seat back with a new one; the old one stops working.
        if (!playerId || !findPlayer(this.state, playerId))
          return { type: 'ack', id, ok: false, error: 'no such player' };
        this.revoke((info) => info.role === 'player' && info.playerId === playerId);
        return {
          type: 'link',
          id,
          kind: 'rejoin',
          playerId,
          url: links('play', this.issue('player', playerId)),
        };
      }
      case 'device_link':
        if (!isHost) break;
        return { type: 'link', id, kind: 'device', token: this.issue('device', null) };
      case 'transfer': {
        if (!isHost) break;
        // A new host credential; this one steps down to co-host.
        const token = this.issue('host', null);
        const mine = connection.tokenHash;
        this.tokens.set(mine, { role: 'cohost', playerId: null });
        this.db.prepare("UPDATE tokens SET role = 'cohost' WHERE hash = ?").run(mine);
        connection.role = 'cohost';
        this.sendState(connection);
        return { type: 'link', id, kind: 'host', url: links('host', token) };
      }
      case 'revoke_cohosts':
        if (!isHost) break;
        this.revoke((info) => info.role === 'cohost');
        return { type: 'ack', id, ok: true };
      case 'close':
        if (!isHost) break;
        this.closed = true;
        for (const other of this.connections) other.close(4004, 'closed');
        return { type: 'ack', id, ok: true };
    }
    return { type: 'ack', id, ok: false, error: 'host only' };
  }

  // -------------------------------------------------------------------------
  // Diagnostics

  ping(n: number): void {
    const now = this.clock();
    for (const connection of this.connections) {
      // A ping unanswered by the next round is lost.
      connection.lost += connection.pings.size;
      connection.pings.clear();
      connection.pings.set(n, now);
      connection.sent += 1;
      connection.send({ type: 'ping', n });
    }
  }

  diagnostics(): object {
    const now = this.clock();
    const players = new Map(this.state.players.map((player) => [player.id, player.name]));
    return {
      type: 'diag',
      connections: [...this.connections].map((connection) => {
        const rtt = connection.rtt;
        const jitter =
          rtt.length < 2
            ? null
            : round(
                rtt
                  .slice(1)
                  .reduce((sum, value, index) => sum + Math.abs(value - (rtt[index] ?? value)), 0) /
                  (rtt.length - 1),
              );
        return {
          id: connection.id,
          role: connection.role,
          playerId: connection.playerId,
          name: connection.playerId ? (players.get(connection.playerId) ?? null) : null,
          rtt: median(rtt) === null ? null : round(median(rtt) ?? 0),
          jitter,
          loss: connection.sent === 0 ? 0 : round(connection.lost / connection.sent),
          seenAgoMs: Math.round(now - connection.lastSeen),
          connectedMs: Math.round(now - connection.connectedAt),
        };
      }),
      arbitration: this.arbitration.summary(),
      broadcast: this.broadcastTimings.summary(),
      test: this.state.test,
    };
  }

  // -------------------------------------------------------------------------
  // Single player: the automated host

  private readingMs(text: string): number {
    return Math.min(15000, 1200 + text.length * 55);
  }

  private narrated(): void {
    if (this.state.phase === 'reading') this.act({ type: 'open' }, { role: 'host' });
    else if (this.state.phase === 'final_clue') this.act({ type: 'continue' }, { role: 'host' });
  }

  private soloAnswer(connection: Connection, text: string): void {
    if (this.mode !== 'solo' || connection.role !== 'player' || !connection.playerId) return;
    const state = this.state;
    if (state.phase === 'final_response') {
      this.act({ type: 'final_response', text }, { role: 'player', playerId: connection.playerId });
      this.act({ type: 'continue' }, { role: 'host' });
      return;
    }
    const current = state.current;
    if (
      (state.phase !== 'responding' && state.phase !== 'adjudicating') ||
      current?.responder !== connection.playerId
    )
      return;
    const verdict = matches(text, current.clue.response, current.clue.accept)
      ? 'correct'
      : 'incorrect';
    this.judged = { text: text.slice(0, 200), verdict, response: current.clue.response };
    this.act({ type: 'rule', verdict }, { role: 'host' });
  }

  private soloAppeal(connection: Connection): void {
    if (this.mode !== 'solo' || !connection.playerId) return;
    const last = this.state.rulings.at(-1);
    if (
      !last ||
      last.playerId !== connection.playerId ||
      last.verdict !== 'incorrect' ||
      last.reversed
    )
      return;
    if (this.judged) this.judged = { ...this.judged, verdict: 'correct (overruled)' };
    this.act({ type: 'reverse', rulingId: last.id }, { role: 'host' });
  }

  /** What the automated host does next, given the phase. One pending step at a time. */
  private autopilot(): void {
    const state = this.state;
    if (state.paused || this.closed || this.connections.size === 0) {
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = null;
      this.autoKey = '';
      return;
    }
    const key = `${String(state.seq)}:${state.phase}`;
    if (key === this.autoKey) return;
    this.autoKey = key;
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    const later = (ms: number, action: Action): void => {
      const seq = state.seq;
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        if (this.state.seq === seq) this.act(action, { role: 'host' });
      }, ms);
    };
    const final = state.final;
    switch (state.phase) {
      case 'lobby':
        return later(400, { type: 'start_game' });
      case 'round_intro':
        return later(state.intro === 0 ? 1200 : 650, { type: 'intro_next' });
      case 'wager_reveal':
        return later(1800, { type: 'continue' });
      case 'reading':
        // The player's device reads it aloud and says when it's done; this is the fallback.
        return later(this.readingMs(state.current?.clue.text ?? ''), { type: 'open' });
      case 'adjudicating':
        this.judged = {
          text: '',
          verdict: 'incorrect',
          response: state.current?.clue.response ?? '',
        };
        return later(0, { type: 'rule', verdict: 'incorrect' });
      case 'clue_end':
        return state.revealed ? later(3500, { type: 'next' }) : later(300, { type: 'reveal' });
      case 'round_end':
        return later(3000, { type: 'next' });
      case 'final_category':
        return later(3000, { type: 'continue' });
      case 'final_wager':
        if (final && final.eligible.every((id) => final.wagers[id] !== undefined))
          later(600, { type: 'continue' });
        return;
      case 'final_clue': {
        const round = state.data.rounds[state.round];
        return later(this.readingMs(round?.kind === 'final' ? round.clue.text : ''), {
          type: 'continue',
        });
      }
      case 'final_reveal': {
        if (!final) return;
        const playerId = final.order[final.index];
        if (final.index >= 0 && final.step === 'response' && playerId) {
          const round = state.data.rounds[state.round];
          const response = final.responses[playerId] ?? '';
          const right =
            round?.kind === 'final' && matches(response, round.clue.response, round.clue.accept);
          this.judged = {
            text: response,
            verdict: right ? 'correct' : 'incorrect',
            response: round?.kind === 'final' ? round.clue.response : '',
          };
          return later(1500, { type: 'final_rule', verdict: right ? 'correct' : 'incorrect' });
        }
        if (!state.revealed && final.index === -1) return later(500, { type: 'reveal' });
        return later(1500, { type: 'final_reveal' });
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.timer = null;
    this.autoTimer = null;
    this.flush();
  }
}
