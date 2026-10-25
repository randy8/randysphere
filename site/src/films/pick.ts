/**
 * "Pick for me": a number of films drawn from the collection, every
 * eligible film equally likely, none twice. Pure, so the page script
 * (pick-view.ts) only deals with the DOM and this stays testable.
 */

/**
 * How many to pick from what the visitor typed: a whole number from 1 to
 * `available`. Empty or unreadable input means 1; a fraction rounds down;
 * anything past either end is held to it. 0 when there's nothing to pick.
 */
export function pickCount(raw: string, available: number): number {
  if (available <= 0) return 0;
  const parsed = Math.floor(Number(raw.trim()));
  if (raw.trim() === '' || !Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, 1), available);
}

/**
 * `count` distinct items in random order, each item equally likely to be
 * among them: the first `count` steps of a Fisher–Yates shuffle, so
 * picking 3 from 775 costs 3 swaps, not a full shuffle.
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
