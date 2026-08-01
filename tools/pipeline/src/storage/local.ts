import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { PipelineError } from '../errors.ts';
import { isDerivativeKey } from '../recipe.ts';
import type { Storage } from './storage.ts';

async function walk(directory: string, prefix: string, into: Map<string, number>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // Nothing published yet is a valid state, not an error.
  }
  for (const entry of entries) {
    const child = join(directory, entry.name);
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(child, key, into);
    } else if (entry.isFile()) {
      into.set(key, (await stat(child)).size);
    }
  }
}

/**
 * Publishes into a directory instead of a bucket.
 *
 * This is not a stub or a test double: it reads the same manifests and copies
 * the same derivative bytes, so a manifest published locally and the same
 * manifest published to R2 are identical. That equivalence is what makes the
 * local mode a real escape hatch rather than a demo.
 */
export function createLocalStorage(directory: string): Storage {
  return {
    description: `local:${directory}`,

    async list(prefix: string): Promise<Map<string, number>> {
      const found = new Map<string, number>();
      // Callers pass "p/"; the walk builds keys by appending a separator, so
      // the trailing one has to come off or every key gains an empty segment.
      await walk(join(directory, prefix), prefix.replace(/\/+$/, ''), found);
      return found;
    },

    async put(key: string, body: Uint8Array): Promise<void> {
      // The key alphabet excludes every character that could escape the
      // directory, but publishing writes files and the check is one line.
      if (!isDerivativeKey(key)) {
        throw new PipelineError(
          `Refusing to write ${JSON.stringify(key)}: not a valid derivative key.`,
        );
      }
      const destination = join(directory, ...key.split('/'));
      if (!destination.startsWith(directory + sep)) {
        throw new PipelineError(`Refusing to write outside ${directory}: ${key}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, body);
    },
  };
}
