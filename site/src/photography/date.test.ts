import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDate } from './date.ts';

test('formatDate reads an ISO date as day, full month, year', () => {
  assert.equal(formatDate('2026-10-25'), '25 October 2026');
});

test('formatDate drops a leading zero from the day', () => {
  assert.equal(formatDate('2025-08-07'), '7 August 2025');
});

test('formatDate leaves anything that is not a plain ISO date unchanged', () => {
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('2025-13-01'), '2025-13-01');
  assert.equal(formatDate('2025-08-27T10:00:00'), '2025-08-27T10:00:00');
});
