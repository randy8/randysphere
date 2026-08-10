import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSessionToken, passwordMatches, verifySessionToken } from './session.ts';

const SECRET = 'test-secret';

test('a freshly created token verifies against the same secret', () => {
  const token = createSessionToken(SECRET);
  assert.equal(verifySessionToken(SECRET, token), true);
});

test('a token verifies against a different secret is rejected', () => {
  const token = createSessionToken(SECRET);
  assert.equal(verifySessionToken('other-secret', token), false);
});

test('a token past its expiry is rejected', () => {
  const now = Date.now();
  const token = createSessionToken(SECRET, now);
  const thirtyOneDaysLater = now + 31 * 24 * 60 * 60 * 1000;
  assert.equal(verifySessionToken(SECRET, token, thirtyOneDaysLater), false);
});

test('a token one second before its expiry still verifies', () => {
  const now = Date.now();
  const token = createSessionToken(SECRET, now);
  const justBeforeExpiry = now + 30 * 24 * 60 * 60 * 1000 - 1000;
  assert.equal(verifySessionToken(SECRET, token, justBeforeExpiry), true);
});

test('a tampered expiry is rejected even if the signature format still parses', () => {
  const token = createSessionToken(SECRET);
  const [, signature] = token.split('.');
  const tampered = `9999999999.${signature}`;
  assert.equal(verifySessionToken(SECRET, tampered), false);
});

test('missing, empty, or malformed tokens are all rejected, not thrown on', () => {
  assert.equal(verifySessionToken(SECRET, undefined), false);
  assert.equal(verifySessionToken(SECRET, ''), false);
  assert.equal(verifySessionToken(SECRET, 'not-a-token'), false);
  assert.equal(verifySessionToken(SECRET, '123.'), false);
  assert.equal(verifySessionToken(SECRET, '.abc'), false);
});

test('the correct password matches regardless of surrounding secret', () => {
  assert.equal(passwordMatches(SECRET, 'correct horse', 'correct horse'), true);
});

test('an incorrect password of any length is rejected without throwing', () => {
  assert.equal(passwordMatches(SECRET, 'wrong', 'correct horse'), false);
  assert.equal(passwordMatches(SECRET, '', 'correct horse'), false);
  assert.equal(
    passwordMatches(SECRET, 'a much much longer guess than the real one', 'correct horse'),
    false,
  );
});
