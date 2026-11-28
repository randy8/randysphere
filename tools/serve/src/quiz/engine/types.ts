/**
 * The quiz engine's data: what a game is made of (GameData — authored,
 * imported or assembled at random, see ../catalog.ts) and what a game in
 * progress is (GameState — plain JSON, so a snapshot is JSON.stringify and
 * a restore is JSON.parse). Nothing here knows about sockets, SQLite,
 * themes or wording: the engine is mechanics only, and every word a viewer
 * reads comes from the theme (static/themes/).
 */

export interface Media {
  readonly kind: 'image' | 'audio' | 'video';
  /** https:// or a path under /quiz/media/ — anything else is dropped on import (../validate.ts). */
  readonly url: string;
}

export interface ClueData {
  /** Stable within the game; the catalog's clue id when it came from the database. */
  readonly id: string;
  readonly text: string;
  /** The correct response, as the host reads it. Never sent to anyone but the host until revealed. */
  readonly response: string;
  /** Other responses the host may accept. Host-only. */
  readonly accept: readonly string[];
  /** Pronunciation guide, sourcing, a judge's note. Host-only. */
  readonly notes: string;
  readonly media: Media | null;
  /** A wager clue's position is fixed by the data (a historical board) — otherwise placed at random. */
  readonly wager: boolean;
  /** Original selection order on the historical board, when known (1-based). */
  readonly order: number | null;
}

export interface CategoryData {
  readonly title: string;
  /** Special instructions read with the category ("Responses will be…"). Public. */
  readonly note: string;
  /** One per row; null where a historical board's clue was never revealed. */
  readonly clues: readonly (ClueData | null)[];
}

export type QuestionForm = 'lenient' | 'strict';

export interface BoardRoundData {
  readonly kind: 'board';
  /** Dollar value per row, top to bottom — the round's own configuration, historical or modern. */
  readonly values: readonly number[];
  readonly categories: readonly CategoryData[];
  /** How many wager clues to place when no clue is flagged. */
  readonly wagers: number;
  /**
   * lenient: a response not phrased as a question earns a reminder, not a
   * penalty (outside wager clues) — the first round's convention. strict:
   * the host rules it incorrect.
   */
  readonly questionForm: QuestionForm;
}

export interface FinalRoundData {
  readonly kind: 'final';
  readonly category: string;
  readonly note: string;
  readonly clue: ClueData;
}

export type RoundData = BoardRoundData | FinalRoundData;

export interface TiebreakerData {
  readonly category: string;
  readonly clue: ClueData;
}

export interface GameData {
  readonly title: string;
  /** Free text credit, shown on the lobby: who wrote it, where it came from. */
  readonly credit: string;
  readonly rounds: readonly RoundData[];
  readonly tiebreakers: readonly TiebreakerData[];
}

export interface Settings {
  /** Seats. The televised format is three. */
  readonly maxPlayers: number;
  /** After a buzz is won: time to begin responding. */
  readonly responseMs: number;
  /** Buzzers open with nobody signalling: time until the clue expires. */
  readonly buzzWindowMs: number;
  /** After a wager clue is read: time for its player to respond. */
  readonly wagerResponseMs: number;
  /** The final round's thinking time. */
  readonly finalMs: number;
  /** Signalling before the buzzers are enabled locks the player out for this long. */
  readonly lockoutMs: number;
  /** Per board round, ms; null for untimed. Broadcast games run about 10–12 minutes a round. */
  readonly roundTimeMs: number | null;
  /** A tie for first after the final round goes to a sudden-death clue, when one exists. */
  readonly tiebreak: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 3,
  responseMs: 5000,
  buzzWindowMs: 5000,
  wagerResponseMs: 10000,
  finalMs: 30000,
  lockoutMs: 250,
  roundTimeMs: null,
  tiebreak: true,
};

export type Phase =
  | 'lobby'
  | 'buzzer_test'
  /** Categories revealed one at a time (`intro` counts them). */
  | 'round_intro'
  | 'board'
  /** A wager clue found: its reveal, before anything about the clue is shown. */
  | 'wager_reveal'
  | 'wager'
  /** The clue is up and being read; buzzers locked. */
  | 'reading'
  | 'open'
  | 'responding'
  /** The response window ran out; the host's ruling is awaited. */
  | 'adjudicating'
  /** The clue is over; the correct response may be revealed. */
  | 'clue_end'
  | 'round_end'
  | 'final_category'
  | 'final_wager'
  /** The final clue is up; the thinking time hasn't started. */
  | 'final_clue'
  | 'final_response'
  | 'final_reveal'
  | 'tiebreak'
  | 'game_over';

