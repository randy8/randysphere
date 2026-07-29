import { readFile } from 'node:fs/promises';

import { formatJson, writeFileAtomic } from '../files.ts';

/**
 * What we generated for one photograph, keyed by `sourceId` — the same
 * content-derived id the rest of the pipeline already uses, so cache
 * invalidation is "the bytes changed", not a separate hash to maintain.
 *
 * This is a cache, not a contract: `photos.yaml` is the source of truth a
 * photographer edits, and this file exists only so a repeat `pnpm describe`
 * doesn't pay to re-analyse a photograph it already has a description for.
 * Git-ignored, like `generated/derivatives/`, and rebuildable the same way —
 * except rebuilding costs API calls instead of CPU time, which is the whole
 * reason it's worth caching at all.
 */
export interface CachedDescription extends Record<string, unknown> {
  readonly alt: string;
  readonly caption: string;
  readonly provider: string;
}

export type DescriptionCache = Record<string, CachedDescription>;

export async function readDescriptionCache(path: string): Promise<DescriptionCache> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as DescriptionCache;
  } catch {
    // A corrupt cache is not worth failing a describe run over: everything in
    // it is reproducible by calling the provider again.
    return {};
  }
}

export async function writeDescriptionCache(path: string, cache: DescriptionCache): Promise<void> {
  await writeFileAtomic(path, formatJson(cache));
}
