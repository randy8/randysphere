// The demonstration set is read as plain JSON and edited in place to make
// invalid variants of it; typing every level of it would only restate the
// file format.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createCustom,
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
import { detectFormat, parseCsv, parseDataset, parseDelimited, parseOutline } from './importer.ts';
import { InvalidGame, parseGame, playable, toFile } from './validate.ts';

const DEMO = readFileSync(new URL('./data/demo.json', import.meta.url), 'utf8');

function seeded() {
  const db = openDatabase(':memory:');
  const dataset = parseDataset('demo.json', DEMO);
  assert.deepEqual(dataset.skipped, []);
  const source = ensureSource(db, dataset.source ?? { name: 'x', license: 'y' });
  for (const game of dataset.games) importEpisode(db, game, source, { listed: true });
  return db;
}

let seed = 42;
const random = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

test('the demonstration set imports completely and round-trips', () => {
  const db = seeded();
  const episodes = listEpisodes(db, { listed: true });
  assert.equal(episodes.length, 2);
  const loaded = loadEpisode(db, episodes[0]?.id ?? 0);
  assert.ok(loaded);
  assert.equal(loaded.game.rounds.length, 3);
  assert.equal(loaded.game.tiebreakers.length, 2);
  const board = loaded.game.rounds[0];
  assert.equal(board?.kind, 'board');
  if (board?.kind === 'board') {
    assert.equal(board.categories.length, 6);
    assert.ok(board.categories.every((category) => category.clues.every((clue) => clue !== null)));
  }
  // Re-validating the loaded game succeeds: what the catalog returns is a valid game file.
  const again = parseGame(toFile(loaded.game, loaded.meta));
  assert.equal(playable(again.game), null);
});

test('a re-import replaces the episode with the same source and id instead of duplicating it', () => {
  const db = seeded();
  const dataset = parseDataset('demo.json', DEMO);
  const source = ensureSource(db, dataset.source ?? { name: 'x', license: 'y' });
  const first = dataset.games[0];
  assert.ok(first);
  const result = importEpisode(db, first, source, { listed: true });
  assert.equal(result.replaced, true);
  assert.equal(listEpisodes(db).length, 2);
});

test('random boards are made of complete categories from different episodes', () => {
  const db = seeded();
  const game = randomGame(db, random);
  assert.ok(game);
  const [one, two, final] = game.rounds;
  assert.equal(one?.kind, 'board');
  assert.equal(two?.kind, 'board');
  assert.equal(final?.kind, 'final');
  if (one?.kind !== 'board' || two?.kind !== 'board') return;
  assert.deepEqual(one.values, [200, 400, 600, 800, 1000]);
  assert.deepEqual(two.values, [400, 800, 1200, 1600, 2000]);
  // Every category is one of the library's own, with its clues in their original order.
  const originals = new Map<string, string[]>();
  for (const summary of listEpisodes(db)) {
    for (const round of loadEpisode(db, summary.id)?.game.rounds ?? []) {
      if (round.kind !== 'board') continue;
      for (const category of round.categories)
        originals.set(
          category.title,
          category.clues.map((clue) => clue?.text ?? ''),
        );
    }
  }
  for (const category of [...one.categories, ...two.categories]) {
    assert.deepEqual(
      category.clues.map((clue) => clue?.text ?? ''),
      originals.get(category.title),
      `${category.title} was not kept whole`,
    );
  }
});

test('a category search prefers matching categories', () => {
  const db = seeded();
  const game = randomGame(db, random, { query: 'World' });
  const first = game?.rounds[0];
  assert.ok(
    first?.kind === 'board' &&
      first.categories.some((category) => category.title === 'WORLD CAPITALS'),
  );
});

