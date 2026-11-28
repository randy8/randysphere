/**
 * The game, as an explicit state machine: one `apply` that takes an action,
 * who is taking it and the server's monotonic time, checks the action is
 * legal in the current phase for that role, and changes the state. Nothing
 * else changes a game. No I/O, no clocks, no randomness except the seeded
 * wager-clue placement at creation — so the same actions at the same times
 * always produce the same game (the event log replays, ../room.ts), and
 * every rule is testable without a socket.
 *
 * Validation happens before any mutation in each handler: a refused action
 * leaves the state exactly as it was.
 */

import type {
  BoardRoundData,
  ClueData,
  Cue,
  CurrentClue,
  GameData,
  GameState,
  Phase,
  Player,
  PlayerStats,
  Ruling,
  Settings,
  Verdict,
} from './types.ts';

export type Actor =
  | { readonly role: 'host' }
  | { readonly role: 'player'; readonly playerId: string }
  /** The room itself: joins, the clock. */
  | { readonly role: 'system' };

export type Action =
  | { type: 'add_player'; id: string; name: string }
  | { type: 'rename_player'; playerId: string; name: string }
  | { type: 'remove_player'; playerId: string }
  | { type: 'seat'; order: string[] }
  | { type: 'start_test' }
  | { type: 'end_test' }
  | { type: 'start_game' }
  | { type: 'intro_next' }
  | { type: 'select'; col: number; row: number }
  | { type: 'set_control'; playerId: string }
  | { type: 'continue' }
  | { type: 'wager'; amount: number; playerId?: string }
  | { type: 'open' }
  | { type: 'buzz'; playerId?: string; seq: number }
  | { type: 'rule'; verdict: Verdict }
  | { type: 'more_specific' }
  | { type: 'remind_form' }
  | { type: 'reveal' }
  | { type: 'skip' }
  | { type: 'next' }
  | { type: 'end_round' }
  | { type: 'adjust'; playerId: string; score: number }
  | { type: 'reverse'; rulingId: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'final_wager'; amount: number; playerId?: string }
  | { type: 'final_response'; text: string; playerId?: string }
  | { type: 'final_reveal' }
  | { type: 'final_rule'; verdict: Verdict }
  | { type: 'tick' };

export type ActionType = Action['type'];

export type Result = { ok: true; cues: Cue[] } | { ok: false; error: string };

/** What each role may send. The room checks this before the engine sees anything (../room.ts). */
export const PLAYER_ACTIONS: ReadonlySet<ActionType> = new Set([
  'select',
  'wager',
  'buzz',
  'final_wager',
  'final_response',
]);
export const SYSTEM_ACTIONS: ReadonlySet<ActionType> = new Set(['add_player', 'tick']);

export const MAX_NAME = 24;
export const MAX_FINAL_RESPONSE = 200;
/** No wager clue can be bid below this (or the round's lowest value, if a custom board's is lower). */
export const MIN_WAGER = 5;

const ok = (cues: Cue[] = []): Result => ({ ok: true, cues });
const fail = (error: string): Result => ({ ok: false, error });

/** Seeded PRNG (mulberry32): wager-clue placement is part of the game, so a replay must place them identically. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emptyStats = (): PlayerStats => ({
  buzzes: 0,
  wins: 0,
  premature: 0,
  correct: 0,
  incorrect: 0,
  coryat: 0,
  wagerClues: 0,
  wagerCorrect: 0,
  wagerNet: 0,
  buzzMs: [],
});

/**
 * Where a round's wager clues go. Flagged clues (a historical board) are
 * kept as they were; otherwise `wagers` cells are drawn, never two in one
 * category, weighted toward the lower rows where they usually fall — and
 * never on the top row unless nothing else is left.
 */
