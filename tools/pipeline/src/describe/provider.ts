/**
 * What `pnpm describe` needs from a description source, and nothing else.
 *
 * One method, because generating a description is genuinely the only thing a
 * provider does — everything else (deciding which photos need one, caching,
 * respecting a manual edit, writing the result into `photos.yaml`) lives in
 * `describe.ts` and is identical no matter which provider answers the call.
 * Adding a second provider later is implementing this interface once, not
 * touching ingest or the orchestration logic at all.
 */
export interface DescriptionRequest {
  /** Absolute path to a derivative image to describe — a mid-size JPEG, never the original. */
  readonly imagePath: string;
  /**
   * Soft, non-authoritative context: the album slug and the roll id the photo
   * came from (e.g. "paris-2025", "0827"). A provider may use this to orient
   * itself but must not assert it as fact — a directory name is not a
   * verified location, date, or event.
   */
  readonly context: { readonly album: string; readonly roll: string };
}

export interface Description {
  readonly alt: string;
  readonly caption: string;
}

export interface DescriptionProvider {
  /** Short, stable name recorded in the cache — e.g. "claude". */
  readonly name: string;
  describe(request: DescriptionRequest): Promise<Description>;
}
