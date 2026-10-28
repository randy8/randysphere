import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TokenBucket } from './limits.ts';

test('a bucket allows a burst, then refills at its rate', () => {
  const bucket = new TokenBucket(3, 1);
  const t = 1_000_000;
  assert.ok(bucket.take('a', t));
  assert.ok(bucket.take('a', t));
  assert.ok(bucket.take('a', t));
  assert.equal(bucket.take('a', t), false);
  assert.equal(bucket.take('a', t + 500), false);
  assert.ok(bucket.take('a', t + 1600));
});

test('buckets are per key', () => {
  const bucket = new TokenBucket(1, 0.001);
  assert.ok(bucket.take('mom'));
  assert.equal(bucket.take('mom'), false);
  assert.ok(bucket.take('dad'));
});
