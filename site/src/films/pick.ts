/**
 * "Pick for me": films drawn from the collection, every eligible film
 * equally likely, none twice. Pure, so the page script (pick-view.ts) only
 * deals with the DOM and this stays testable.
 */

/**
 * `count` distinct items in random order, each item equally likely to be
 * among them: the first `count` steps of a Fisher–Yates shuffle, so
 * picking 1 from 775 costs one swap, not a full shuffle.
 */
export function pickRandom<T>(items: readonly T[], count: number, random = Math.random): T[] {
  const pool = [...items];
  const n = Math.min(Math.max(Math.floor(count), 0), pool.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, n);
}
