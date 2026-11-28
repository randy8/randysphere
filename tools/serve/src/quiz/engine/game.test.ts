import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, createGame, findPlayer, nextDeadline, placeWagers, restore } from './game.ts';
import type { Action, Actor } from './game.ts';
import { boardRound, fixtureGame } from './fixture.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type { GameState, Settings } from './types.ts';

const HOST: Actor = { role: 'host' };
const SYSTEM: Actor = { role: 'system' };
const as = (playerId: string): Actor => ({ role: 'player', playerId });

function must(state: GameState, action: Action, actor: Actor = HOST, now = 0): void {
  const result = apply(state, action, actor, now);
  assert.ok(result.ok, `${action.type} refused: ${result.ok ? '' : result.error}`);
}

function refused(state: GameState, action: Action, actor: Actor = HOST, now = 0): string {
  const before = JSON.stringify(state);
  const result = apply(state, action, actor, now);
  assert.equal(result.ok, false, `${action.type} should be refused`);
  assert.equal(JSON.stringify(state), before, `${action.type} was refused but changed the state`);
  return result.ok ? '' : result.error;
}

const score = (state: GameState, id: string): number => findPlayer(state, id)?.score ?? NaN;

/** Three players, through the introductions, on the first round's board. */
function started(settings: Partial<Settings> = {}): GameState {
  const state = createGame(fixtureGame(), { ...DEFAULT_SETTINGS, ...settings }, 7);
  for (const [id, name] of [
    ['p1', 'Ada'],
    ['p2', 'Grace'],
    ['p3', 'Alan'],
  ] as const) {
    must(state, { type: 'add_player', id, name }, SYSTEM);
  }
  must(state, { type: 'start_game' });
  for (let i = 0; i <= 6; i += 1) must(state, { type: 'intro_next' });
  assert.equal(state.phase, 'board');
  return state;
}

/** Select an ordinary clue and open the buzzers at `now`. */
function openClue(state: GameState, col: number, row: number, now = 1000): void {
  must(state, { type: 'select', col, row });
  assert.equal(state.phase, 'reading');
  must(state, { type: 'open' }, HOST, now);
  assert.equal(state.phase, 'open');
}

test('a game seats players and gives the leftmost podium the first selection', () => {
  const state = started();
  assert.equal(state.control, 'p1');
  assert.deepEqual(
    state.players.map((p) => p.seat),
    [0, 1, 2],
  );
});

test('the fourth player is refused; names are cleaned', () => {
  const state = started();
  assert.match(refused(state, { type: 'add_player', id: 'p4', name: 'Dee' }, SYSTEM), /full/);
  const lobby = createGame(fixtureGame(), DEFAULT_SETTINGS, 1);
  must(lobby, { type: 'add_player', id: 'x', name: '  A\u0000B‮   C  ' }, SYSTEM);
  assert.equal(lobby.players[0]?.name, 'AB C');
  refused(lobby, { type: 'add_player', id: 'y', name: '   ' }, SYSTEM);
});

test('a correct response adds the value and takes control of the board', () => {
  const state = started();
  openClue(state, 2, 0);
  must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1100);
  assert.equal(state.phase, 'responding');
  must(state, { type: 'rule', verdict: 'correct' });
  assert.equal(score(state, 'p2'), 200);
  assert.equal(state.control, 'p2');
  assert.equal(state.phase, 'clue_end');
  must(state, { type: 'next' });
  assert.equal(state.phase, 'board');
});

test('an incorrect response deducts, reopens for the others, and a player responds at most once', () => {
  const state = started();
  openClue(state, 2, 1);
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 1100);
  must(state, { type: 'rule', verdict: 'incorrect' }, HOST, 1500);
  assert.equal(score(state, 'p1'), -400);
  assert.equal(state.phase, 'open', 'buzzing reopens');
  // p1 may not ring in again on this clue.
  assert.match(refused(state, { type: 'buzz', seq: state.seq }, as('p1'), 1600), /eligible/);
  must(state, { type: 'buzz', seq: state.seq }, as('p3'), 1600);
  must(state, { type: 'rule', verdict: 'incorrect' });
  must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1700);
  must(state, { type: 'rule', verdict: 'incorrect' });
  assert.equal(state.phase, 'clue_end', 'nobody left');
  assert.equal(state.control, 'p1', 'the selector keeps control when nobody is right');
  assert.deepEqual(
    [score(state, 'p1'), score(state, 'p2'), score(state, 'p3')],
    [-400, -400, -400],
  );
});