export function placeWagers(round: BoardRoundData, random: () => number): [number, number][] {
  const flagged: [number, number][] = [];
  round.categories.forEach((category, col) =>
    category.clues.forEach((clue, row) => {
      if (clue?.wager) flagged.push([col, row]);
    }),
  );
  if (flagged.length > 0) return flagged;
  const chosen: [number, number][] = [];
  const usedCols = new Set<number>();
  for (let n = 0; n < round.wagers; n += 1) {
    const cells: { col: number; row: number; weight: number }[] = [];
    round.categories.forEach((category, col) => {
      if (usedCols.has(col)) return;
      category.clues.forEach((clue, row) => {
        if (clue !== null) cells.push({ col, row, weight: row === 0 ? 0.05 : row });
      });
    });
    const total = cells.reduce((sum, cell) => sum + cell.weight, 0);
    if (total === 0) break;
    let pick = random() * total;
    const cell =
      cells.find((candidate) => (pick -= candidate.weight) < 0) ?? cells[cells.length - 1];
    if (!cell) break;
    chosen.push([cell.col, cell.row]);
    usedCols.add(cell.col);
  }
  return chosen;
}

export function createGame(data: GameData, settings: Settings, seed: number): GameState {
  const random = rng(seed);
  return {
    data,
    settings,
    seq: 1,
    phase: 'lobby',
    players: [],
    round: 0,
    intro: 0,
    played: [],
    wagerCells: data.rounds.map((round) =>
      round.kind === 'board' ? placeWagers(round, random) : [],
    ),
    control: null,
    current: null,
    revealed: false,
    deadline: null,
    roundEnds: null,
    roundExpired: false,
    final: null,
    tiebreaks: 0,
    test: null,
    paused: null,
    rulings: [],
    winners: [],
    nextPlayer: 1,
  };
}

// ---------------------------------------------------------------------------
// Queries

export const activePlayers = (state: GameState): Player[] =>
  state.players.filter((player) => !player.removed).sort((a, b) => a.seat - b.seat);

export const findPlayer = (state: GameState, id: string | null | undefined): Player | undefined =>
  id == null ? undefined : state.players.find((player) => player.id === id && !player.removed);

export function boardRound(state: GameState): BoardRoundData | null {
  const round = state.data.rounds[state.round];
  return round?.kind === 'board' ? round : null;
}

export const roundMax = (round: BoardRoundData): number => Math.max(...round.values);

export function wagerBounds(state: GameState, playerId: string): { min: number; max: number } {
  const round = boardRound(state);
  const player = findPlayer(state, playerId);
  if (!round || !player) return { min: 0, max: 0 };
  return {
    min: Math.min(MIN_WAGER, Math.min(...round.values)),
    max: Math.max(player.score, roundMax(round)),
  };
}

export function isWagerCell(state: GameState, col: number, row: number): boolean {
  return (state.wagerCells[state.round] ?? []).some(([c, r]) => c === col && r === row);
}

function boardCleared(state: GameState): boolean {
  const round = boardRound(state);
  if (!round) return true;
  return round.categories.every((category, col) =>
    category.clues.every((clue, row) => clue === null || state.played[col]?.[row] === true),
  );
}

/** Lowest score selects; a tie goes to the leftmost podium among the tied. */
export function lowestScorer(state: GameState): string | null {
  const players = activePlayers(state);
  let best: Player | null = null;
  for (const player of players) if (best === null || player.score < best.score) best = player;
  return best?.id ?? null;
}

const canStillRespond = (state: GameState, current: CurrentClue): string[] =>
  current.eligible.filter((id) => !current.attempted.includes(id) && findPlayer(state, id));

// ---------------------------------------------------------------------------
// Transitions shared by several actions

function bump(state: GameState, phase?: Phase): void {
  state.seq += 1;
  if (phase !== undefined) state.phase = phase;
}

function startRound(state: GameState, index: number, cues: Cue[]): void {
  const round = state.data.rounds[index];
  state.round = index;
  state.current = null;
  state.revealed = false;
  state.deadline = null;
  state.roundEnds = null;
  state.roundExpired = false;
  if (!round) {
    finishGame(state, cues);
    return;
  }
  if (round.kind === 'final') {
    const eligible = activePlayers(state)
      .filter((player) => player.score > 0)
      .map((player) => player.id);
    if (eligible.length === 0) {
      finishGame(state, cues);
      return;
    }
    const entering: Record<string, number> = {};
    for (const player of activePlayers(state)) entering[player.id] = player.score;
    state.final = {
      eligible,
      entering,
      wagers: {},
      responses: {},
      // Revealed from the lowest score entering the final to the highest.
      order: [...eligible].sort(
        (a, b) =>
          (entering[a] ?? 0) - (entering[b] ?? 0) ||
          (findPlayer(state, a)?.seat ?? 0) - (findPlayer(state, b)?.seat ?? 0),
      ),
      index: -1,
      step: 'wager',
      verdicts: {},
    };
    bump(state, 'final_category');
    return;
  }
  state.played = round.categories.map((category) => category.clues.map(() => false));
  state.intro = 0;
  // The first round starts with whoever has control (the leftmost podium
  // unless the host chose); later rounds with the lowest score.
  if (index > 0 || findPlayer(state, state.control) === undefined) {
    state.control = index > 0 ? lowestScorer(state) : (activePlayers(state)[0]?.id ?? null);
  }
  bump(state, 'round_intro');
  cues.push({ type: 'board_fill' });
}

