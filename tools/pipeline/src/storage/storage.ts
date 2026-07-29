/**
 * Everything the pipeline needs from a publishing target, and nothing else.
 *
 * Two methods, because there are two implementations that genuinely need it —
 * a bucket and a directory — and because publishing has exactly two questions:
 * what is already there, and please put this. There is deliberately no delete:
 * the pipeline never removes a published photograph, and an interface method
 * that nothing calls is an invitation.
 */
export interface Storage {
  /** Shown in messages and recorded in published.json, e.g. "r2:photographs". */
  readonly description: string;

  /** Keys currently present under `prefix`, mapped to their size in bytes. */
  list(prefix: string): Promise<Map<string, number>>;

  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

/**
 * Derivatives are addressed by a digest of their content, so a key that exists
 * can never need replacing. A year is the longest max-age browsers respect.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
