import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickRandom } from './pick.ts';

test('pickRandom returns the requested number of distinct items from the pool', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const picked = pickRandom(items, 7);
  assert.equal(picked.length, 7);
  assert.equal(new Set(picked).size, 7);
  assert.ok(picked.every((item) => items.includes(item)));
});

test('pickRandom never returns more than the pool holds, and leaves the pool untouched', () => {
  const items = ['a', 'b', 'c'];
  assert.deepEqual(pickRandom(items, 10).sort(), ['a', 'b', 'c']);
  assert.deepEqual(items, ['a', 'b', 'c']);
  assert.deepEqual(pickRandom(items, 0), []);
});

test('pickRandom gives every item an equal chance', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const counts = new Map(items.map((item) => [item, 0]));
  const trials = 50_000;
  for (let t = 0; t < trials; t += 1) {
    for (const item of pickRandom(items, 2)) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  // Each item is picked in 2 of every 5 draws: 20,000 expected, and
  // ±600 is more than 7 standard deviations either side.
  for (const count of counts.values()) assert.ok(Math.abs(count - 20_000) < 600, String(count));
});

test('pickRandom picks one of each film equally often when asked for one', () => {
  const items = ['a', 'b', 'c', 'd'];
  const counts = new Map(items.map((item) => [item, 0]));
  for (let t = 0; t < 40_000; t += 1) {
    const [picked] = pickRandom(items, 1);
    if (picked !== undefined) counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }
  // 10,000 expected each; ±500 is over 5 standard deviations.
  for (const count of counts.values()) assert.ok(Math.abs(count - 10_000) < 500, String(count));
});
