/**
 * /infra — a read-only directory of the services on this machine, for its
 * owner's own devices on the tailnet and nobody else. Everyone else,
 * whatever they send, gets the site's ordinary 404.
 *
 * Who gets in is decided by Tailscale, not by this file: a request passes
 * only if
 *   1. its connection arrived on this machine's own Tailscale address
 *      (the socket's local address — the Cloudflare tunnel and Tailscale
 *      serve both connect from loopback, so they never qualify);
 *   2. it came from a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48)
 *      — unspoofable over TCP, since replies to those addresses route back
 *      over Tailscale and a forged handshake never completes;
 *   3. tailscaled's own `whois` names that address as a node of this
 *      tailnet, owned by the same user as this machine — or carrying the
 *      capability `randyliang.net/cap/infra` from the tailnet policy, so
 *      the policy file, not this code, is how anyone else is let in.
 * Anything failing, including tailscaled not answering, is a 404.
 *
 * The list itself is infra/services.yaml (git-ignored). The page shows
 * names, what each is for, a link, and whether its port answered a plain
 * TCP connection just now. It never administers anything.
 */

import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { connect } from 'node:net';

import { parse } from 'yaml';

export const INFRA_CAPABILITY = 'randyliang.net/cap/infra';
const TAILSCALED_SOCKET = '/var/run/tailscale/tailscaled.sock';

/** Strips IPv4-mapped IPv6 ("::ffff:100.1.2.3" → "100.1.2.3"). */
function plain(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

/** Tailscale's address ranges: CGNAT 100.64.0.0/10 and its IPv6 ULA prefix. */
export function isTailnetAddress(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const address = plain(raw).toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 100 && b >= 64 && b <= 127;
  }
  return /^fd7a:115c:a1e0:/.test(address);
}

export interface Whois {
  readonly login: string;
  readonly capabilities: readonly string[];
}

/** Asks tailscaled who an address belongs to; null if it doesn't know, or can't be asked. */
export type WhoisLookup = (address: string) => Promise<Whois | null>;