test('practice serves a clue without its response, and answers only for listed episodes', () => {
  const db = seeded();
  const clue = practiceClue(db, random, null);
  assert.ok(clue);
  assert.equal('response' in clue, false);
  assert.ok(practiceAnswer(db, clue.id)?.response);
  const key = 'k'.repeat(43);
  const parsed = parseGame(JSON.parse(DEMO).games[0]);
  const custom = createCustom(db, parsed.game, key);
  const customClue = (
    loadEpisode(db, custom)?.game.rounds[0] as unknown as {
      categories: { clues: { id: string }[] }[];
    }
  ).categories[0]?.clues[0];
  assert.equal(
    practiceAnswer(db, Number(customClue?.id.slice(1))),
    null,
    'unlisted custom boards stay private',
  );
});

test('custom boards are owned by their key; only its hash is stored', () => {
  const db = openDatabase(':memory:');
  const key = 'secret-key-value';
  const parsed = parseGame(JSON.parse(DEMO).games[1]);
  const id = createCustom(db, parsed.game, key);
  assert.equal(keyMatches(db, id, key), true);
  assert.equal(keyMatches(db, id, 'wrong'), false);
  const stored = db.prepare('SELECT edit_key_hash FROM episodes WHERE id = ?').get(id) as {
    edit_key_hash: string;
  };
  assert.notEqual(stored.edit_key_hash, key);
  updateCustom(db, id, { ...parsed.game, title: 'Renamed' });
  assert.equal(loadEpisode(db, id)?.game.title, 'Renamed');
});

test('validation: bounds, media hosts, drafts', () => {
  assert.throws(() => parseGame({ title: 'x', rounds: [] }), InvalidGame);
  const base = JSON.parse(DEMO).games[0];
  const withMedia = structuredClone(base);
  withMedia.rounds[0].categories[0].clues[0].media = { kind: 'image', url: 'javascript:alert(1)' };
  assert.throws(() => parseGame(withMedia), /media.url/);
  withMedia.rounds[0].categories[0].clues[0].media = {
    kind: 'image',
    url: 'https://example.org/a.png',
  };
  assert.equal(parseGame(withMedia).game.rounds.length, 3);
  const draft = structuredClone(base);
  draft.rounds[0].categories[0].clues[0] = { text: 'Only text so far', response: '' };
  draft.rounds[0].categories[1].clues[0] = { text: '', response: '' };
  assert.throws(() => parseGame(draft), /response is required/);
  const parsed = parseGame(draft, { draft: true });
  const round = parsed.game.rounds[0];
  assert.ok(
    round?.kind === 'board' && round.categories[1]?.clues[0] === null,
    'a blank cell is empty',
  );
  assert.match(playable(parsed.game) ?? '', /needs both a clue and a response/);
  const long = structuredClone(base);
  long.title = 'x'.repeat(500);
  assert.throws(() => parseGame(long), /longer than/);
  const control = structuredClone(base);
  control.title = 'A\u0007B‮C';
  assert.equal(parseGame(control).game.title, 'ABC');
});