test('simultaneous buzzes: the first processed wins, the rest change nothing', () => {
  const state = started();
  openClue(state, 0, 0);
  const seq = state.seq;
  must(state, { type: 'buzz', seq }, as('p3'), 1050);
  const seqAfterWin = state.seq;
  const result = apply(state, { type: 'buzz', seq }, as('p1'), 1050);
  assert.ok(result.ok && result.cues[0]?.type === 'late', 'an attempt, not a win');
  assert.equal(state.seq, seqAfterWin, 'a late press changes nothing visible');
  assert.equal(state.current?.responder, 'p3');
  // The loser's press counted as an attempt to buzz, not a lockout.
  assert.equal(findPlayer(state, 'p1')?.stats.buzzes, 1);
  assert.equal(findPlayer(state, 'p1')?.stats.premature, 0);
  assert.deepEqual(findPlayer(state, 'p3')?.stats.buzzMs, [50]);
});

test('signalling before the buzzers open locks the player out for 250 ms; they must press again', () => {
  const state = started();
  must(state, { type: 'select', col: 0, row: 1 });
  const readingSeq = state.seq;
  must(state, { type: 'buzz', seq: readingSeq }, as('p1'), 900);
  assert.equal(findPlayer(state, 'p1')?.stats.premature, 1);
  must(state, { type: 'open' }, HOST, 1000);
  const openSeq = state.seq;
  // Inside the lockout (until 1150): refused, and it doesn't extend it.
  assert.match(refused(state, { type: 'buzz', seq: openSeq }, as('p1'), 1100), /locked/);
  // p2 presses within p1's lockout and wins.
  must(state, { type: 'buzz', seq: openSeq }, as('p2'), 1120);
  assert.equal(state.current?.responder, 'p2');
});

test('a press made before the light, arriving after it, is premature — not a win', () => {
  const state = started();
  must(state, { type: 'select', col: 0, row: 2 });
  const readingSeq = state.seq;
  must(state, { type: 'open' }, HOST, 1000);
  // Stamped with the reading phase's seq: pressed while locked.
  must(state, { type: 'buzz', seq: readingSeq }, as('p1'), 1010);
  assert.equal(state.phase, 'open');
  assert.equal(state.current?.lockouts['p1'], 1010 + DEFAULT_SETTINGS.lockoutMs);
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 1300);
  assert.equal(state.current?.responder, 'p1');
});

test('a press from an earlier clue is stale and ignored', () => {
  const state = started();
  openClue(state, 0, 0);
  const oldSeq = state.seq;
  must(state, { type: 'skip' });
  must(state, { type: 'next' });
  openClue(state, 1, 0);
  assert.match(refused(state, { type: 'buzz', seq: oldSeq }, as('p1'), 2000), /stale/);
  assert.equal(findPlayer(state, 'p1')?.stats.premature, 0);
});

test('nobody signals: the buzz window expires and the clue ends', () => {
  const state = started();
  openClue(state, 3, 0, 1000);
  assert.equal(nextDeadline(state), 1000 + DEFAULT_SETTINGS.buzzWindowMs);
  must(state, { type: 'tick' }, SYSTEM, 1000 + DEFAULT_SETTINGS.buzzWindowMs - 1);
  assert.equal(state.phase, 'open');
  const result = apply(state, { type: 'tick' }, SYSTEM, 1000 + DEFAULT_SETTINGS.buzzWindowMs);
  assert.ok(result.ok && result.cues.some((cue) => cue.type === 'time_up'));
  assert.equal(state.phase, 'clue_end');
});

