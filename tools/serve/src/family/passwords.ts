import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Argon2id through Node's own crypto (no native add-on to build), stored
 * as a standard PHC string so the parameters travel with each hash and
 * can be raised later without invalidating old ones. 64 MiB, 3 passes —
 * above OWASP's minimum, ~200 ms on this machine, which is nothing for a
 * login and a lot for a guesser.
 */
const PARAMS = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32 } as const;

function derive(
  password: string,
  nonce: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: password, nonce, ...params }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const key = await derive(password, nonce, PARAMS);
  return `$argon2id$v=19$m=${String(PARAMS.memory)},t=${String(PARAMS.passes)},p=${String(PARAMS.parallelism)}$${b64(nonce)}$${b64(key)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored);
  if (!match) return false;
  const [, m, t, p, nonce64, key64] = match;
  const expected = Buffer.from(key64 ?? '', 'base64');
  const actual = await derive(password, Buffer.from(nonce64 ?? '', 'base64'), {
    memory: Number(m),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | null = null;

/**
 * A real hash of nothing in particular, verified against when the username
 * doesn't exist — so "no such user" takes as long as "wrong password" and
 * the login form can't be used to find out who has an account.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

/** The floor for a new password: long enough to matter, nothing fussier. */
export const MIN_PASSWORD_LENGTH = 8;
