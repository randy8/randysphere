import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchOutbound, isPublicAddress, OutboundError } from './outbound.ts';

test('only public addresses count as public', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.101.102.103', // Tailscale
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    'fd7a:115c:a1e0::1', // Tailscale's IPv6
    'fe80::1',
    '64:ff9b::7f00:1',
    'not an address',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const address of ['35.186.224.25', '151.101.1.1', '2600:1901:0:1::1']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

const anyHost = { allowHost: () => true, accept: '*/*', maxBytes: 1024, timeoutMs: 2000 };

test('outbound requests are refused before anything is sent, unless https to an allowed name', async () => {
  for (const [url, options] of [
    ['http://open.spotify.com/', anyHost],
    ['https://open.spotify.com:8443/', anyHost],
    ['https://user:pw@open.spotify.com/', anyHost],
    ['https://127.0.0.1/', anyHost],
    ['https://[::1]/', anyHost],
    ['https://example.com/', { ...anyHost, allowHost: (h: string) => h === 'open.spotify.com' }],
  ] as const) {
    await assert.rejects(fetchOutbound(url, options), OutboundError, url);
  }
});

test('a name that resolves to this machine is refused at connection time', async () => {
  // Allowed by name, refused by address: the check is in the socket's own lookup.
  await assert.rejects(fetchOutbound('https://localhost/', anyHost), /not a public address/);
});