test('the response window expires into adjudication; the host still rules', () => {
  const state = started();
  openClue(state, 3, 1);
  must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1100);
  must(state, { type: 'tick' }, SYSTEM, 1100 + DEFAULT_SETTINGS.responseMs);
  assert.equal(state.phase, 'adjudicating');
  must(state, { type: 'more_specific' }, HOST, 7000);
  assert.equal(state.phase, 'responding');
  assert.equal(state.deadline, 7000 + DEFAULT_SETTINGS.responseMs);
  must(state, { type: 'rule', verdict: 'correct' });
  assert.equal(score(state, 'p2'), 400);
});

test('question form: a reminder in a lenient round, refused in a strict one', () => {
  const state = started();
  openClue(state, 4, 0);
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 1100);
  must(state, { type: 'remind_form' });
  assert.match(refused(state, { type: 'remind_form' }), /already/);
  must(state, { type: 'rule', verdict: 'correct' });
  assert.equal(score(state, 'p1'), 200);
});

test('roles: a player cannot rule, open or adjust; the host cannot pose as the system', () => {
  const state = started();
  openClue(state, 0, 0);
  for (const action of [
    { type: 'rule', verdict: 'correct' },
    { type: 'open' },
    { type: 'adjust', playerId: 'p1', score: 99999 },
    { type: 'next' },
    { type: 'reveal' },
  ] as Action[]) {
    assert.match(refused(state, action, as('p1')), /not allowed/);
  }
  refused(state, { type: 'add_player', id: 'z', name: 'Z' }, HOST);
  refused(state, { type: 'tick' }, HOST);
});

test('only the player in control may select, and the host may select for them', () => {
  const state = started();
  assert.match(refused(state, { type: 'select', col: 0, row: 0 }, as('p2')), /not your/);
  must(state, { type: 'select', col: 0, row: 0 }, as('p1'));
  must(state, { type: 'skip' });
  must(state, { type: 'next' });
  refused(state, { type: 'select', col: 0, row: 0 }, HOST); // already played
  refused(state, { type: 'select', col: 9, row: 0 }, HOST);
});

test('invalid transitions are refused without changing anything', () => {
  const state = started();
  refused(state, { type: 'open' });
  refused(state, { type: 'rule', verdict: 'correct' });
  refused(state, { type: 'wager', amount: 100 });
  refused(state, { type: 'final_reveal' });
  refused(state, { type: 'start_game' });
  refused(state, { type: 'next' });
});

test('wager clue: revealed before its clue, bounded, player-only, and the selector keeps control', () => {
  const state = started();
  must(state, { type: 'adjust', playerId: 'p1', score: 300 });
  must(state, { type: 'select', col: 0, row: 3 });
  assert.equal(state.phase, 'wager_reveal');
  must(state, { type: 'continue' });
  assert.equal(state.phase, 'wager');
  // Max is the greater of the score (300) and the round's top value (1000); min 5.
  refused(state, { type: 'wager', amount: 4 }, as('p1'));
  refused(state, { type: 'wager', amount: 1001 }, as('p1'));
  refused(state, { type: 'wager', amount: 10.5 }, as('p1'));
  refused(state, { type: 'wager', amount: 500 }, as('p2'));
  must(state, { type: 'wager', amount: 1000 }, as('p1'));
  assert.equal(state.phase, 'reading');
  // Nobody can buzz on it.
  refused(state, { type: 'buzz', seq: state.seq }, as('p2'));
  must(state, { type: 'open' }, HOST, 5000);
  assert.equal(state.phase, 'responding');
  assert.equal(state.current?.responder, 'p1');
  must(state, { type: 'rule', verdict: 'incorrect' });
  assert.equal(score(state, 'p1'), -700);
  assert.equal(state.phase, 'clue_end', 'no rebound on a wager clue');
  assert.equal(state.control, 'p1');
  const stats = findPlayer(state, 'p1')?.stats;
  assert.equal(stats?.coryat, 0, 'a missed wager clue costs nothing in Coryat');
  assert.equal(stats?.wagerNet, -1000);
});

test('wager clue with a negative score may bid up to the round maximum', () => {
  const state = started();
  must(state, { type: 'adjust', playerId: 'p1', score: -2000 });
  must(state, { type: 'select', col: 0, row: 3 });
  must(state, { type: 'continue' });
  must(state, { type: 'wager', amount: 1000 }, as('p1'));
  must(state, { type: 'open' });
  must(state, { type: 'rule', verdict: 'correct' });
  assert.equal(score(state, 'p1'), -1000);
  assert.equal(findPlayer(state, 'p1')?.stats.coryat, 800);
});

