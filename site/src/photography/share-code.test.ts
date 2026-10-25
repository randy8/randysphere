import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadFullArchive } from './archive.ts';
import {
  decodeIds,
  encodeIds,
  FULL_ID_BYTES,
  PREFIX_BYTES,
  resolveIds,
  sharedPrefixes,
} from './share-code.ts';

const IDS = ['0123456789abcdef', 'fedcba9876543210', '00112233445566aa'];

test('full ids round-trip through encode/decode, in order (the original ?s= format)', () => {
  const encoded = encodeIds(IDS, FULL_ID_BYTES);
  assert.deepEqual(decodeIds(encoded, FULL_ID_BYTES), IDS);
});

test('by default each id travels as its 4-byte prefix — about half the length', () => {
  const short = encodeIds(IDS);
  assert.deepEqual(decodeIds(short), ['01234567', 'fedcba98', '00112233']);
  assert.equal(short.length, 16);
  assert.equal(encodeIds(IDS, FULL_ID_BYTES).length, 32);
});

test('an empty list round-trips to an empty list', () => {
  assert.deepEqual(decodeIds(encodeIds([])), []);
});

test('encoding is deterministic — the same ordered list always encodes the same', () => {
  assert.equal(encodeIds(IDS), encodeIds([...IDS]));
});

test('garbage input decodes to an empty list rather than throwing', () => {
  assert.deepEqual(decodeIds('not valid base64url!!!'), []);
  assert.deepEqual(decodeIds(''), []);
  assert.deepEqual(decodeIds('%%%'), []);
});

test('truncated input (not a whole number of ids) decodes only the complete ones', () => {
  const encoded = encodeIds(IDS, FULL_ID_BYTES);
  // Chop off enough of the trailing base64url to drop the last id's bytes.
  const truncated = encoded.slice(0, encoded.length - 6);
  assert.deepEqual(decodeIds(truncated, FULL_ID_BYTES), IDS.slice(0, 2));
});

test('prefixes resolve to the photographs they name, in order; unknown ones resolve to nothing', () => {
  const valid = new Set(IDS);
  assert.deepEqual(resolveIds(['fedcba98', 'deadbeef', '01234567'], valid), [
    'fedcba9876543210',
    '0123456789abcdef',
  ]);
  // A full id is just a prefix that happens to be the whole thing.
  assert.deepEqual(resolveIds(['00112233445566aa'], valid), ['00112233445566aa']);
  // Ambiguous prefixes resolve to nothing rather than guessing.
  assert.deepEqual(resolveIds(['0'], ['0aaa', '0bbb']), []);
});

test('?p= carries prefixes; an old ?s= link still decodes its full ids', () => {
  const short = new URLSearchParams({ p: encodeIds(IDS) });
  const old = new URLSearchParams({ s: encodeIds(IDS, FULL_ID_BYTES) });
  assert.deepEqual(resolveIds(sharedPrefixes(short), IDS), IDS);
  assert.deepEqual(resolveIds(sharedPrefixes(old), IDS), IDS);
});

test(`no two photographs in the archive share a ${String(PREFIX_BYTES)}-byte prefix`, () => {
  // If this ever fails, a short link could name the wrong photograph's
  // twin: raise PREFIX_BYTES (old ?p= links keep working only while their
  // prefixes stay unique, so pick a new query param for the longer form).
  const seen = new Map<string, string>();
  for (const { photo } of loadFullArchive().photos) {
    const prefix = photo.sourceId.slice(0, PREFIX_BYTES * 2);
    const other = seen.get(prefix);
    assert.ok(
      other === undefined || other === photo.sourceId,
      `${photo.sourceId} and ${String(other)} share prefix ${prefix}`,
    );
    seen.set(prefix, photo.sourceId);
  }
});