function endClue(state: GameState): void {
  if (state.current) state.current.responder = null;
  state.deadline = null;
  bump(state, 'clue_end');
}

function finishGame(state: GameState, cues: Cue[]): void {
  state.current = null;
  state.deadline = null;
  state.roundEnds = null;
  const players = activePlayers(state);
  const top = Math.max(...players.map((player) => player.score), 0);
  const leaders = players.filter((player) => player.score === top && top > 0);
  if (
    leaders.length > 1 &&
    state.settings.tiebreak &&
    state.tiebreaks < state.data.tiebreakers.length
  ) {
    state.winners = leaders.map((player) => player.id);
    bump(state, 'tiebreak');
    return;
  }
  state.winners = leaders.map((player) => player.id);
  bump(state, 'game_over');
  cues.push({ type: 'game_over' });
}

function openBuzzers(state: GameState, now: number): void {
  const current = state.current;
  if (!current) return;
  bump(state, 'open');
  current.openSeq = state.seq;
  current.openedAt = now;
  current.responder = null;
  state.deadline = now + state.settings.buzzWindowMs;
}

function record(
  state: GameState,
  current: CurrentClue,
  kind: Ruling['kind'],
  playerId: string,
  amount: number,
  verdict: Verdict,
): Ruling {
  const ruling: Ruling = {
    id: state.rulings.length + 1,
    round: current.round,
    kind,
    playerId,
    category: current.category,
    value: current.value,
    amount,
    verdict,
    reversed: false,
  };
  state.rulings.push(ruling);
  return ruling;
}

/** Applies a ruling's money and statistics, signed: +1 to apply it, -1 to take it back. */
function account(state: GameState, ruling: Ruling, sign: 1 | -1): void {
  const player = state.players.find((candidate) => candidate.id === ruling.playerId);
  if (!player || ruling.kind === 'tiebreak') return;
  const right = ruling.verdict === 'correct';
  player.score += sign * (right ? ruling.amount : -ruling.amount);
  if (ruling.kind === 'final') return;
  player.stats[right ? 'correct' : 'incorrect'] += sign;
  if (ruling.kind === 'clue') player.stats.coryat += sign * (right ? ruling.value : -ruling.value);
  if (ruling.kind === 'wager') {
    player.stats.coryat += sign * (right ? ruling.value : 0);
    player.stats.wagerCorrect += sign * (right ? 1 : 0);
    player.stats.wagerNet += sign * (right ? ruling.amount : -ruling.amount);
  }
}

// ---------------------------------------------------------------------------
// The machine

const PAUSE_ALLOWED: ReadonlySet<ActionType> = new Set([
  'resume',
  'adjust',
  'reverse',
  'rename_player',
  'remove_player',
  'set_control',
  'add_player',
  'tick',
  'final_wager',
  'final_response',
]);

