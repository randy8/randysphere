import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withAlbumLock } from './lock.ts';

function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('overlapping calls for the same directory resolve strictly in submission order', async () => {
  const order: number[] = [];

  const first = withAlbumLock('/album-a', async () => {
    await later();
    await later();
    order.push(1);
  });
  const second = withAlbumLock('/album-a', () => {
    order.push(2);
  });
  const third = withAlbumLock('/album-a', () => {
    order.push(3);
  });

  await Promise.all([first, second, third]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('different directories run independently, without waiting on each other', async () => {
  const order: string[] = [];

  const slow = withAlbumLock('/album-a', async () => {
    await later();
    order.push('a');
  });
  const fast = withAlbumLock('/album-b', () => {
    order.push('b');
  });

  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['b', 'a']);
});

test('a failed call does not wedge later calls for the same directory, and its own caller still sees the rejection', async () => {
  const order: string[] = [];

  const failing = withAlbumLock('/album-a', () => {
    throw new Error('boom');
  });
  const next = withAlbumLock('/album-a', () => {
    order.push('ran');
  });

  await assert.rejects(failing, /boom/);
  await next;
  assert.deepEqual(order, ['ran']);
});
