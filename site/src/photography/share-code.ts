/**
 * Packs an ordered list of photograph ids into a compact, self-contained,
 * URL-safe string, and back — the whole mechanism a shared album link
 * needs on a fully static site with no server to hand out short links from.
 * Pure functions, no DOM/localStorage: every `sourceId` in this archive is
 * exactly 16 hex chars (`SOURCE_ID_LENGTH` in tools/pipeline/src/recipe.ts)
 * — 8 raw bytes — so a list packs as one flat byte string with no
 * delimiters needed, and decodes back by chunking in 8-byte groups.
 */

const ID_BYTES = 8;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== ID_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(encoded: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Deterministic — the same ordered id list always encodes to the same string. */
export function encodeIds(ids: readonly string[]): string {
  const bytes = new Uint8Array(ids.length * ID_BYTES);
  ids.forEach((id, index) => {
    const idBytes = hexToBytes(id);
    if (idBytes !== null) bytes.set(idBytes, index * ID_BYTES);
  });
  return bytesToBase64Url(bytes);
}

/** Never throws — malformed or truncated input just decodes to as much as fits, or []. */
export function decodeIds(encoded: string): string[] {
  const bytes = base64UrlToBytes(encoded);
  if (bytes === null) return [];
  const ids: string[] = [];
  for (let offset = 0; offset + ID_BYTES <= bytes.length; offset += ID_BYTES) {
    ids.push(bytesToHex(bytes.subarray(offset, offset + ID_BYTES)));
  }
  return ids;
}
