import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Web Push, standards only and no dependency: the payload is encrypted for
 * the receiving browser (RFC 8291, `aes128gcm` of RFC 8188), and each
 * request carries a VAPID signature (RFC 8292) so the push service knows
 * which server it comes from. Node's crypto has every primitive (P-256
 * ECDH, HKDF, AES-128-GCM, ES256), so the `web-push` package would add a
 * dependency for ~120 lines. Checked against RFC 8291's own worked example
 * (webpush.test.ts).
 *
 * Apple, Google and Mozilla relay the bytes but can't read them; only the
 * subscribed browser holds the private key.
 */

export interface PushTarget {
  readonly endpoint: string;
  /** The browser's P-256 public key, base64url (uncompressed point, 65 bytes). */
  readonly p256dh: string;
  /** The browser's 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface VapidKeys {
  readonly privateKey: KeyObject;
  /** The uncompressed public point, base64url: what the page passes as applicationServerKey. */
  readonly publicKey: string;
}

const RECORD_SIZE = 4096;

const b64 = (data: Buffer): string => data.toString('base64url');
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url');

/**
 * The push services this server will post to. A subscription's endpoint
 * is a URL the browser hands the page; checking its host keeps a member's
 * crafted "subscription" from turning this server into a client for some
 * other address (this machine's own loopback services included).
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    endpoint.length <= 1024 &&
    PUSH_HOSTS.some((pattern) => pattern.test(url.hostname))
  );
}

/** Checks a subscription's keys have the shapes RFC 8291 requires. */
export function isPushKeys(p256dh: string, auth: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return false;
  const key = unb64(p256dh);
  return key.length === 65 && key[0] === 0x04 && unb64(auth).length === 16;
}

/**
 * The server's VAPID key pair, made on first use and kept beside chat.db
 * (owner-only, like the rest of private/family). Every subscription is
 * bound to it: a new key means every device must subscribe again, so it is
 * never rotated casually.
 */
export function loadVapidKeys(path: string): VapidKeys {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    try {
      // Exclusive: a deploy's candidate server and the live one may both
      // start here first; whichever writes first wins, the other reads it.
      writeFileSync(path, JSON.stringify(privateKey.export({ format: 'jwk' })), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const jwk = JSON.parse(readFileSync(path, 'utf8')) as { x: string; y: string; d: string };
  const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', ...jwk }, format: 'jwk' });
  const publicKey = b64(Buffer.concat([Buffer.from([0x04]), unb64(jwk.x), unb64(jwk.y)]));
  return { privateKey, publicKey };
}

/**
 * Encrypts `plaintext` for one subscription (RFC 8291 §3.4, one record).
 * `asPrivate` and `salt` are only passed by the test that replays the
 * RFC's example; in use both are fresh for every message.
 */
export function encryptPayload(
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  plaintext: Buffer,
  fixed: { asPrivate?: Buffer; salt?: Buffer } = {},
): Buffer {
  const uaPublic = unb64(target.p256dh);
  const authSecret = unb64(target.auth);
  const ecdh = createECDH('prime256v1');
  if (fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = fixed.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  );

  // One record, so the padding delimiter is 0x02 ("last record"), no padding.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('Push payload too large.');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** The `Authorization` header for one push service (RFC 8292): a 12-hour ES256 JWT. */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: number = Date.now(),
): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/**
 * Sends one notification. `gone` means the push service says this
 * subscription no longer exists (404/410) and it should be forgotten;
 * `failed` is anything else (worth a count, not a deletion).
 */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  options: {
    keys: VapidKeys;
    subject: string;
    /** How long the push service may hold it for an offline device, in seconds. */
    ttl?: number;
    /** Replaces an undelivered notification with the same topic instead of queueing another. */
    topic?: string;
    fetch?: typeof fetch;
  },
): Promise<{ outcome: PushOutcome; status: number }> {
  const body = encryptPayload(target, Buffer.from(JSON.stringify(payload), 'utf8'));
  const headers: Record<string, string> = {
    authorization: vapidAuthorization(target.endpoint, options.keys, options.subject),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(options.ttl ?? 24 * 60 * 60),
    urgency: 'high',
  };
  if (options.topic) headers['topic'] = options.topic;
  try {
    const response = await (options.fetch ?? fetch)(target.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410)
      return { outcome: 'gone', status: response.status };
    return { outcome: response.ok ? 'sent' : 'failed', status: response.status };
  } catch {
    return { outcome: 'failed', status: 0 };
  }
}
