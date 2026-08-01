import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Originals are routinely 50-100 MB and every one of them is hashed on every
 * ingest, so this streams rather than reading the file into memory.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest('hex');
}

/**
 * JSON with object keys sorted, so that a value always serialises to the same
 * string regardless of the order its properties were assigned. Derivative keys
 * are digests of these strings; without the sorting, reordering a property in
 * an object literal would silently invalidate every image on the site.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, JsonValue>);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${body.join(',')}}`;
}

/** Digest of a set of strings, order-independent. Used for album key sets. */
export function digestOfSet(values: Iterable<string>): string {
  return sha256Hex(canonicalJson([...values].sort()));
}
