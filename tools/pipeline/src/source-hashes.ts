import { readFile, stat } from 'node:fs/promises';

import { formatJson, writeFileAtomic } from './files.ts';
import { sha256File } from './hash.ts';

/**
 * A cache of each original's SHA-256, keyed by path and checked against the
 * file's size and modification time. Hashing every original is what made a
 * nothing-changed ingest take ~45 seconds (19 GB of TIFFs read in full on
 * every deploy); with this, an unchanged file costs one `stat`.
 *
 * Purely an optimisation: a hit returns exactly what hashing would, and any
 * change to a file's size or mtime — a new scan, a re-export, an edit —
 * misses and hashes for real. The one blind spot is bytes rewritten with
 * the mtime deliberately restored, which nothing in this workflow does;
 * deleting generated/source-hashes.json forces a full rehash regardless.
 * Git-ignored, like the derivatives it saves re-reading for.
 */
interface Entry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface SourceHashes {
  /** SHA-256 hex of the file at `path`, from the cache when it's still current. */
  readonly hash: (path: string) => Promise<string>;
  /** Writes the cache back if anything was hashed for real this run. */
  readonly save: () => Promise<void>;
}

export async function loadSourceHashes(cacheFile: string): Promise<SourceHashes> {
  let previous: Record<string, Entry> = {};
  try {
    previous = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, Entry>;
  } catch {
    // Missing or unreadable: start empty, every file hashes once.
  }
  const seen: Record<string, Entry> = {};
  // Concurrent photos write distinct keys, so sharing these is safe.
  let changed = false;

  return {
    hash: async (path) => {
      const { size, mtimeMs } = await stat(path);
      const cached = previous[path];
      if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) {
        seen[path] = cached;
        return cached.sha256;
      }
      const sha256 = await sha256File(path);
      seen[path] = { size, mtimeMs, sha256 };
      changed = true;
      return sha256;
    },
    // Merged, not replaced: an `--album` run only sees its own batch, and
    // must not forget every other batch's hashes.
    save: async () => {
      if (!changed) return;
      await writeFileAtomic(cacheFile, formatJson({ ...previous, ...seen }));
    },
  };
}
