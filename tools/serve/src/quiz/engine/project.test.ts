import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, createGame } from './game.ts';
import type { Action, Actor } from './game.ts';
import { fixtureGame } from './fixture.ts';
import { hostView, playerView, publicView } from './project.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type { GameState } from './types.ts';

const HOST: Actor = { role: 'host' };
function must(state: GameState, action: Action, actor: Actor = HOST, now = 0): void {
  const result = apply(state, action, actor, now);
  assert.ok(result.ok, result.ok ? '' : result.error);
}

/** Every response, alternative and note in the fixture — none may reach a non-host before its reveal. */
const SECRETS = /Response |Alt |Note /;

function game(): GameState {
  const state = createGame(fixtureGame(), DEFAULT_SETTINGS, 3);
  must(state, { type: 'add_player', id: 'p1', name: 'A' }, { role: 'system' });
  must(state, { type: 'add_player', id: 'p2', name: 'B' }, { role: 'system' });
  must(state, { type: 'start_game' });
  return state;
}

function views(state: GameState): string[] {
  return [
    JSON.stringify(publicView(state, 0)),
    JSON.stringify(playerView(state, 'p1', 0)),
    JSON.stringify(playerView(state, 'p2', 0)),
  ];
}

test('no response, alternative or host note reaches the audience or players before its reveal', () => {
  const state = game();
  // Introductions: unrevealed categories have no title yet.
  assert.equal(publicView(state, 0).board?.categories[0]?.title, null);
  for (const view of views(state)) assert.doesNotMatch(view, SECRETS);
  for (let i = 0; i <= 6; i += 1) must(state, { type: 'intro_next' });
  must(state, { type: 'select', col: 2, row: 2 });
  must(state, { type: 'open' });
  for (const view of views(state)) assert.doesNotMatch(view, SECRETS);
  // The host sees them.
  assert.match(JSON.stringify(hostView(state, 0)), /Response a22/);
  must(state, { type: 'skip' });
  for (const view of views(state)) assert.doesNotMatch(view, SECRETS);
  must(state, { type: 'reveal' });
  assert.equal(publicView(state, 0).clue?.response, 'Response a22');
});

test("a wager clue's text stays hidden until the bid is in", () => {
  const state = game();
  for (let i = 0; i <= 6; i += 1) must(state, { type: 'intro_next' });
  must(state, { type: 'select', col: 0, row: 3 });
  assert.equal(publicView(state, 0).clue?.text, null);
  must(state, { type: 'continue' });
  assert.equal(publicView(state, 0).clue?.text, null);
  assert.deepEqual(playerView(state, 'p1', 0).me.wager, { min: 5, max: 1000 });
  assert.equal(playerView(state, 'p2', 0).me.wager, null);
  must(state, { type: 'wager', amount: 500 });
  assert.equal(publicView(state, 0).clue?.text, 'Clue a03');
});

test("final wagers and responses are private until revealed; nobody sees another's", () => {
  const state = game();
  state.players.forEach((player) => (player.score = 1000));
  state.phase = 'round_end';
  state.round = 1;
  must(state, { type: 'next' });
  must(state, { type: 'continue' });
  assert.equal(publicView(state, 0).final?.text, null, 'clue hidden while wagering');
  must(state, { type: 'final_wager', amount: 777 }, { role: 'player', playerId: 'p1' });
  must(state, { type: 'final_wager', amount: 333 }, { role: 'player', playerId: 'p2' });
  assert.equal(playerView(state, 'p1', 0).me.finalWager, 777);
  for (const view of views(state)) {
    assert.doesNotMatch(view.replace(/"finalWager":777/, ''), /777/);
    assert.doesNotMatch(view.replace(/"finalWager":333/, ''), /333/);
  }
  must(state, { type: 'continue' });
  must(state, { type: 'continue' });
  must(
    state,
    { type: 'final_response', text: 'What is secret-one?' },
    { role: 'player', playerId: 'p1' },
  );
  must(state, { type: 'continue' });
  assert.doesNotMatch(JSON.stringify(playerView(state, 'p2', 0)), /secret-one/);
  assert.doesNotMatch(JSON.stringify(publicView(state, 0)), /secret-one|Response final/);
  assert.match(JSON.stringify(hostView(state, 0)), /secret-one/);
  // Equal scores: the leftmost podium (p1) is revealed first.
  must(state, { type: 'final_reveal' });
  let shown = publicView(state, 0).final?.revealed.find((entry) => entry.playerId === 'p1');
  assert.equal(shown?.response, 'What is secret-one?');
  assert.equal(shown?.verdict, null);
  assert.equal(shown?.wager, null, 'wager not until its step');
  assert.equal(publicView(state, 0).final?.revealed.length, 1, "p2's response not yet");
  must(state, { type: 'final_rule', verdict: 'incorrect' });
  must(state, { type: 'final_reveal' });
  shown = publicView(state, 0).final?.revealed.find((entry) => entry.playerId === 'p1');
  assert.equal(shown?.wager, 777);
});
