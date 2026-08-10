import { createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function timingSafeHexEqual(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * A stateless, HMAC-signed session token — no session store, nothing to
 * garbage-collect, no database (this is a single-user area; a database for
 * one session would be the wrong trade). The token is just an expiry
 * timestamp plus a signature over it, so verifying never has to look
 * anything up: forging one without the secret is infeasible, and nothing
 * server-side can be "logged out" except by the client dropping the cookie
 * or the expiry passing.
 */
export function createSessionToken(secret: string, now: number = Date.now()): string {
  const expires = Math.floor(now / 1000) + SESSION_DURATION_SECONDS;
  const signature = hmac(secret, String(expires)).toString('hex');
  return `${String(expires)}.${signature}`;
}

export function verifySessionToken(
  secret: string,
  token: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  const separator = token.indexOf('.');
  if (separator === -1) return false;
  const expiresRaw = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (expiresRaw.length === 0 || signature.length === 0) return false;
  if (!timingSafeHexEqual(hmac(secret, expiresRaw).toString('hex'), signature)) return false;
  const expires = Number.parseInt(expiresRaw, 10);
  return Number.isFinite(expires) && expires * 1000 > now;
}

/**
 * Compares a submitted password against the configured one without leaking
 * timing information — and without `crypto.timingSafeEqual`'s requirement
 * that both buffers already be the same length, which a raw password
 * string can't guarantee. Hashing both sides to a fixed-length digest
 * first sidesteps that.
 */
export function passwordMatches(secret: string, candidate: string, actual: string): boolean {
  return timingSafeHexEqual(
    hmac(secret, candidate).toString('hex'),
    hmac(secret, actual).toString('hex'),
  );
}