test('reversing a ruling corrects the score and statistics, not the board control', () => {
  const state = started();
  openClue(state, 1, 2);
  must(state, { type: 'buzz', seq: state.seq }, as('p3'), 1100);
  must(state, { type: 'rule', verdict: 'incorrect' });
  must(state, { type: 'skip' });
  const ruling = state.rulings[0];
  assert.ok(ruling);
  must(state, { type: 'reverse', rulingId: ruling.id });
  assert.equal(score(state, 'p3'), 600);
  assert.equal(findPlayer(state, 'p3')?.stats.correct, 1);
  assert.equal(findPlayer(state, 'p3')?.stats.incorrect, 0);
  assert.equal(state.control, 'p1');
  must(state, { type: 'reverse', rulingId: ruling.id });
  assert.equal(score(state, 'p3'), -600, 'reversing twice restores the original ruling');
});

test('a disconnect-proof removal: a removed responder is passed over without a penalty', () => {
  const state = started();
  openClue(state, 5, 0);
  must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1100);
  must(state, { type: 'remove_player', playerId: 'p2' }, HOST, 1200);
  assert.equal(state.phase, 'open');
  assert.equal(state.players.find((p) => p.id === 'p2')?.score, 0);
  refused(state, { type: 'buzz', seq: state.seq }, as('p2'), 1300);
});

test('pause stops the clock; resume restores exactly what was left', () => {
  const state = started();
  openClue(state, 0, 4, 1000);
  must(state, { type: 'pause' }, HOST, 3000);
  must(state, { type: 'tick' }, SYSTEM, 100_000);
  assert.equal(state.phase, 'open');
  refused(state, { type: 'buzz', seq: state.seq }, as('p1'), 100_000);
  must(state, { type: 'resume' }, HOST, 200_000);
  assert.equal(state.deadline, 200_000 + DEFAULT_SETTINGS.buzzWindowMs - 2000);
});

test('a timed round ends when its clock runs out, leaving unplayed clues', () => {
  const state = started({ roundTimeMs: 60_000 });
  // The clock starts at the board (introductions at time 0).
  assert.equal(state.roundEnds, 60_000);
  openClue(state, 0, 0, 59_000);
  must(state, { type: 'tick' }, SYSTEM, 60_000);
  assert.equal(state.roundExpired, true);
  assert.equal(state.phase, 'open', 'the clue in play finishes');
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 60_100);
  must(state, { type: 'rule', verdict: 'correct' });
  must(state, { type: 'next' });
  assert.equal(state.phase, 'round_end');
  assert.ok(state.played.flat().includes(false), 'unplayed clues remain');
});

/** Plays every ordinary clue of the current round with `p` answering right (skips wager clues). */
function clearBoard(state: GameState): void {
  for (let col = 0; col < 6; col += 1) {
    for (let row = 0; row < 5; row += 1) {
      if (state.played[col]?.[row] !== false) continue;
      must(state, { type: 'select', col, row });
      must(state, { type: 'skip' });
      must(state, { type: 'next' });
    }
  }
  assert.equal(state.phase, 'round_end');
}

test('the second round: lowest score selects first, a tie goes to the leftmost podium', () => {
  const state = started();
  clearBoard(state);
  must(state, { type: 'adjust', playerId: 'p1', score: 1000 });
  must(state, { type: 'adjust', playerId: 'p2', score: -200 });
  must(state, { type: 'adjust', playerId: 'p3', score: -200 });
  must(state, { type: 'next' });
  assert.equal(state.phase, 'round_intro');
  assert.equal(state.control, 'p2');
  assert.equal(state.wagerCells[1]?.length, 2, 'two wager clues in the second round');
});

test('strict round: no question-form reminder', () => {
  const state = started();
  clearBoard(state);
  must(state, { type: 'next' });
  for (let i = 0; i <= 6; i += 1) must(state, { type: 'intro_next' });
  openClue(state, 0, 0);
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 1100);
  assert.match(refused(state, { type: 'remind_form' }), /form of a question/);
});