export interface Player {
  readonly id: string;
  name: string;
  /** Podium position, left to right; ties are broken by it (the leftmost podium). */
  seat: number;
  score: number;
  removed: boolean;
  stats: PlayerStats;
}

export interface PlayerStats {
  /** Presses while the buzzers were open (wins included). */
  buzzes: number;
  wins: number;
  /** Presses while the buzzers were locked — each one locked the player out. */
  premature: number;
  correct: number;
  incorrect: number;
  /** Score without wagers: wager clues count 0 when missed and their face value when right. */
  coryat: number;
  wagerClues: number;
  wagerCorrect: number;
  wagerNet: number;
  /**
   * Server-measured, open → arrival of the winning buzz, ms. Includes the
   * network trip from the phone: it is not human reaction time.
   */
  buzzMs: number[];
}

export type Verdict = 'correct' | 'incorrect';

export interface Ruling {
  readonly id: number;
  readonly round: number;
  readonly kind: 'clue' | 'wager' | 'final' | 'tiebreak';
  readonly playerId: string;
  readonly category: string;
  /** Face value of the clue (Coryat) — the wager is `amount` when it differs. */
  readonly value: number;
  readonly amount: number;
  verdict: Verdict;
  reversed: boolean;
}

export interface CurrentClue {
  readonly round: number;
  readonly col: number;
  readonly row: number;
  readonly category: string;
  readonly categoryNote: string;
  readonly value: number;
  readonly clue: ClueData;
  /** The wager clue's player; null for an ordinary clue. */
  readonly wagerer: string | null;
  wager: number | null;
  readonly tiebreak: boolean;
  /** Players who have responded (or been ruled out) on this clue. */
  attempted: string[];
  /** Eligible to signal at all (tiebreak: only the tied). */
  readonly eligible: string[];
  /** seq when the clue went up; anything older is another clue's. */
  readonly startSeq: number;
  /** seq when the buzzers last opened; a press stamped earlier was made while they were locked. */
  openSeq: number;
  openedAt: number;
  responder: string | null;
  /** Players locked out until this monotonic time for signalling early. */
  lockouts: Record<string, number>;
  /** A lenient-round reminder was given to this player on this clue. */
  reminded: string[];
}

export interface FinalState {
  readonly eligible: string[];
  /** Scores entering the final, which fix the reveal order (lowest first). */
  readonly entering: Record<string, number>;
  wagers: Record<string, number>;
  responses: Record<string, string>;
  order: string[];
  /** Index into order of the contestant being revealed; -1 before the first. */
  index: number;
  /** What of order[index] is shown: their response, then the ruling, then the wager. */
  step: 'response' | 'ruled' | 'wager';
  verdicts: Record<string, Verdict>;
}

export interface Paused {
  readonly reason: 'host' | 'restart' | 'host_away';
  /** Remaining time of whatever was counting down when the game paused. */
  readonly deadline: number | null;
  readonly roundEnds: number | null;
}

export interface GameState {
  readonly data: GameData;
  readonly settings: Settings;
  /** Bumped on every change. Clients echo it; stale commands are refused. */
  seq: number;
  phase: Phase;
  players: Player[];
  round: number;
  /** Categories revealed so far in round_intro. */
  intro: number;
  /** played[col][row] for the current board round. */
  played: boolean[][];
  /** Wager clue positions [col,row] per round (index = round). */
  wagerCells: [number, number][][];
  control: string | null;
  current: CurrentClue | null;
  /** The correct response is up on the audience display. */
  revealed: boolean;
  /** Monotonic ms the current countdown ends at, or null. */
  deadline: number | null;
  /** Monotonic ms the round's time limit ends at, or null. */
  roundEnds: number | null;
  /** The round's clock ran out: the round ends when the board is next shown. */
  roundExpired: boolean;
  final: FinalState | null;
  /** Tiebreak clues used so far. */
  tiebreaks: number;
  /** Buzzer test: when each player last pressed (server ms, since the test began). */
  test: { startedAt: number; presses: Record<string, number[]> } | null;
  paused: Paused | null;
  rulings: Ruling[];
  winners: string[];
  nextPlayer: number;
}

/** What happened, for sound, animation and the record — never needed to reconstruct state. */
export type Cue =
  | { type: 'buzz'; playerId: string; ms: number }
  | { type: 'lockout'; playerId: string }
  /** Pressed in time, but after someone else: an attempt, not a win. */
  | { type: 'late'; playerId: string }
  | { type: 'test_press'; playerId: string }
  | { type: 'board_fill' }
  | { type: 'category'; index: number }
  | { type: 'wager_reveal' }
  | { type: 'time_up' }
  | { type: 'round_end' }
  | { type: 'ruling'; playerId: string; verdict: Verdict; amount: number }
  | { type: 'final_think' }
  | { type: 'game_over' };
