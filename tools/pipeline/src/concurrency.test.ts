import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mapWithConcurrency } from './concurrency.ts';

test('results keep the order of the input, not of completion', async () => {
  const results = await mapWithConcurrency([30, 10, 20], 3, async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  });
  assert.deepEqual(results, [30, 10, 20]);
});

test('never exceeds the limit', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 40 }, (_, index) => index), 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak.toString()}`);
});

test('a failure stops new work from being scheduled', async () => {
  let started = 0;
  await assert.rejects(
    mapWithConcurrency(Array.from({ length: 100 }, (_, index) => index), 2, async (index) => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (index === 1) throw new Error('encoder failed');
    }),
    /encoder failed/,
  );
  // The point is that it does not plough through the remaining 98 photographs.
  assert.ok(started < 20, `started ${started.toString()} items after a failure`);
});

test('an empty input does nothing and returns nothing', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 'x'), []);
});
