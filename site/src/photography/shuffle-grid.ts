/**
 * The weighted shuffle behind Selected Work's Shuffle button
 * (selected-view.ts). The first deal on every photo page happens before
 * the first paint, inline, in grid-layout.js — the same algorithm, written
 * out there because an inline script can't import.
 *
 * Efraimidis–Spirakis: each value draws u^(1/weight), largest first. A
 * heavier value tends to come earlier, never certainly; equal weights are
 * an ordinary uniform shuffle.
 */

export function shuffled<T>(values: readonly T[], weight: (value: T) => number = () => 1): T[] {
  return values
    .map((value) => ({ value, key: Math.random() ** (1 / weight(value)) }))
    .sort((a, b) => b.key - a.key)
    .map(({ value }) => value);
}