function cleanName(name: string): string {
  // Control characters out, whitespace collapsed, length bounded.
  return name
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

export function apply(state: GameState, action: Action, actor: Actor, now: number): Result {
  if (actor.role === 'player' && !PLAYER_ACTIONS.has(action.type)) return fail('not allowed');
  if (actor.role === 'host' && SYSTEM_ACTIONS.has(action.type)) return fail('not allowed');
  if (state.paused && !PAUSE_ALLOWED.has(action.type)) return fail('paused');
  const self = actor.role === 'player' ? actor.playerId : undefined;
  const cues: Cue[] = [];

  switch (action.type) {
    case 'add_player': {
      const name = cleanName(action.name);
      if (!name) return fail('a name is needed');
      if (activePlayers(state).length >= state.settings.maxPlayers) return fail('the game is full');
      if (state.players.some((player) => player.id === action.id)) return fail('already seated');
      if (state.phase === 'game_over') return fail('the game is over');
      const seats = new Set(activePlayers(state).map((player) => player.seat));
      let seat = 0;
      while (seats.has(seat)) seat += 1;
      state.players.push({
        id: action.id,
        name,
        seat,
        score: 0,
        removed: false,
        stats: emptyStats(),
      });
      if (state.control === null && state.phase !== 'lobby') state.control = action.id;
      bump(state);
      return ok();
    }

    case 'rename_player': {
      const player = findPlayer(state, action.playerId);
      const name = cleanName(action.name);
      if (!player || !name) return fail('no such player');
      player.name = name;
      bump(state);
      return ok();
    }

    case 'remove_player': {
      const player = findPlayer(state, action.playerId);
      if (!player) return fail('no such player');
      player.removed = true;
      if (state.control === player.id) state.control = activePlayers(state)[0]?.id ?? null;
      const current = state.current;
      if (current) {
        // A removed responder is passed over without a ruling: the clue
        // reopens for whoever is left, or ends.
        if (current.responder === player.id && current.wagerer === null) {
          current.attempted.push(player.id);
          if (canStillRespond(state, current).length > 0) openBuzzers(state, now);
          else endClue(state);
        } else if (current.wagerer === player.id && state.phase !== 'clue_end') {
          endClue(state);
        }
      }
      if (state.final) {
        state.final.order = state.final.order.filter((id) => id !== player.id);
      }
      bump(state);
      return ok();
    }

    case 'seat': {
      if (state.phase !== 'lobby' && state.phase !== 'buzzer_test') return fail('seats are set');
      const players = activePlayers(state);
      if (
        action.order.length !== players.length ||
        !players.every((player) => action.order.includes(player.id))
      ) {
        return fail('every player, once');
      }
      action.order.forEach((id, seat) => {
        const player = findPlayer(state, id);
        if (player) player.seat = seat;
      });
      bump(state);
      return ok();
    }

    case 'start_test': {
      if (state.phase !== 'lobby') return fail('only from the lobby');
      state.test = { startedAt: now, presses: {} };
      bump(state, 'buzzer_test');
      return ok();
    }

    case 'end_test': {
      if (state.phase !== 'buzzer_test') return fail('no test running');
      state.test = null;
      bump(state, 'lobby');
      return ok();
    }

    case 'start_game': {
      if (state.phase !== 'lobby' && state.phase !== 'buzzer_test') return fail('already started');
      if (activePlayers(state).length === 0) return fail('nobody has joined');
      state.test = null;
      startRound(state, 0, cues);
      return ok(cues);
    }

    case 'intro_next': {
      const round = boardRound(state);
      if (state.phase !== 'round_intro' || !round) return fail('not introducing a round');
      if (state.intro < round.categories.length) {
        state.intro += 1;
        bump(state);
        cues.push({ type: 'category', index: state.intro - 1 });
        return ok(cues);
      }
      if (state.settings.roundTimeMs !== null) state.roundEnds = now + state.settings.roundTimeMs;
      bump(state, 'board');
      return ok();
    }

    case 'set_control': {
      if (!findPlayer(state, action.playerId)) return fail('no such player');
      state.control = action.playerId;
      bump(state);
      return ok();
    }

    case 'select': {
      const round = boardRound(state);
      if (state.phase !== 'board' || !round) return fail('not choosing a clue');
      if (self !== undefined && state.control !== self) return fail('not your selection');
      const category = round.categories[action.col];
      const clue = category?.clues[action.row];
      if (!category || !clue || state.played[action.col]?.[action.row] !== false) {
        return fail('no such clue');
      }
      const wager = isWagerCell(state, action.col, action.row);
      const wagerer = wager ? (findPlayer(state, state.control)?.id ?? null) : null;
      if (wager && wagerer === null) return fail('nobody has control');
      const row = state.played[action.col];
      if (row) row[action.row] = true;
      const eligible = activePlayers(state).map((player) => player.id);
      state.current = newCurrent(state, {
        col: action.col,
        row: action.row,
        category: category.title,
        categoryNote: category.note,
        value: round.values[action.row] ?? 0,
        clue,
        wagerer,
        tiebreak: false,
        eligible: wagerer ? [wagerer] : eligible,
      });
      state.revealed = false;
      if (wagerer) {
        const player = findPlayer(state, wagerer);
        if (player) player.stats.wagerClues += 1;
        bump(state, 'wager_reveal');
        cues.push({ type: 'wager_reveal' });
      } else {
        bump(state, 'reading');
      }
      return ok(cues);
    }

    case 'continue': {
      if (state.phase === 'wager_reveal') {
        bump(state, 'wager');
        return ok();
      }
      if (state.phase === 'final_category') {
        bump(state, 'final_wager');
        return ok();
      }
      if (state.phase === 'final_wager') {
        const final = state.final;
        if (!final) return fail('no final');
        const missing = final.eligible.filter(
          (id) => final.wagers[id] === undefined && findPlayer(state, id),
        );
        if (missing.length > 0) return fail('waiting for wagers');
        bump(state, 'final_clue');
        return ok();
      }
      if (state.phase === 'final_clue') {
        state.deadline = now + state.settings.finalMs;
        bump(state, 'final_response');
        cues.push({ type: 'final_think' });
        return ok(cues);
      }
      if (state.phase === 'final_response') {
        state.deadline = null;
        bump(state, 'final_reveal');
        return ok();
      }
      if (state.phase === 'tiebreak') {
        const tiebreaker = state.data.tiebreakers[state.tiebreaks];
        if (!tiebreaker) return fail('no tiebreaker clue left');
        state.tiebreaks += 1;
        state.current = newCurrent(state, {
          col: -1,
          row: -1,
          category: tiebreaker.category,
          categoryNote: '',
          value: 0,
          clue: tiebreaker.clue,
          wagerer: null,
          tiebreak: true,
          eligible: [...state.winners],
        });
        state.revealed = false;
        bump(state, 'reading');
        return ok();
      }
      return fail('nothing to continue');
    }

    case 'wager': {
      const current = state.current;
      if (state.phase !== 'wager' || !current?.wagerer) return fail('no wager is being taken');
      const playerId = self ?? current.wagerer;
      if (playerId !== current.wagerer) return fail('not your wager');
      const { min, max } = wagerBounds(state, playerId);
      if (!Number.isInteger(action.amount) || action.amount < min || action.amount > max) {
        return fail(`a wager from ${String(min)} to ${String(max)}`);
      }
      current.wager = action.amount;
      bump(state, 'reading');
      return ok();
    }

    case 'open': {
      const current = state.current;
      if (state.phase !== 'reading' || !current) return fail('no clue is being read');
      if (current.wagerer) {
        current.responder = current.wagerer;
        state.deadline = now + state.settings.wagerResponseMs;
        bump(state, 'responding');
        return ok();
      }
      openBuzzers(state, now);
      return ok();
    }

    case 'buzz':
      return buzz(state, self ?? action.playerId, action.seq, now);

    case 'rule': {
      const current = state.current;
      const responder = current?.responder;
      if (
        (state.phase !== 'responding' && state.phase !== 'adjudicating') ||
        !current ||
        !responder
      ) {
        return fail('nobody is responding');
      }
      const amount = current.wagerer ? (current.wager ?? 0) : current.value;
      const kind = current.tiebreak ? 'tiebreak' : current.wagerer ? 'wager' : 'clue';
      const ruling = record(state, current, kind, responder, amount, action.verdict);
      account(state, ruling, 1);
      cues.push({ type: 'ruling', playerId: responder, verdict: action.verdict, amount });
      current.attempted.push(responder);
      if (action.verdict === 'correct') {
        if (current.tiebreak) {
          state.winners = [responder];
          state.current = null;
          state.deadline = null;
          bump(state, 'game_over');
          cues.push({ type: 'game_over' });
          return ok(cues);
        }
        // The correct responder takes the board; a wager clue's player had it already.
        state.control = responder;
        endClue(state);
        return ok(cues);
      }
      if (!current.wagerer && canStillRespond(state, current).length > 0) {
        openBuzzers(state, now);
      } else {
        // Nobody right: the selector keeps control.
        endClue(state);
      }
      return ok(cues);
    }

    case 'more_specific': {
      const current = state.current;
      if ((state.phase !== 'responding' && state.phase !== 'adjudicating') || !current?.responder) {
        return fail('nobody is responding');
      }
      state.deadline = now + state.settings.responseMs;
      bump(state, 'responding');
      return ok();
    }

    case 'remind_form': {
      const current = state.current;
      const round = boardRound(state);
      if ((state.phase !== 'responding' && state.phase !== 'adjudicating') || !current?.responder) {
        return fail('nobody is responding');
      }
      if (round?.questionForm !== 'lenient' || current.wagerer || current.tiebreak) {
        return fail('this round requires the form of a question — rule it');
      }
      if (current.reminded.includes(current.responder)) return fail('already reminded');
      current.reminded.push(current.responder);
      state.deadline = now + state.settings.responseMs;
      bump(state, 'responding');
      return ok();
    }

    case 'reveal': {
      if (state.phase !== 'clue_end' && state.phase !== 'final_reveal') return fail('not yet');
      if (state.revealed) return fail('already revealed');
      state.revealed = true;
      bump(state);
      return ok();
    }

    case 'skip': {
      if (
        !['wager_reveal', 'wager', 'reading', 'open', 'responding', 'adjudicating'].includes(
          state.phase,
        )
      ) {
        return fail('no clue to skip');
      }
      endClue(state);
      return ok();
    }

    case 'next': {
      if (state.phase === 'clue_end') {
        const current = state.current;
        state.current = null;
        state.revealed = false;
        if (current?.tiebreak) {
          finishGame(state, cues);
          return ok(cues);
        }
        if (state.roundExpired || boardCleared(state)) {
          state.roundEnds = null;
          bump(state, 'round_end');
          cues.push({ type: 'round_end' });
        } else {
          bump(state, 'board');
        }
        return ok(cues);
      }
      if (state.phase === 'round_end') {
        startRound(state, state.round + 1, cues);
        return ok(cues);
      }
      return fail('nothing next');
    }

    case 'end_round': {
      if (state.phase !== 'board') return fail('finish the clue first');
      state.roundEnds = null;
      bump(state, 'round_end');
      cues.push({ type: 'round_end' });
      return ok(cues);
    }

    case 'adjust': {
      const player = findPlayer(state, action.playerId);
      if (!player || !Number.isInteger(action.score) || Math.abs(action.score) > 10_000_000) {
        return fail('a whole-number score');
      }
      player.score = action.score;
      bump(state);
      return ok();
    }

    case 'reverse': {
      const ruling = state.rulings.find((candidate) => candidate.id === action.rulingId);
      if (!ruling) return fail('no such ruling');
      if (ruling.kind === 'tiebreak') return fail('a tiebreak ruling stands');
      if (
        ruling.kind === 'final' &&
        state.phase !== 'final_reveal' &&
        state.phase !== 'game_over'
      ) {
        return fail('not now');
      }
      account(state, ruling, -1);
      ruling.verdict = ruling.verdict === 'correct' ? 'incorrect' : 'correct';
      ruling.reversed = !ruling.reversed;
      account(state, ruling, 1);
      if (ruling.kind === 'final' && state.final)
        state.final.verdicts[ruling.playerId] = ruling.verdict;
      // A corrected final can change who won.
      if (state.phase === 'game_over' && ruling.kind === 'final') {
        state.winners = [];
        finishGame(state, cues);
      }
      bump(state);
      return ok(cues);
    }

    case 'pause': {
      if (state.phase === 'game_over' || state.phase === 'lobby') return fail('nothing to pause');
      state.paused = {
        reason: 'host',
        deadline: state.deadline === null ? null : Math.max(0, state.deadline - now),
        roundEnds: state.roundEnds === null ? null : Math.max(0, state.roundEnds - now),
      };
      state.deadline = null;
      state.roundEnds = null;
      bump(state);
      return ok();
    }

    case 'resume': {
      const paused = state.paused;
      if (!paused) return fail('not paused');
      state.deadline = paused.deadline === null ? null : now + paused.deadline;
      state.roundEnds = paused.roundEnds === null ? null : now + paused.roundEnds;
      state.paused = null;
      if (state.current) state.current.lockouts = {};
      bump(state);
      return ok();
    }

    case 'final_wager': {
      const final = state.final;
      const playerId = self ?? action.playerId;
      if (state.phase !== 'final_wager' || !final) return fail('wagers are closed');
      if (!playerId || !final.eligible.includes(playerId)) return fail('not playing the final');
      const player = findPlayer(state, playerId);
      if (!player) return fail('not playing the final');
      if (!Number.isInteger(action.amount) || action.amount < 0 || action.amount > player.score) {
        return fail(`a wager from 0 to ${String(player.score)}`);
      }
      final.wagers[playerId] = action.amount;
      bump(state);
      return ok();
    }

    case 'final_response': {
      const final = state.final;
      const playerId = self ?? action.playerId;
      // The host may enter one on a player's behalf afterwards (a phone died).
      const open =
        state.phase === 'final_response' ||
        (actor.role === 'host' && state.phase === 'final_reveal');
      if (!open || !final) return fail('responses are closed');
      if (!playerId || !final.eligible.includes(playerId)) return fail('not playing the final');
      final.responses[playerId] = cleanResponse(action.text);
      bump(state);
      return ok();
    }

    case 'final_reveal': {
      const final = state.final;
      if (state.phase !== 'final_reveal' || !final) return fail('not revealing');
      if (final.index === -1 || final.step === 'wager') {
        if (final.index + 1 >= final.order.length) {
          finishGame(state, cues);
          return ok(cues);
        }
        final.index += 1;
        final.step = 'response';
        bump(state);
        return ok();
      }
      if (final.step === 'response') return fail('rule the response first');
      // step === 'ruled': the wager is shown, and only now does the score move.
      const playerId = final.order[final.index];
      const verdict = playerId === undefined ? undefined : final.verdicts[playerId];
      if (playerId !== undefined && verdict !== undefined) {
        const ruling: Ruling = {
          id: state.rulings.length + 1,
          round: state.round,
          kind: 'final',
          playerId,
          category: finalCategory(state),
          value: 0,
          amount: final.wagers[playerId] ?? 0,
          verdict,
          reversed: false,
        };
        state.rulings.push(ruling);
        account(state, ruling, 1);
        cues.push({ type: 'ruling', playerId, verdict, amount: ruling.amount });
      }
      final.step = 'wager';
      bump(state);
      return ok(cues);
    }

    case 'final_rule': {
      const final = state.final;
      if (state.phase !== 'final_reveal' || !final || final.index < 0) return fail('not revealing');
      // Changeable until the wager is shown; after that it's a reversal.
      if (final.step === 'wager') return fail('already scored — reverse the ruling instead');
      const playerId = final.order[final.index];
      if (!playerId) return fail('not revealing');
      final.verdicts[playerId] = action.verdict;
      final.step = 'ruled';
      bump(state);
      return ok();
    }

    case 'tick':
      return tick(state, now);
  }
}

function finalCategory(state: GameState): string {
  const round = state.data.rounds[state.round];
  return round?.kind === 'final' ? round.category : '';
}

function cleanResponse(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, MAX_FINAL_RESPONSE);
}

