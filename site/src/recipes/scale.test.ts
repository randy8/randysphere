import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatNice, scaleQuantity } from './scale.ts';

test('formatNice rounds a near-whole value down to the whole number', () => {
  assert.equal(formatNice(2.02), '2');
});

test('formatNice rounds a near-whole value up to the next whole number', () => {
  assert.equal(formatNice(1.97), '2');
});

test('formatNice snaps a remainder to the nearest common cooking fraction', () => {
  assert.equal(formatNice(1.5), '1½');
  assert.equal(formatNice(0.5), '½');
  assert.equal(formatNice(2.25), '2¼');
  assert.equal(formatNice(0.34), '⅓');
});

test('scaleQuantity halves a plain number with a trailing unit', () => {
  assert.equal(scaleQuantity('454 g', 0.5), '227 g');
});

test('scaleQuantity scales both ends of an en-dash range independently', () => {
  assert.equal(scaleQuantity('600–800 g', 0.5), '300–400 g');
});

test('scaleQuantity scales a fraction-to-whole range', () => {
  assert.equal(scaleQuantity('½–1', 2), '1–2');
});

test('scaleQuantity doubles a plain count', () => {
  assert.equal(scaleQuantity('3–4', 2), '6–8');
});

test('scaleQuantity leaves text with no recognizable leading number unchanged', () => {
  assert.equal(scaleQuantity('a pinch', 0.5), 'a pinch');
});

test('scaleQuantity at 1x is a no-op modulo formatting', () => {
  assert.equal(scaleQuantity('20–35 g', 1), '20–35 g');
});
