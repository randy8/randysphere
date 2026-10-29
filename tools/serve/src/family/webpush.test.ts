import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  encryptPayload,
  isPushEndpoint,
  isPushKeys,
  loadVapidKeys,
  sendPush,
  vapidAuthorization,
} from './webpush.ts';

const unb64 = (text: string): Buffer => Buffer.from(text.replace(/\s+/g, ''), 'base64url');

// RFC 8291, Section 5 and Appendix A: the worked example, byte for byte.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`,
  ciphertext: `8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
               bI_0LpXMuGvnzQ`,
};

test('payload encryption reproduces RFC 8291’s example exactly', () => {
  const body = encryptPayload(
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    Buffer.from(RFC.plaintext),
    { asPrivate: unb64(RFC.asPrivate), salt: unb64(RFC.salt) },
  );
  assert.equal(body.length, 86 + unb64(RFC.ciphertext).length);
  assert.deepEqual(body.subarray(0, 86), unb64(RFC.header));
  assert.deepEqual(body.subarray(86), unb64(RFC.ciphertext));
});

test('every message gets a fresh key and salt', () => {
  const target = { p256dh: RFC.uaPublic, auth: RFC.auth };
  const a = encryptPayload(target, Buffer.from('hello'));
  const b = encryptPayload(target, Buffer.from('hello'));
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86));
  // The receiver's key pair, as a check that the RFC values are what they say.
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(unb64(RFC.uaPrivate));
  assert.deepEqual(ua.getPublicKey(), unb64(RFC.uaPublic));
});

test('VAPID: an ES256 token for the push service’s origin, verifiable with the public key', () => {
  const keys = loadVapidKeys(join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.json'));
  const now = Date.UTC(2026, 9, 28);
  const header = vapidAuthorization(
    'https://web.push.apple.com/QGuQyavXutnMKw',
    keys,
    'https://randyliang.net/family/',
    now,
  );
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(match, header);
  const [, h, c, s, k] = match as unknown as string[];
  assert.equal(k, keys.publicKey);
  const claims = JSON.parse(unb64(c ?? '').toString()) as Record<string, unknown>;
  assert.deepEqual(claims, {
    aud: 'https://web.push.apple.com',
    exp: now / 1000 + 12 * 3600,
    sub: 'https://randyliang.net/family/',
  });
  const point = unb64(k ?? '');
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${h ?? ''}.${c ?? ''}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      unb64(s ?? ''),
    ),
  );
});

test('the VAPID key is made once, kept owner-only, and reused', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.json');
  const first = loadVapidKeys(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadVapidKeys(path).publicKey, first.publicKey);
});

test('only real push services are ever posted to', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QGuQyavXutnMKw',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ]) {
    assert.ok(isPushEndpoint(ok), ok);
  }
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/',
    'https://localhost:4323/family/',
    'https://fcm.googleapis.com:8443/x',
    'https://user@fcm.googleapis.com/x',
    'https://evil.example/web.push.apple.com',
    'https://web.push.apple.com.evil.example/x',
    'not a url',
  ]) {
    assert.ok(!isPushEndpoint(bad), bad);
  }
  assert.ok(isPushKeys(RFC.uaPublic, RFC.auth));
  assert.ok(!isPushKeys(RFC.auth, RFC.auth));
  assert.ok(!isPushKeys(RFC.uaPublic, RFC.uaPublic));
});

test('sending: the request a push service expects, and what its answers mean', async () => {
  const keys = loadVapidKeys(join(mkdtempSync(join(tmpdir(), 'vapid-')), 'vapid.json'));
  const target = {
    endpoint: 'https://web.push.apple.com/abc',
    p256dh: RFC.uaPublic,
    auth: RFC.auth,
  };
  const seen: { url: string; init: RequestInit }[] = [];
  const reply =
    (status: number): typeof fetch =>
    (url, init) => {
      seen.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        init: init ?? {},
      });
      return Promise.resolve(new Response(null, { status }));
    };
  const options = { keys, subject: 'https://randyliang.net/family/', topic: 'family' };
  assert.equal(
    (await sendPush(target, { a: 1 }, { ...options, fetch: reply(201) })).outcome,
    'sent',
  );
  assert.equal((await sendPush(target, {}, { ...options, fetch: reply(410) })).outcome, 'gone');
  assert.equal((await sendPush(target, {}, { ...options, fetch: reply(404) })).outcome, 'gone');
  assert.equal((await sendPush(target, {}, { ...options, fetch: reply(500) })).outcome, 'failed');
  const failing: typeof fetch = () => Promise.reject(new Error('offline'));
  assert.equal((await sendPush(target, {}, { ...options, fetch: failing })).outcome, 'failed');
  const headers = seen[0]?.init.headers as Record<string, string>;
  assert.equal(seen[0]?.url, target.endpoint);
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers['topic'], 'family');
  assert.match(headers['authorization'] ?? '', /^vapid t=/);
  assert.equal(Number(headers['ttl']), 86400);
});
