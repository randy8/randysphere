/**
 * A token bucket per key: `capacity` actions at once, refilled at `perSecond`.
 * Bursty on purpose — someone pasting three photos and a line of text in a
 * row is normal — but a stuck retry loop or a script can't flood the
 * conversation. In memory: a restart forgets, which only ever errs toward
 * letting family through.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #perSecond: number;
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(capacity: number, perSecond: number) {
    this.#capacity = capacity;
    this.#perSecond = perSecond;
  }

  /** Takes one token for `key` if there is one. */
  take(key: string, now: number = Date.now()): boolean {
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, at: now };
    const tokens = Math.min(
      this.#capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.#perSecond,
    );
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, at: now });
      return false;
    }
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.#buckets.size > 10_000) {
      const [oldest] = this.#buckets.keys();
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    return true;
  }
}
