import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  INFRA_CAPABILITY,
  isTailnetAddress,
  loadServices,
  mayViewInfra,
  renderInfra,
} from './infra.ts';
import type { WhoisLookup } from './infra.ts';

const request = (
  local: string,
  remote: string,
  headers: Record<string, string> = {},
): IncomingMessage =>
  ({
    socket: { localAddress: local, remoteAddress: remote },
    headers,
  }) as unknown as IncomingMessage;

const SELF = '100.82.206.6';
const whois: WhoisLookup = (address) =>
  Promise.resolve(
    {
      [SELF]: { login: 'owner@example.com', capabilities: [] },
      '100.70.1.2': { login: 'owner@example.com', capabilities: [] },
      '100.70.9.9': { login: 'friend@example.com', capabilities: [] },
      '100.70.8.8': { login: 'guest@example.com', capabilities: [INFRA_CAPABILITY] },
      'fd7a:115c:a1e0::1': { login: 'owner@example.com', capabilities: [] },
    }[address] ?? null,
  );

test('tailnet addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48, mapped IPv4 included', () => {
  for (const yes of [
    '100.64.0.1',
    '100.127.255.255',
    '100.82.206.6',
    '::ffff:100.82.206.6',
    'fd7a:115c:a1e0::8901:ce06',
  ]) {
    assert.equal(isTailnetAddress(yes), true, yes);
  }
  for (const no of [
    '127.0.0.1',
    '::1',
    '192.168.1.236',
    '100.63.255.255',
    '100.128.0.1',
    '10.0.0.1',
    'fd7a:115c:a1e1::1',
    undefined,
  ]) {
    assert.equal(isTailnetAddress(no), false, String(no));
  }
});

test('the owner’s own device on the tailnet may view it', async () => {
  assert.equal(await mayViewInfra(request(SELF, '100.70.1.2'), whois), true);
  assert.equal(await mayViewInfra(request(`::ffff:${SELF}`, '::ffff:100.70.1.2'), whois), true);
});

test('a device granted the capability in the tailnet policy may view it; another user’s may not', async () => {
  assert.equal(await mayViewInfra(request(SELF, '100.70.8.8'), whois), true);
  assert.equal(await mayViewInfra(request(SELF, '100.70.9.9'), whois), false);
});

test('the public site, the LAN, loopback and Tailscale serve are all refused, whatever the headers say', async () => {
  const forged = {
    'cf-connecting-ip': '100.70.1.2',
    'x-forwarded-for': '100.70.1.2',
    'tailscale-user-login': 'owner@example.com',
  };
  // The Cloudflare tunnel and Tailscale serve connect from loopback.
  assert.equal(await mayViewInfra(request('127.0.0.1', '127.0.0.1', forged), whois), false);
  assert.equal(await mayViewInfra(request('::1', '::1', forged), whois), false);
  // A LAN client reaching the machine's LAN address.
  assert.equal(await mayViewInfra(request('192.168.1.236', '192.168.1.50', forged), whois), false);
  // A LAN client that routed to the tailnet address without being on the tailnet.
  assert.equal(await mayViewInfra(request(SELF, '192.168.1.50', forged), whois), false);
});

test('an address tailscaled doesn’t know, or tailscaled not answering, is refused', async () => {
  assert.equal(await mayViewInfra(request(SELF, '100.99.99.99'), whois), false);
  assert.equal(await mayViewInfra(request(SELF, '100.70.1.2'), () => Promise.resolve(null)), false);
});

test('services: missing or malformed file is null; bad entries are dropped, never a crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'infra-'));
  assert.equal(await loadServices(join(dir, 'missing.yaml')), null);
  await writeFile(join(dir, 'bad.yaml'), ': : :\n  - [');
  assert.equal(await loadServices(join(dir, 'bad.yaml')), null);
  await writeFile(
    join(dir, 'ok.yaml'),
    '- group: Media\n  services:\n    - { name: Plex, url: "http://avadoplex:32400/web", about: Library }\n    - { name: NoUrl }\n    - { name: Js, url: "javascript:alert(1)" }\n',
  );
  const groups = await loadServices(join(dir, 'ok.yaml'));
  assert.deepEqual(
    groups?.[0]?.services.map((s) => s.name),
    ['Plex'],
  );
});

test('the page escapes what it shows and marks availability in words too', () => {
  const html = renderInfra(
    [
      {
        group: 'Media <x>',
        services: [{ name: 'Plex', url: 'http://avadoplex:32400/web', about: 'A "library"' }],
      },
    ],
    new Map([['http://avadoplex:32400/web', 'up']]),
    new Date('2026-10-26T18:00:00Z'),
  );
  assert.match(html, /Media &#60;x&#62;/);
  assert.match(html, /A &#34;library&#34;/);
  assert.match(html, /answering/);
  assert.match(html, /noindex/);
  assert.equal(renderInfra(null, new Map(), new Date()).includes('No services listed'), true);
});
