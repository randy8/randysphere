/**
 * What each viewer is allowed to see. The game state holds everything —
 * every clue's response, every private wager — and these are the only
 * functions that turn it into something sent over a socket. Each is built
 * by copying named fields in (an allowlist), never by deleting secrets
 * from a copy, so a field added to the state later is private until
 * someone decides otherwise here. answer-secrecy tests assert the result
 * (project.test.ts).
 */

import { activePlayers, boardRound, findPlayer, isWagerCell, wagerBounds } from './game.ts';
import type { GameState, Media, Phase } from './types.ts';

export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
  score: number;
}

export interface PublicView {
  seq: number;
  phase: Phase;
  title: string;
  credit: string;
  round: number;
  rounds: { kind: 'board' | 'final' }[];
  players: PublicPlayer[];
  control: string | null;
  paused: string | null;
  /** Board: titles (revealed ones), notes, values, which cells remain. */
  board: {
    values: number[];
    categories: { title: string | null; note: string | null }[];
    remaining: boolean[][];
  } | null;
  /** The clue in play, without its response unless revealed. */
  clue: {
    category: string;
    categoryNote: string;
    value: number;
    col: number;
    row: number;
    wager: boolean;
    tiebreak: boolean;
    /** Null until a wager clue's bid is in. */
    text: string | null;
    media: Media | null;
    wagerAmount: number | null;
    wagerer: string | null;
    responder: string | null;
    attempted: string[];
    response: string | null;
  } | null;
  /** Server-monotonic deadline, ms from the moment this view was made. */
  remainingMs: number | null;
  roundRemainingMs: number | null;
  roundExpired: boolean;
  final: {
    category: string;
    note: string;
    text: string | null;
    eligible: string[];
    /** Who has a wager / response in — not what it is. */
    wagered: string[];
    responded: string[];
    current: string | null;
    step: string;
    revealed: {
      playerId: string;
      response: string;
      verdict: string | null;
      wager: number | null;
    }[];
    response: string | null;
  } | null;
  test: Record<string, number> | null;
  winners: string[];
  tiebreakCategory: string | null;
}

export interface PlayerView extends PublicView {
  me: {
    id: string;
    canSelect: boolean;
    wager: { min: number; max: number } | null;
    finalWager: number | null;
    finalMax: number | null;
    finalResponse: string | null;
    eligible: boolean;
  };
}

export interface HostView extends PublicView {
  host: {
    response: string | null;
    accept: string[];
    notes: string;
    wagerBounds: { min: number; max: number } | null;
    finalWagers: Record<string, number>;
    finalResponses: Record<string, string>;
    finalResponse: string | null;
    finalAccept: string[];
    finalNotes: string;
    tiebreakResponse: string | null;
    rulings: {
      id: number;
      round: number;
      kind: string;
      playerId: string;
      category: string;
      amount: number;
      verdict: string;
      reversed: boolean;
    }[];
    board: {
      categories: {
        title: string;
        clues: ({ text: string; response: string; wager: boolean } | null)[];
      }[];
    } | null;
    stats: Record<string, unknown>;
    questionForm: string | null;
  };
}

const CLUE_PHASES: ReadonlySet<Phase> = new Set([
  'wager_reveal',
  'wager',
  'reading',
  'open',
  'responding',
  'adjudicating',
  'clue_end',
]);

