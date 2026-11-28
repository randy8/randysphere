/**
 * The WebSocket protocol, client → server, checked field by field before
 * anything acts on it. Anything that doesn't parse is refused and counted
 * against the connection (room.ts closes a connection that keeps sending
 * garbage). Server → client messages are plain objects documented where
 * they are sent (room.ts).
 *
 *   hello   { type, code, token }                  — first message, always
 *   pong    { type, n }                            — answers a ping
 *   act     { type, id, action, expect? }          — a game action
 *   answer  { type, id, text }                     — single player: a typed response
 *   appeal  { type, id }                           — single player: "I was right"
 *   narrated{ type, seq }                          — single player: the clue was read aloud
 *   manage  { type, id, op, playerId?, ... }       — host: links, co-hosts, transfer
 *   press   { type, seat, seq? }                   — device: a hardware button (seat = podium)
 *
 * `id` makes a message idempotent: a client that resends after a dropped
 * connection gets the first result again, not a second action. `expect` is
 * the state seq the host was looking at: a command aimed at a state that
 * has since moved on is refused instead of applied to the wrong clue.
 */

import type { Action } from './engine/game.ts';
import { MAX_FINAL_RESPONSE, MAX_NAME } from './engine/game.ts';

export type ClientMessage =
  | { type: 'hello'; code: string; token: string }
  | { type: 'pong'; n: number }
  | { type: 'act'; id: string; action: Action; expect: number | null }
  | { type: 'answer'; id: string; text: string }
  | { type: 'appeal'; id: string }
  | { type: 'narrated'; seq: number }
  | { type: 'manage'; id: string; op: ManageOp; playerId: string | null }
  | { type: 'press'; seat: number };

export type ManageOp =
  'cohost_link' | 'rejoin_link' | 'device_link' | 'transfer' | 'revoke_cohosts' | 'close';

const MANAGE_OPS: ReadonlySet<string> = new Set([
  'cohost_link',
  'rejoin_link',
  'device_link',
  'transfer',
  'revoke_cohosts',
  'close',
]);

export const MAX_MESSAGE_BYTES = 4096;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const int = (value: unknown, min = -1e9, max = 1e9): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
const playerId = (value: unknown): string | null =>
  typeof value === 'string' && /^p[0-9]{1,4}$/.test(value) ? value : null;

/** One action's fields, by type. Unknown types and extra-shaped fields are refused. */
function parseAction(input: unknown): Action | null {
  if (!isObj(input) || typeof input['type'] !== 'string') return null;
  const t = input['type'];
  const verdict =
    input['verdict'] === 'correct' || input['verdict'] === 'incorrect' ? input['verdict'] : null;
  const pid = input['playerId'] === undefined ? undefined : playerId(input['playerId']);
  if (pid === null) return null;
  switch (t) {
    case 'start_test':
    case 'end_test':
    case 'start_game':
    case 'intro_next':
    case 'continue':
    case 'open':
    case 'more_specific':
    case 'remind_form':
    case 'reveal':
    case 'skip':
    case 'next':
    case 'end_round':
    case 'pause':
    case 'resume':
    case 'final_reveal':
      return { type: t };
    case 'select': {
      const col = int(input['col'], 0, 20);
      const row = int(input['row'], 0, 20);
      return col === null || row === null ? null : { type: t, col, row };
    }
    case 'buzz': {
      const seq = int(input['seq'], 0);
      return seq === null ? null : { type: t, seq };
    }
    case 'rule':
    case 'final_rule':
      return verdict === null ? null : { type: t, verdict };
    case 'wager':
    case 'final_wager': {
      const amount = int(input['amount'], -1e8, 1e8);
      if (amount === null) return null;
      return pid === undefined ? { type: t, amount } : { type: t, amount, playerId: pid };
    }
    case 'final_response': {
      const text = str(input['text'], MAX_FINAL_RESPONSE * 2);
      if (text === null) return null;
      return pid === undefined ? { type: t, text } : { type: t, text, playerId: pid };
    }
    case 'set_control':
    case 'remove_player':
      return pid ? { type: t, playerId: pid } : null;
    case 'rename_player': {
      const name = str(input['name'], MAX_NAME * 4);
      return pid && name !== null ? { type: t, playerId: pid, name } : null;
    }
    case 'adjust': {
      const score = int(input['score'], -1e7, 1e7);
      return pid && score !== null ? { type: t, playerId: pid, score } : null;
    }
    case 'reverse': {
      const rulingId = int(input['rulingId'], 1, 1e6);
      return rulingId === null ? null : { type: t, rulingId };
    }
    case 'seat': {
      const order = input['order'];
      if (!Array.isArray(order) || order.length > 8) return null;
      const ids = order.map(playerId);
      return ids.every((entry): entry is string => entry !== null) ? { type: t, order: ids } : null;
    }
    default:
      // add_player and tick are the room's own; never accepted from a socket.
      return null;
  }
}

export function parseMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(input)) return null;
  switch (input['type']) {
    case 'hello': {
      const code = str(input['code'], 8);
      const token = str(input['token'], 100);
      return code && token && /^[A-Z]{4}$/.test(code) && /^[A-Za-z0-9_-]{20,100}$/.test(token)
        ? { type: 'hello', code, token }
        : null;
    }
    case 'pong': {
      const n = int(input['n'], 0);
      return n === null ? null : { type: 'pong', n };
    }
    case 'act': {
      const messageId = id(input['id']);
      const action = parseAction(input['action']);
      const expect =
        input['expect'] === undefined || input['expect'] === null ? null : int(input['expect'], 0);
      if (!messageId || !action || expect === undefined) return null;
      return { type: 'act', id: messageId, action, expect };
    }
    case 'answer': {
      const messageId = id(input['id']);
      const text = str(input['text'], MAX_FINAL_RESPONSE * 2);
      return messageId && text !== null ? { type: 'answer', id: messageId, text } : null;
    }
    case 'appeal': {
      const messageId = id(input['id']);
      return messageId ? { type: 'appeal', id: messageId } : null;
    }
    case 'narrated': {
      const seq = int(input['seq'], 0);
      return seq === null ? null : { type: 'narrated', seq };
    }
    case 'manage': {
      const messageId = id(input['id']);
      const op = input['op'];
      const pid =
        input['playerId'] === undefined || input['playerId'] === null
          ? null
          : playerId(input['playerId']);
      if (!messageId || typeof op !== 'string' || !MANAGE_OPS.has(op)) return null;
      return { type: 'manage', id: messageId, op: op as ManageOp, playerId: pid };
    }
    case 'press': {
      const seat = int(input['seat'], 0, 7);
      return seat === null ? null : { type: 'press', seat };
    }
    default:
      return null;
  }
}
