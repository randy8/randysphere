import assert from 'node:assert/strict';
import { test } from 'node:test';

import { averageColorHex } from './color.ts';

test('a uniform image averages to its own colour', () => {
  const pixels = new Uint8Array(30).fill(0);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = 0x33;
    pixels[offset + 1] = 0x66;
    pixels[offset + 2] = 0x99;
  }
  assert.equal(averageColorHex(pixels, 3), '#336699');
});

test('components are zero padded', () => {
  assert.equal(averageColorHex(new Uint8Array([1, 2, 3]), 3), '#010203');
});

test('an alpha channel is ignored rather than treated as blue', () => {
  const rgba = new Uint8Array([10, 20, 30, 255, 10, 20, 30, 0]);
  assert.equal(averageColorHex(rgba, 4), '#0a141e');
});

test('an empty buffer does not divide by zero', () => {
  assert.equal(averageColorHex(new Uint8Array(0), 3), '#000000');
});
