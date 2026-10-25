import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';

import { LoginLimiter, MAX_FAILURES, WINDOW_MS, clientAddress } from './login-limiter.ts';

const T0 = 1_000_000;

test('a client may keep trying until its fifth failure inside the window', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
    limiter.recordFailure('a', T0 + i);
    assert.equal(limiter.retryAfterMs('a', T0 + i), 0);
  }
  limiter.recordFailure('a', T0 + 10);
  assert.ok(limiter.retryAfterMs('a', T0 + 10) > 0);
});

test('a locked client waits until its oldest counted failure ages out', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < MAX_FAILURES; i += 1) limiter.recordFailure('a', T0 + i * 1000);
  assert.equal(limiter.retryAfterMs('a', T0 + 4000), WINDOW_MS - 4000);
  assert.equal(limiter.retryAfterMs('a', T0 + WINDOW_MS), 0);
});

test('failures older than the window do not count', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) limiter.recordFailure('a', T0);
  limiter.recordFailure('a', T0 + WINDOW_MS + 1);
  assert.equal(limiter.retryAfterMs('a', T0 + WINDOW_MS + 1), 0);
});

test('a correct password clears only its own client', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
    limiter.recordFailure('a', T0);
    limiter.recordFailure('b', T0);
  }
  limiter.recordSuccess('a');
  limiter.recordFailure('a', T0);
  limiter.recordFailure('b', T0);
  assert.equal(limiter.retryAfterMs('a', T0), 0);
  assert.ok(limiter.retryAfterMs('b', T0) > 0);
});

test('one client locking itself never locks another', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < MAX_FAILURES * 3; i += 1) limiter.recordFailure('attacker', T0);
  assert.equal(limiter.retryAfterMs('owner', T0), 0);
});

function request(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

test("through the tunnel (a loopback connection), the visitor is Cloudflare's CF-Connecting-IP", () => {
  assert.equal(
    clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })),
    '203.0.113.7',
  );
  assert.equal(clientAddress(request('::1', { 'cf-connecting-ip': '2001:db8::1' })), '2001:db8::1');
});

test('a direct connection cannot choose its own bucket by sending CF-Connecting-IP', () => {
  assert.equal(
    clientAddress(request('192.168.1.50', { 'cf-connecting-ip': '203.0.113.7' })),
    '192.168.1.50',
  );
  assert.equal(
    clientAddress(request('100.64.0.9', { 'cf-connecting-ip': '203.0.113.7' })),
    '100.64.0.9',
  );
});

test('a loopback connection without the header is itself', () => {
  assert.equal(clientAddress(request('127.0.0.1')), '127.0.0.1');
});