function toFinal(scores: [number, number, number]): GameState {
  const state = started();
  clearBoard(state);
  must(state, { type: 'next' });
  for (let i = 0; i <= 6; i += 1) must(state, { type: 'intro_next' });
  clearBoard(state);
  ['p1', 'p2', 'p3'].forEach((id, index) =>
    must(state, { type: 'adjust', playerId: id, score: scores[index] ?? 0 }),
  );
  must(state, { type: 'next' });
  return state;
}

test('final: only positive scores play; wagers are private and bounded; reveal lowest first', () => {
  const state = toFinal([5000, 3000, 0]);
  assert.equal(state.phase, 'final_category');
  assert.deepEqual(state.final?.eligible, ['p1', 'p2']);
  must(state, { type: 'continue' });
  refused(state, { type: 'final_wager', amount: 5001 }, as('p1'));
  refused(state, { type: 'final_wager', amount: -1 }, as('p1'));
  refused(state, { type: 'final_wager', amount: 100 }, as('p3'));
  must(state, { type: 'final_wager', amount: 5000 }, as('p1'));
  assert.match(refused(state, { type: 'continue' }), /waiting/);
  must(state, { type: 'final_wager', amount: 0 }, as('p2'));
  must(state, { type: 'continue' });
  assert.equal(state.phase, 'final_clue');
  must(state, { type: 'continue' }, HOST, 10_000);
  assert.equal(state.phase, 'final_response');
  must(state, { type: 'final_response', text: 'What is it?' }, as('p1'), 11_000);
  must(state, { type: 'final_response', text: 'Who is he?' }, as('p2'), 12_000);
  must(state, { type: 'tick' }, SYSTEM, 10_000 + DEFAULT_SETTINGS.finalMs);
  assert.equal(state.phase, 'final_reveal');
  refused(state, { type: 'final_response', text: 'late' }, as('p1'), 50_000);
  assert.deepEqual(state.final?.order, ['p2', 'p1']);
  must(state, { type: 'final_reveal' });
  refused(state, { type: 'final_reveal' }); // rule first
  must(state, { type: 'final_rule', verdict: 'correct' });
  assert.equal(score(state, 'p2'), 3000, 'the score moves only when the wager is shown');
  must(state, { type: 'final_reveal' });
  assert.equal(score(state, 'p2'), 3000);
  must(state, { type: 'final_reveal' });
  must(state, { type: 'final_rule', verdict: 'incorrect' });
  must(state, { type: 'final_reveal' });
  assert.equal(score(state, 'p1'), 0);
  must(state, { type: 'final_reveal' });
  assert.equal(state.phase, 'game_over');
  assert.deepEqual(state.winners, ['p2']);
});

test('final: nobody positive skips straight to the end with no winner', () => {
  const state = toFinal([0, -100, 0]);
  assert.equal(state.phase, 'game_over');
  assert.deepEqual(state.winners, []);
});

test('a tie for first goes to a sudden-death clue; a miss reopens, then another clue', () => {
  const state = toFinal([1000, 1000, 400]);
  must(state, { type: 'continue' });
  must(state, { type: 'final_wager', amount: 0 }, as('p1'));
  must(state, { type: 'final_wager', amount: 0 }, as('p2'));
  must(state, { type: 'final_wager', amount: 0 }, as('p3'));
  must(state, { type: 'continue' });
  must(state, { type: 'continue' }, HOST, 0);
  must(state, { type: 'continue' }, HOST, 1); // end the thinking time early
  for (let i = 0; i < 3; i += 1) {
    must(state, { type: 'final_reveal' });
    must(state, { type: 'final_rule', verdict: 'incorrect' });
    must(state, { type: 'final_reveal' });
  }
  must(state, { type: 'final_reveal' });
  assert.equal(state.phase, 'tiebreak');
  must(state, { type: 'continue' });
  assert.equal(state.current?.tiebreak, true);
  must(state, { type: 'open' }, HOST, 100);
  refused(state, { type: 'buzz', seq: state.seq }, as('p3'), 110); // not tied
  must(state, { type: 'buzz', seq: state.seq }, as('p1'), 120);
  must(state, { type: 'rule', verdict: 'incorrect' }, HOST, 200);
  assert.equal(score(state, 'p1'), 1000, 'tiebreak clues carry no money');
  assert.equal(state.phase, 'open');
  must(state, { type: 'tick' }, SYSTEM, 200 + DEFAULT_SETTINGS.buzzWindowMs);
  must(state, { type: 'next' });
  assert.equal(state.phase, 'tiebreak', 'a second tiebreak clue');
  must(state, { type: 'continue' });
  must(state, { type: 'open' }, HOST, 1000);
  must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1010);
  must(state, { type: 'rule', verdict: 'correct' });
  assert.equal(state.phase, 'game_over');
  assert.deepEqual(state.winners, ['p2']);
});

