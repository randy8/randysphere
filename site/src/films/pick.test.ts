import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickCount, pickRandom } from './pick.ts';

test('pickCount reads a whole number within 1 and the number available', () => {
  assert.equal(pickCount('3', 10), 3);
  assert.equal(pickCount(' 4 ', 10), 4);
  assert.equal(pickCount('2.9', 10), 2);
});

test('pickCount treats empty or unreadable input as 1', () => {
  assert.equal(pickCount('', 10), 1);
  assert.equal(pickCount('abc', 10), 1);
  assert.equal(pickCount('1e400', 10), 1);
});

test('pickCount holds a request past either end to that end', () => {
  assert.equal(pickCount('0', 10), 1);
  assert.equal(pickCount('-5', 10), 1);
  assert.equal(pickCount('50', 10), 10);
});

test('pickCount is 0 when nothing is eligible', () => {
  assert.equal(pickCount('3', 0), 0);
});

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
