import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalJson, digestOfSet, sha256File, sha256Hex } from './hash.ts';

test('canonical JSON is independent of property order', () => {
  const a = canonicalJson({ width: 400, format: 'avif', quality: 55 });
  const b = canonicalJson({ quality: 55, width: 400, format: 'avif' });
  assert.equal(a, b);
  assert.equal(a, '{"format":"avif","quality":55,"width":400}');
});

test('canonical JSON sorts nested objects but preserves array order', () => {
  const value = canonicalJson({ outer: { b: 1, a: 2 }, list: [3, 1, 2] });
  assert.equal(value, '{"list":[3,1,2],"outer":{"a":2,"b":1}}');
});

test('canonical JSON distinguishes values a looser encoding would merge', () => {
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: '1' }));
  assert.notEqual(canonicalJson({ a: null }), canonicalJson({ a: false }));
});

test('set digests ignore ordering', () => {
  assert.equal(digestOfSet(['b', 'a', 'c']), digestOfSet(['c', 'b', 'a']));
  assert.notEqual(digestOfSet(['a', 'b']), digestOfSet(['a', 'b', 'c']));
});

test('streamed file hashing matches hashing the whole buffer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'photo-hash-'));
  const path = join(directory, 'source.bin');
  // Larger than one read chunk, so the streaming path is actually exercised.
  const bytes = Buffer.alloc(200_000, 7);
  await writeFile(path, bytes);
  assert.equal(await sha256File(path), sha256Hex(bytes));
});