function newCurrent(
  state: GameState,
  fields: Pick<
    CurrentClue,
    | 'col'
    | 'row'
    | 'category'
    | 'categoryNote'
    | 'value'
    | 'clue'
    | 'wagerer'
    | 'tiebreak'
    | 'eligible'
  >,
): CurrentClue {
  return {
    round: state.round,
    ...fields,
    wager: null,
    attempted: [],
    startSeq: state.seq + 1,
    openSeq: Number.MAX_SAFE_INTEGER,
    openedAt: 0,
    responder: null,
    lockouts: {},
    reminded: [],
  };
}

/**
 * The arbitration. Synchronous, no I/O: the first eligible press the
 * server processes while the buzzers are open wins, and the phase change
 * it makes means every later press in the same window sees `responding`.
 *
 * `seq` is the state the player's device had seen when they pressed. A
 * press stamped before the buzzers opened was made while they were locked —
 * however late it arrives — and locks the player out for `lockoutMs` from
 * its arrival; they must press again after that. A press from another
 * clue is ignored. The seq is only ever used against the presser (a client
 * that lies about it can avoid a lockout it earned, never beat an honest
 * press that arrived first).
 */
function buzz(state: GameState, playerId: string | undefined, seq: number, now: number): Result {
  const player = findPlayer(state, playerId);
  if (!player) return fail('not playing');
  if (state.phase === 'buzzer_test' && state.test) {
    const presses = (state.test.presses[player.id] ??= []);
    presses.push(Math.round(now - state.test.startedAt));
    if (presses.length > 20) presses.shift();
    bump(state);
    return ok([{ type: 'test_press', playerId: player.id }]);
  }
  const current = state.current;
  if (!current || !Number.isInteger(seq) || seq < current.startSeq) return fail('stale');
  if (
    current.wagerer !== null ||
    !current.eligible.includes(player.id) ||
    current.attempted.includes(player.id)
  ) {
    return fail('not eligible');
  }
  const pressedWhileLocked = seq < current.openSeq;
  if (state.phase === 'open' && !pressedWhileLocked) {
    if (now < (current.lockouts[player.id] ?? 0)) return fail('locked out');
    player.stats.buzzes += 1;
    player.stats.wins += 1;
    player.stats.buzzMs.push(Math.round(now - current.openedAt));
    current.responder = player.id;
    state.deadline = now + state.settings.responseMs;
    bump(state, 'responding');
    return ok([{ type: 'buzz', playerId: player.id, ms: Math.round(now - current.openedAt) }]);
  }
  if (!pressedWhileLocked) {
    // Pressed after the buzzers opened, but someone else got there first:
    // counted as an attempt, nothing else changes.
    player.stats.buzzes += 1;
    return ok([{ type: 'late', playerId: player.id }]);
  }
  if (['reading', 'open', 'responding', 'adjudicating'].includes(state.phase)) {
    current.lockouts[player.id] = now + state.settings.lockoutMs;
    player.stats.premature += 1;
    return ok([{ type: 'lockout', playerId: player.id }]);
  }
  return fail('not now');
}

