import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayedDimensions, isQuarterTurn, scaledHeight } from './orientation.ts';

const landscape = { width: 6000, height: 4000 };

test('orientations 5 to 8 transpose the stored dimensions', () => {
  for (const orientation of [5, 6, 7, 8]) {
    assert.equal(isQuarterTurn(orientation), true);
    assert.deepEqual(displayedDimensions(landscape, orientation), { width: 4000, height: 6000 });
  }
});

test('orientations 1 to 4 and absent orientation leave dimensions alone', () => {
  for (const orientation of [1, 2, 3, 4, undefined]) {
    assert.equal(isQuarterTurn(orientation), false);
    assert.deepEqual(displayedDimensions(landscape, orientation), landscape);
  }
});

test('a portrait photograph from a rotated sensor is described as portrait', () => {
  // The failure this guards against: a 6000x4000 file with orientation 6 is a
  // portrait photograph. Reporting it as landscape puts every such image in a
  // wrongly shaped box and produces a layout shift when it loads.
  const displayed = displayedDimensions({ width: 6000, height: 4000 }, 6);
  assert.ok(displayed.height > displayed.width);
});

test('scaled heights preserve aspect ratio and never round to zero', () => {
  assert.equal(scaledHeight(landscape, 1200), 800);
  assert.equal(scaledHeight({ width: 6000, height: 4001 }, 1200), 800);
  assert.equal(scaledHeight({ width: 10000, height: 3 }, 16), 1);
});
