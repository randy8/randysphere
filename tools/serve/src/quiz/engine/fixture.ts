/** A small, complete game for tests: two board rounds, a final, two tiebreakers. */

import type { BoardRoundData, ClueData, GameData } from './types.ts';

export function clue(id: string, wager = false): ClueData {
  return {
    id,
    text: `Clue ${id}`,
    response: `Response ${id}`,
    accept: [`Alt ${id}`],
    notes: `Note ${id}`,
    media: null,
    wager,
    order: null,
  };
}

export function boardRound(
  prefix: string,
  values: number[],
  options: {
    wagerAt?: [number, number][];
    cols?: number;
    questionForm?: 'lenient' | 'strict';
  } = {},
): BoardRoundData {
  const cols = options.cols ?? 6;
  return {
    kind: 'board',
    values,
    wagers: 1,
    questionForm: options.questionForm ?? 'lenient',
    categories: Array.from({ length: cols }, (_, col) => ({
      title: `${prefix} Category ${String(col + 1)}`,
      note: col === 0 ? 'Every response starts with B' : '',
      clues: values.map((_, row) =>
        clue(
          `${prefix}${String(col)}${String(row)}`,
          (options.wagerAt ?? []).some(([c, r]) => c === col && r === row),
        ),
      ),
    })),
  };
}

export function fixtureGame(): GameData {
  return {
    title: 'Fixture',
    credit: 'tests',
    rounds: [
      boardRound('a', [200, 400, 600, 800, 1000], { wagerAt: [[0, 3]] }),
      boardRound('b', [400, 800, 1200, 1600, 2000], {
        wagerAt: [
          [1, 2],
          [4, 4],
        ],
        questionForm: 'strict',
      }),
      { kind: 'final', category: 'Final Category', note: '', clue: clue('final') },
    ],
    tiebreakers: [
      { category: 'Tiebreak One', clue: clue('tb1') },
      { category: 'Tiebreak Two', clue: clue('tb2') },
    ],
  };
}