test('a final ruling reversed after the game can change the winner', () => {
  const state = toFinal([2000, 1000, 0]);
  must(state, { type: 'continue' });
  must(state, { type: 'final_wager', amount: 0 }, as('p1'));
  must(state, { type: 'final_wager', amount: 1000 }, as('p2'));
  must(state, { type: 'continue' });
  must(state, { type: 'continue' });
  must(state, { type: 'continue' });
  for (let i = 0; i < 2; i += 1) {
    must(state, { type: 'final_reveal' });
    must(state, { type: 'final_rule', verdict: 'incorrect' });
    must(state, { type: 'final_reveal' });
  }
  must(state, { type: 'final_reveal' });
  assert.deepEqual(state.winners, ['p1']);
  const p2Final = state.rulings.find((r) => r.kind === 'final' && r.playerId === 'p2');
  assert.ok(p2Final);
  must(state, { type: 'reverse', rulingId: p2Final.id });
  assert.equal(score(state, 'p2'), 2000);
  // Now tied at 2000 → tiebreak.
  assert.equal(state.phase, 'tiebreak');
});

test('restore after a restart comes back paused with the remaining time', () => {
  const state = started();
  openClue(state, 0, 0, 1000);
  const saved = JSON.parse(JSON.stringify(state)) as GameState;
  const restored = restore(saved, 2000, 50);
  assert.equal(restored.paused?.reason, 'restart');
  assert.equal(restored.paused?.deadline, DEFAULT_SETTINGS.buzzWindowMs - 1000);
  assert.equal(restored.deadline, null);
  must(restored, { type: 'resume' }, HOST, 60);
  assert.equal(restored.deadline, 60 + DEFAULT_SETTINGS.buzzWindowMs - 1000);
});

test('replay: the same actions at the same times produce the same game', () => {
  const run = (): string => {
    const state = started();
    openClue(state, 0, 0);
    must(state, { type: 'buzz', seq: state.seq }, as('p2'), 1100);
    must(state, { type: 'rule', verdict: 'correct' });
    return JSON.stringify(state);
  };
  assert.equal(run(), run());
});

test('wager placement: never two in one category, never on a missing clue, seeded', () => {
  const round = boardRound('x', [1, 2, 3, 4, 5]);
  const twice = { ...round, wagers: 2 };
  let seed = 1;
  const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i += 1) {
    const cells = placeWagers(twice, random);
    assert.equal(cells.length, 2);
    assert.notEqual(cells[0]?.[0], cells[1]?.[0]);
  }
  const holes = {
    ...round,
    categories: round.categories.map((category) => ({
      ...category,
      clues: category.clues.map((clue, row) => (row === 4 ? clue : null)),
    })),
  };
  for (let i = 0; i < 50; i += 1) assert.equal(placeWagers(holes, random)[0]?.[1], 4);
});

test('buzzer test records presses per player', () => {
  const state = createGame(fixtureGame(), DEFAULT_SETTINGS, 1);
  must(state, { type: 'add_player', id: 'p1', name: 'A' }, SYSTEM);
  must(state, { type: 'start_test' }, HOST, 100);
  must(state, { type: 'buzz', seq: 0 }, as('p1'), 350);
  assert.deepEqual(state.test?.presses['p1'], [250]);
  must(state, { type: 'start_game' });
  assert.equal(state.test, null);
});