test('CSV: quoted fields, historical values, wager clues off the value grid, finals', () => {
  assert.deepEqual(parseDelimited('a,"b,c","d ""e"""\n1,2,3\n', ','), [
    ['a', 'b,c', 'd "e"'],
    ['1', '2', '3'],
  ]);
  const header = 'Show Number,Air Date,Round,Category,Value,Question,Answer\n';
  const lines: string[] = [];
  for (const [round, values] of [
    ['Jeopardy!', [100, 200, 300, 400, 500]],
    ['Double Jeopardy!', [200, 400, 600, 800, 1000]],
  ] as const) {
    for (let col = 0; col < 6; col += 1) {
      values.forEach((value, row) => {
        // One clue per round carries a wager amount instead of its face value.
        const shown = col === 2 && row === 3 ? '$1,500' : `$${String(value)}`;
        lines.push(
          `1234,1999-03-01,${round},"CAT ${round[0] ?? ''}${String(col)}","${shown}","Clue <i>${String(col)}${String(row)}</i>","Answer \\'${String(row)}\\'"`,
        );
      });
    }
  }
  lines.push('1234,1999-03-01,Final Jeopardy!,FINAL CAT,None,"Final clue","Final answer"');
  const dataset = parseCsv(header + lines.join('\n'));
  assert.deepEqual(dataset.skipped, []);
  const game = dataset.games[0]?.game;
  assert.ok(game);
  const [one, two, final] = game.rounds;
  assert.ok(one?.kind === 'board' && two?.kind === 'board' && final?.kind === 'final');
  assert.deepEqual(one.values, [100, 200, 300, 400, 500], 'pre-2001 values inferred');
  assert.deepEqual(two.values, [200, 400, 600, 800, 1000]);
  assert.equal(one.categories[2]?.clues[3]?.wager, true);
  assert.equal(one.categories[2]?.clues[3]?.text, 'Clue 23', 'HTML stripped');
  assert.equal(one.categories[0]?.clues[0]?.response, "Answer '0'");
  assert.equal(dataset.games[0]?.meta.airDate, '1999-03-01');
  assert.equal(final.category, 'FINAL CAT');
});

const OUTLINE = `Title: Friday night
// a comment
# Round 1
values: 100 200
## SPACE
note: All NASA
Launched in 1977,
this probe left the solar system
= Voyager 1 | Voyager | V1
note: accept V-1 too
[wager] It landed in Jezero Crater
= Perseverance
## BOOKS
Twain's real surname
= Clemens
# Round 2
form: strict
## OCEANS
Named for a country
= the Indian Ocean
# Final
## LANDMARKS
Built for 1889
= the Eiffel Tower
# Tiebreak
## RIVERS
Through Cairo
= the Nile
`;

test('an outline becomes a game: rounds, rows from the top, alternatives, notes, wager pins, defaults', () => {
  assert.equal(detectFormat('', OUTLINE), 'outline');
  const [file] = parseOutline(OUTLINE, { draft: true }).games;
  assert.ok(file);
  const game = file.game;
  assert.equal(game.title, 'Friday night');
  const [first, second, final] = game.rounds;
  assert.equal(first?.kind, 'board');
  assert.equal(second?.kind, 'board');
  assert.equal(final?.kind, 'final');
  if (first?.kind !== 'board' || second?.kind !== 'board' || final?.kind !== 'final') return;
  assert.deepEqual(first.values, [100, 200]);
  const space = first.categories[0];
  assert.equal(space?.note, 'All NASA');
  assert.equal(space?.clues[0]?.text, 'Launched in 1977, this probe left the solar system');
  assert.equal(space?.clues[0]?.response, 'Voyager 1');
  assert.deepEqual(space?.clues[0]?.accept, ['Voyager', 'V1']);
  assert.equal(space?.clues[0]?.notes, 'accept V-1 too');
  assert.equal(space?.clues[1]?.wager, true);
  assert.equal(first.categories[1]?.clues[1], null, 'a short category leaves its lower rows empty');
  assert.deepEqual(second.values, [400, 800, 1200, 1600, 2000]);
  assert.equal(second.questionForm, 'strict');
  assert.equal(final.clue.response, 'the Eiffel Tower');
  assert.equal(game.tiebreakers[0]?.clue.response, 'the Nile');
  assert.equal(playable(game), null, 'empty cells are allowed: they are simply not on the board');
});

test('outline mistakes name their line', () => {
  assert.throws(() => parseOutline('## NO ROUND\nclue\n= r'), /line 1: .*round heading/);
  assert.throws(() => parseOutline('# Round 1\n## A\nclue one\n## B'), /line 4: .*no "=" response/);
  assert.throws(() => parseOutline('# Round 1\nvalues: 1 two\n'), /line 2: values/);
  assert.throws(
    () => parseOutline('# Round 1\nvalues: 100\n## A\none\n= 1\ntwo\n= 2'),
    /2 clues for 1 values/,
  );
});