export function tailscaledWhois(socketPath = TAILSCALED_SOCKET): WhoisLookup {
  const cache = new Map<string, { at: number; value: Whois | null }>();
  return (address) => {
    const hit = cache.get(address);
    if (hit !== undefined && Date.now() - hit.at < 60_000) return Promise.resolve(hit.value);
    return new Promise((resolve) => {
      const done = (value: Whois | null): void => {
        cache.set(address, { at: Date.now(), value });
        resolve(value);
      };
      const host = address.includes(':') ? `[${address}]` : address;
      const req = request(
        {
          socketPath,
          path: `/localapi/v0/whois?addr=${encodeURIComponent(`${host}:1`)}`,
          headers: { host: 'local-tailscaled.sock' },
          timeout: 1000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('end', () => {
            if (res.statusCode !== 200) return done(null);
            try {
              const data = JSON.parse(body) as {
                UserProfile?: { LoginName?: string };
                CapMap?: Record<string, unknown> | null;
              };
              const login = data.UserProfile?.LoginName ?? '';
              done(login === '' ? null : { login, capabilities: Object.keys(data.CapMap ?? {}) });
            } catch {
              done(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  };
}

/**
 * Whether this request may see /infra: arrived on this machine's tailnet
 * address, from a tailnet address that tailscaled says is the owner's own
 * device (or one granted the capability). Never reads a header.
 */
export async function mayViewInfra(req: IncomingMessage, whois: WhoisLookup): Promise<boolean> {
  const local = req.socket.localAddress;
  const remote = req.socket.remoteAddress;
  if (!isTailnetAddress(local) || !isTailnetAddress(remote)) return false;
  const [self, peer] = await Promise.all([whois(plain(local ?? '')), whois(plain(remote ?? ''))]);
  if (self === null || peer === null) return false;
  return peer.login === self.login || peer.capabilities.includes(INFRA_CAPABILITY);
}

export interface Service {
  readonly name: string;
  readonly url: string;
  readonly about: string;
}

export interface Group {
  readonly group: string;
  readonly services: readonly Service[];
}

/** infra/services.yaml, checked; an empty list if it's missing or malformed (the page says so). */
export async function loadServices(path: string): Promise<Group[] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const raw = parse(text) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw.map((entry) => {
      const group = entry as { group?: unknown; services?: unknown };
      const services = Array.isArray(group.services) ? group.services : [];
      return {
        group: typeof group.group === 'string' ? group.group : 'Services',
        services: services
          .map((value) => value as { name?: unknown; url?: unknown; about?: unknown })
          .filter(
            (s) =>
              typeof s.name === 'string' && typeof s.url === 'string' && /^https?:\/\//.test(s.url),
          )
          .map((s) => ({
            name: String(s.name),
            url: String(s.url),
            about: typeof s.about === 'string' ? s.about : '',
          })),
      };
    });
  } catch {
    return null;
  }
}

export type Availability = 'up' | 'down';

/**
 * Whether a service's port accepts a TCP connection right now, tried at
 * `address` (this machine's own Tailscale address — the path a tailnet
 * device takes) on the port its URL names. A connection only; nothing is
 * sent.
 */
export function probe(address: string, url: string, timeoutMs = 700): Promise<Availability> {
  let port: number;
  try {
    const parsed = new URL(url);
    port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  } catch {
    return Promise.resolve('down');
  }
  return new Promise((resolve) => {
    const socket = connect({ host: address, port, timeout: timeoutMs });
    const finish = (state: Availability): void => {
      socket.destroy();
      resolve(state);
    };
    socket.once('connect', () => finish('up'));
    socket.once('timeout', () => finish('down'));
    socket.once('error', () => finish('down'));
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** The page. Pure: groups and their availability in, HTML out. */
export function renderInfra(
  groups: readonly Group[] | null,
  availability: ReadonlyMap<string, Availability>,
  checkedAt: Date,
): string {
  const time = checkedAt.toISOString().slice(11, 16);
  const body =
    groups === null || groups.every((g) => g.services.length === 0)
      ? '<p class="empty">No services listed. Add them to infra/services.yaml.</p>'
      : groups
          .filter((group) => group.services.length > 0)
          .map(
            (group) => `
  <section>
    <h2>${escape(group.group)}</h2>
    <ul>
${group.services
  .map((service) => {
    const state = availability.get(service.url) ?? 'down';
    return `      <li>
        <a href="${escape(service.url)}">
          <span class="name">${escape(service.name)}</span>
          <span class="state ${state}" title="${state === 'up' ? 'Answering' : 'Not answering'}"><span class="visually-hidden">${state === 'up' ? 'answering' : 'not answering'}</span></span>
          <span class="about">${escape(service.about)}</span>
          <span class="where">${escape(new URL(service.url).host)}</span>
        </a>
      </li>`;
  })
  .join('\n')}
    </ul>
  </section>`,
          )
          .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Infra — avadoplex</title>
<style>
  @font-face { font-family: 'Newsreader'; src: url('/fonts/newsreader-variable.woff2') format('woff2'); font-weight: 200 800; font-display: swap; }
  :root { --paper: #f6f1e6; --ink: #16130f; --muted: #6f675a; --rule: #ddd3c0; --accent: #7a2420; --up: #4f6b3a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 400 1.0625rem/1.55 'Newsreader', 'Iowan Old Style', Georgia, serif; }
  main { max-width: 52rem; margin: 0 auto; padding: 2.5rem max(1.5rem, env(safe-area-inset-left)) 4rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; border-bottom: 2px solid var(--ink); padding-bottom: 0.75rem; margin-bottom: 2.5rem; }
  h1 { margin: 0; font-size: 2.25rem; font-weight: 340; letter-spacing: -0.02em; }
  .label, h2, .where { font-size: 0.6875rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  h2 { margin: 0 0 0.5rem; font-weight: 500; }
  section { margin-bottom: 2.25rem; }
  ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
  li a { display: grid; grid-template-columns: minmax(8rem, 12rem) 1rem 1fr auto; align-items: baseline; gap: 0 1rem; padding: 0.8rem 0; border-bottom: 1px solid var(--rule); color: inherit; text-decoration: none; }
  li a:hover .name, li a:focus-visible .name { color: var(--accent); }
  li a:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .name { font-size: 1.1875rem; transition: color 0.2s ease; }
  .about { color: var(--muted); font-style: italic; }
  .where { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .state { width: 0.5rem; height: 0.5rem; border-radius: 50%; align-self: center; }
  .state.up { background: var(--up); }
  .state.down { background: transparent; border: 1px solid var(--accent); }
  .empty { font-style: italic; color: var(--muted); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  @media (max-width: 34rem) {
    li a { grid-template-columns: 1fr auto; row-gap: 0.15rem; }
    .state { grid-column: 2; grid-row: 1; }
    .about { grid-column: 1 / -1; }
    .where { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>avadoplex</h1>
    <p class="label">On the tailnet · checked ${time} UTC</p>
  </header>
${body}
</main>
</body>
</html>`;
}
