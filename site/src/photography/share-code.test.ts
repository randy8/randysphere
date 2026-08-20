import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeIds, encodeIds } from './share-code.ts';

const IDS = ['0123456789abcdef', 'fedcba9876543210', '00112233445566aa'];

test('a list of ids round-trips through encode/decode, in order', () => {
  const encoded = encodeIds(IDS);
  assert.deepEqual(decodeIds(encoded), IDS);
});

test('an empty list round-trips to an empty list', () => {
  assert.deepEqual(decodeIds(encodeIds([])), []);
});

test('encoding is deterministic — the same ordered list always encodes the same', () => {
  assert.equal(encodeIds(IDS), encodeIds([...IDS]));
});

test('a single id round-trips', () => {
  assert.deepEqual(decodeIds(encodeIds(['0123456789abcdef'])), ['0123456789abcdef']);
});

test('garbage input decodes to an empty list rather than throwing', () => {
  assert.deepEqual(decodeIds('not valid base64url!!!'), []);
  assert.deepEqual(decodeIds(''), []);
  assert.deepEqual(decodeIds('%%%'), []);
});

test('truncated input (not a whole number of ids) decodes only the complete ones', () => {
  const encoded = encodeIds(IDS);
  // Chop off enough of the trailing base64url to drop the last id's bytes.
  const truncated = encoded.slice(0, encoded.length - 6);
  assert.deepEqual(decodeIds(truncated), IDS.slice(0, 2));
});
