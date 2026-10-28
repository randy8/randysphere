import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FALLBACK_AMBIENT, ambientPalette, dominantColors, toAmbient } from './palette.ts';

function pixels(...colors: [number, number, number, number][]): number[] {
  return colors.flatMap(([r, g, b, n]) => Array.from({ length: n }, () => [r, g, b, 255]).flat());
}

test('dominantColors ranks by how much of the frame a colour covers', () => {
  const [first, second] = dominantColors(pixels([200, 40, 40, 10], [40, 40, 200, 30]));
  assert.deepEqual(first, [40, 40, 200]);
  assert.deepEqual(second, [200, 40, 40]);
});

test('dominantColors ignores letterbox black and title-card white', () => {
  const colors = dominantColors(pixels([0, 0, 0, 500], [255, 255, 255, 300], [180, 90, 30, 5]));
  assert.deepEqual(colors, [[180, 90, 30]]);
});

test('dominantColors skips a colour too close to one already picked', () => {
  const colors = dominantColors(pixels([200, 40, 40, 20], [230, 70, 40, 10], [40, 160, 60, 5]));
  assert.equal(colors.length, 2);
  assert.deepEqual(colors[1], [40, 160, 60]);
});

test('dominantColors counts a saturated pixel for more than a grey one', () => {
  const [first] = dominantColors(pixels([128, 128, 128, 10], [200, 40, 40, 6]));
  assert.deepEqual(first, [200, 40, 40]);
});

test('toAmbient keeps the hue but dims and mutes the colour', () => {
  assert.equal(toAmbient([255, 0, 0]), 'hsl(0 55% 38%)');
  assert.equal(toAmbient([20, 20, 60]), 'hsl(240 50% 18%)');
});

test('ambientPalette always returns three colours, repeating the first when short', () => {
  const palette = ambientPalette(pixels([200, 40, 40, 10]));
  assert.equal(palette.length, 3);
  assert.equal(new Set(palette).size, 1);
});

test('ambientPalette falls back to the warm browns for an all-black frame', () => {
  assert.deepEqual(ambientPalette(pixels([0, 0, 0, 50])), [...FALLBACK_AMBIENT]);
});
