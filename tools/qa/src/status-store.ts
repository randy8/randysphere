/**
 * The files behind /system (status/, git-ignored): written only by jobs —
 * the deploy, the watchdog, `pnpm measure` — and only read by the page.
 * Every write is whole-file and atomic (a temporary file renamed over the
 * old one), so the page can never read half a file; every history is
 * bounded.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const STATUS_DIR = process.env['STATUS_DIR'] ?? join(ROOT, 'status');

/** A JSON list from status/, or an empty one if it's missing or unreadable. */
export function readList<T>(name: string): T[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(STATUS_DIR, name), 'utf8'));
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

export function writeAtomic(name: string, value: unknown): void {
  const path = join(STATUS_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Adds an entry to a list in status/, keeping only the newest `keep`. */
export function append<T>(name: string, entry: T, keep: number): void {
  writeAtomic(name, [...readList<T>(name), entry].slice(-keep));
}