export function publicView(state: GameState, now: number): PublicView {
  const round = boardRound(state);
  const current = CLUE_PHASES.has(state.phase) ? state.current : null;
  const finalRound = state.data.rounds[state.round];
  const final = state.final;
  const clueVisible = current !== null && state.phase !== 'wager_reveal' && state.phase !== 'wager';
  return {
    seq: state.seq,
    phase: state.phase,
    title: state.data.title,
    credit: state.data.credit,
    round: state.round,
    rounds: state.data.rounds.map((r) => ({ kind: r.kind })),
    players: activePlayers(state).map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      score: player.score,
    })),
    control: state.control,
    paused: state.paused?.reason ?? null,
    board:
      round &&
      ![
        'lobby',
        'buzzer_test',
        'final_category',
        'final_wager',
        'final_clue',
        'final_response',
        'final_reveal',
        'tiebreak',
        'game_over',
      ].includes(state.phase)
        ? {
            values: [...round.values],
            categories: round.categories.map((category, index) => {
              const shown = state.phase !== 'round_intro' || index < state.intro;
              return { title: shown ? category.title : null, note: shown ? category.note : null };
            }),
            remaining: round.categories.map((category, col) =>
              category.clues.map(
                (clue, row) => clue !== null && state.played[col]?.[row] === false,
              ),
            ),
          }
        : null,
    clue: current
      ? {
          category: current.category,
          categoryNote: current.categoryNote,
          value: current.value,
          col: current.col,
          row: current.row,
          wager: current.wagerer !== null,
          tiebreak: current.tiebreak,
          text: clueVisible ? current.clue.text : null,
          media: clueVisible ? current.clue.media : null,
          wagerAmount: state.phase === 'wager' ? null : current.wager,
          wagerer: current.wagerer,
          responder: current.responder,
          attempted: [...current.attempted],
          response: state.revealed ? current.clue.response : null,
        }
      : null,
    remainingMs:
      state.deadline === null
        ? (state.paused?.deadline ?? null)
        : Math.max(0, state.deadline - now),
    roundRemainingMs:
      state.roundEnds === null
        ? (state.paused?.roundEnds ?? null)
        : Math.max(0, state.roundEnds - now),
    roundExpired: state.roundExpired,
    final:
      final && finalRound?.kind === 'final'
        ? {
            category: finalRound.category,
            note: finalRound.note,
            text: [
              'final_clue',
              'final_response',
              'final_reveal',
              'game_over',
              'tiebreak',
            ].includes(state.phase)
              ? finalRound.clue.text
              : null,
            eligible: [...final.eligible],
            wagered: final.eligible.filter((id) => final.wagers[id] !== undefined),
            responded: final.eligible.filter((id) => (final.responses[id] ?? '') !== ''),
            current: state.phase === 'final_reveal' ? (final.order[final.index] ?? null) : null,
            step: final.step,
            revealed: final.order
              .map((playerId, index) => ({ playerId, index }))
              .filter(
                ({ index }) =>
                  state.phase === 'game_over' || state.phase === 'tiebreak' || index <= final.index,
              )
              .map(({ playerId, index }) => {
                const done =
                  state.phase === 'game_over' || state.phase === 'tiebreak' || index < final.index;
                const verdict = final.verdicts[playerId];
                return {
                  playerId,
                  response: final.responses[playerId] ?? '',
                  verdict: done || final.step !== 'response' ? (verdict ?? null) : null,
                  wager: done || final.step === 'wager' ? (final.wagers[playerId] ?? 0) : null,
                };
              }),
            response:
              state.revealed || state.phase === 'game_over' || state.phase === 'tiebreak'
                ? finalRound.clue.response
                : null,
          }
        : // The final ended (game over) and the round index moved on? It doesn't — kept on the final.
          null,
    test: state.test
      ? Object.fromEntries(
          Object.entries(state.test.presses).map(([id, presses]) => [id, presses.length]),
        )
      : null,
    winners: state.phase === 'game_over' || state.phase === 'tiebreak' ? [...state.winners] : [],
    tiebreakCategory:
      state.phase === 'tiebreak'
        ? (state.data.tiebreakers[state.tiebreaks]?.category ?? null)
        : null,
  };
}

export function playerView(state: GameState, playerId: string, now: number): PlayerView {
  const view = publicView(state, now);
  const player = findPlayer(state, playerId);
  const final = state.final;
  const current = state.current;
  return {
    ...view,
    me: {
      id: playerId,
      canSelect: state.phase === 'board' && state.control === playerId,
      wager:
        state.phase === 'wager' && current?.wagerer === playerId
          ? wagerBounds(state, playerId)
          : null,
      finalWager: final?.wagers[playerId] ?? null,
      finalMax: final?.eligible.includes(playerId) ? (player?.score ?? 0) : null,
      finalResponse: final?.responses[playerId] ?? null,
      eligible: player !== undefined,
    },
  };
}

export function hostView(state: GameState, now: number): HostView {
  const view = publicView(state, now);
  const current = CLUE_PHASES.has(state.phase) ? state.current : null;
  const round = boardRound(state);
  const finalRound = state.data.rounds.find((r) => r.kind === 'final');
  const tiebreak =
    state.current?.tiebreak && CLUE_PHASES.has(state.phase) ? state.current.clue.response : null;
  return {
    ...view,
    host: {
      response: current?.clue.response ?? null,
      accept: [...(current?.clue.accept ?? [])],
      notes: current?.clue.notes ?? '',
      wagerBounds:
        state.phase === 'wager' && current?.wagerer ? wagerBounds(state, current.wagerer) : null,
      finalWagers: { ...(state.final?.wagers ?? {}) },
      finalResponses: { ...(state.final?.responses ?? {}) },
      finalResponse: finalRound?.kind === 'final' ? finalRound.clue.response : null,
      finalAccept: finalRound?.kind === 'final' ? [...finalRound.clue.accept] : [],
      finalNotes: finalRound?.kind === 'final' ? finalRound.clue.notes : '',
      tiebreakResponse: tiebreak,
      rulings: state.rulings.map((ruling) => ({ ...ruling })),
      board: round
        ? {
            categories: round.categories.map((category, col) => ({
              title: category.title,
              clues: category.clues.map((clue, row) =>
                clue
                  ? {
                      text: clue.text,
                      response: clue.response,
                      wager: isWagerCell(state, col, row),
                    }
                  : null,
              ),
            })),
          }
        : null,
      stats: Object.fromEntries(state.players.map((player) => [player.id, { ...player.stats }])),
      questionForm: round?.questionForm ?? null,
    },
  };
}
