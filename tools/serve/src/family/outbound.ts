import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * The one way the chat fetches anything from another site (link previews,
 * previews.ts). This server sits on the owner's network with services on
 * loopback and the tailnet, and a message's link is chosen by whoever sent
 * it, so every request is fenced:
 *
 * - https only, port 443, no credentials in the URL, never an IP literal;
 * - the host must be one the caller allows (a provider's own hosts);
 * - every address its name resolves to must be public — checked in the
 *   socket's own DNS lookup, so the address checked is the address
 *   connected to (no window for a rebinding answer in between);
 * - redirects are followed by hand, each hop checked again, at most 3;
 * - one deadline for the whole exchange, and a byte limit on the body;
 * - no cookies, no compression (a small reply can't inflate past the limit).
 */

// Two lists: a BlockList checks an IPv4 address against IPv6 rules too
// (as IPv4-mapped), so ::ffff:0:0/96 in one list would match every IPv4
// address.
const NOT_PUBLIC_V4 = new BlockList();
const NOT_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, and Tailscale's addresses
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and cloud metadata services
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NOT_PUBLIC_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible
  ['::ffff:0:0', 96], // IPv4-mapped: would carry any of the above
  ['64:ff9b::', 96], // NAT64, likewise
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local (Tailscale's IPv6 too)
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NOT_PUBLIC_V6.addSubnet(network, prefix, 'ipv6');
}

/** Whether `address` is on the public internet (not loopback, private, link-local, tailnet…). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4
    ? !NOT_PUBLIC_V4.check(address, 'ipv4')
    : !NOT_PUBLIC_V6.check(address, 'ipv6');
}

export class OutboundError extends Error {}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** dns.lookup, refusing a name if any address it resolves to isn't public. */
function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    const list = addresses;
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      callback(new OutboundError(`${hostname} is not a public address`), '');
      return;
    }
    if (options.all === true) callback(null, list);
    else callback(null, list[0]?.address ?? '', list[0]?.family ?? 4);
  });
}

export interface OutboundOptions {
  /** Hosts this request (and each redirect) may go to. */
  readonly allowHost: (hostname: string) => boolean;
  readonly accept: string;
  readonly maxBytes: number;
  /** For the whole exchange, redirects included. */
  readonly timeoutMs?: number;
  /** Stop reading once this appears (an HTML page's `</head>`: the metadata is above it). */
  readonly stopAt?: string;
}

export interface OutboundResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  /** Where it was finally answered from, after redirects. */
  readonly url: string;
}

/** A fetch that only fetches `url` (or anything a test stands in for). */
export type Fetcher = (url: string, options: OutboundOptions) => Promise<OutboundResponse>;

const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible; randyliang.net link preview)';

/** Checks one hop's URL before anything is sent to it. */
function checkTarget(url: URL, options: OutboundOptions): void {
  if (url.protocol !== 'https:') throw new OutboundError('only https');
  if (url.port !== '' && url.port !== '443') throw new OutboundError('only port 443');
  if (url.username !== '' || url.password !== '') throw new OutboundError('no credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // An address literal skips the lookup, and so the address check: refused outright.
  if (isIP(host) !== 0) throw new OutboundError('no address literals');
  if (!options.allowHost(host.toLowerCase())) throw new OutboundError(`${host} isn't allowed`);
}

/** One GET, without following redirects. */
function getOnce(
  url: URL,
  options: OutboundOptions,
  signal: AbortSignal,
): Promise<{ response: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        lookup: publicLookup,
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: options.accept,
          'accept-encoding': 'identity',
          'accept-language': 'en',
        },
      },
      (response) => {
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > options.maxBytes) {
          response.destroy();
          reject(new OutboundError('too large'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        let tail = Buffer.alloc(0);
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve({ response, body: Buffer.concat(chunks) });
        };
        response.on('data', (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            // A page read only for its <head>: what arrived is enough to look in.
            if (options.stopAt !== undefined) finish();
            else {
              done = true;
              reject(new OutboundError('too large'));
            }
            return;
          }
          chunks.push(chunk);
          if (options.stopAt !== undefined) {
            // With the previous chunk's end, in case the marker straddles two.
            const window = Buffer.concat([tail, chunk]);
            if (window.includes(options.stopAt)) {
              finish();
              response.destroy();
              return;
            }
            tail = window.subarray(Math.max(0, window.length - options.stopAt.length));
          }
        });
        response.on('end', finish);
        response.on('error', (error) => {
          if (!done) reject(error);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** GET `url` within the fences above. Non-2xx statuses are returned, not thrown. */
export const fetchOutbound: Fetcher = async (target, options) => {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 5000);
  let url = new URL(target);
  for (let hop = 0; ; hop += 1) {
    checkTarget(url, options);
    const { response, body } = await getOnce(url, options, signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && typeof location === 'string') {
      if (hop >= MAX_REDIRECTS) throw new OutboundError('too many redirects');
      url = new URL(location, url);
      continue;
    }
    return {
      status,
      contentType: String(response.headers['content-type'] ?? ''),
      body,
      url: url.href,
    };
  }
};
