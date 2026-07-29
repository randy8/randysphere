import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write via a temporary file in the same directory and rename over the target.
 *
 * Every generated file goes through here. An interrupted run then leaves either
 * the previous complete file or the new complete file, never half of either,
 * which is what makes a manifest safe to trust after a crash.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid.toString()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

/** JSON in the one form the pipeline writes, so reruns produce no diff. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