/** The clock: the room calls it at every deadline (and harmlessly at any other time). */
function tick(state: GameState, now: number): Result {
  if (state.paused) return ok();
  const cues: Cue[] = [];
  if (state.roundEnds !== null && now >= state.roundEnds && !state.roundExpired) {
    // The round's time is up: the clue in play finishes, nothing more is chosen.
    state.roundExpired = true;
    state.roundEnds = null;
    if (state.phase === 'board') {
      bump(state, 'round_end');
      cues.push({ type: 'round_end' });
    } else {
      bump(state);
    }
  }
  if (state.deadline !== null && now >= state.deadline) {
    state.deadline = null;
    if (state.phase === 'open') {
      endClue(state);
      cues.push({ type: 'time_up' });
    } else if (state.phase === 'responding') {
      bump(state, 'adjudicating');
      cues.push({ type: 'time_up' });
    } else if (state.phase === 'final_response') {
      bump(state, 'final_reveal');
      cues.push({ type: 'time_up' });
    } else {
      bump(state);
    }
  }
  return ok(cues);
}

/**
 * After a restart every monotonic time in a snapshot is meaningless (a new
 * process, a new clock), so a restored game comes back paused with what
 * was left of its countdowns as of the snapshot — the host resumes it.
 */
export function restore(state: GameState, savedAt: number, now: number): GameState {
  if (!state.paused && (state.deadline !== null || state.roundEnds !== null)) {
    state.paused = {
      reason: 'restart',
      deadline: state.deadline === null ? null : Math.max(0, state.deadline - savedAt),
      roundEnds: state.roundEnds === null ? null : Math.max(0, state.roundEnds - savedAt),
    };
  }
  state.deadline = null;
  state.roundEnds = null;
  if (state.current) {
    state.current.lockouts = {};
    state.current.openedAt = now;
  }
  if (state.test) state.test.startedAt = now;
  state.seq += 1;
  return state;
}

/** The next time `tick` has something to do, or null. */
export function nextDeadline(state: GameState): number | null {
  if (state.paused) return null;
  const times = [state.deadline, state.roundEnds].filter((time): time is number => time !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

export type { ClueData };
