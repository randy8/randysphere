/**
 * The Fisher–Yates shuffle behind Selected Work's Shuffle button
 * (selected-view.ts). The first deal on every photo page happens before
 * the first paint, inline, in GridDeal.astro — the same algorithm, written
 * out there because an inline script can't import.
 */

export function shuffled<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
