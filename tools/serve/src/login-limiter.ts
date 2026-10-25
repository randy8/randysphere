import type { IncomingMessage } from 'node:http';

/**
 * Failed /private logins, counted per client. Five wrong passwords inside
 * fifteen minutes and that client is turned away — right password or not,
 * or the lock would only cost a guesser one request — until the oldest of
 * those failures ages out. A correct password clears its client's count.
 * Nobody else is affected: there is no global lock for an attacker to
 * trigger against the owner. In memory, per process: a restart forgets
 * everything, which only ever errs on the side of letting the owner in.
 */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
/** A bound on memory, not a limit anyone should reach: oldest clients are dropped first. */
const MAX_TRACKED_CLIENTS = 10_000;

export class LoginLimiter {
  readonly #failures = new Map<string, number[]>();

  /** Milliseconds until `client` may try again; 0 if it may now. */
  retryAfterMs(client: string, now: number = Date.now()): number {
    const recent = this.#recent(client, now);
    if (recent.length < MAX_FAILURES) return 0;
    const oldest = recent[recent.length - MAX_FAILURES] ?? now;
    return oldest + WINDOW_MS - now;
  }

  recordFailure(client: string, now: number = Date.now()): void {
    const recent = this.#recent(client, now);
    recent.push(now);
    // Re-inserting moves the client to the end, so the first key is always
    // the one that failed longest ago.
    this.#failures.delete(client);
    this.#failures.set(client, recent);
    if (this.#failures.size > MAX_TRACKED_CLIENTS) {
      const [stalest] = this.#failures.keys();
      if (stalest !== undefined) this.#failures.delete(stalest);
    }
  }

  recordSuccess(client: string): void {
    this.#failures.delete(client);
  }

  #recent(client: string, now: number): number[] {
    const recent = (this.#failures.get(client) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length === 0) this.#failures.delete(client);
    else this.#failures.set(client, recent);
    return recent;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Who is asking. Every request through the Cloudflare Tunnel arrives from
 * cloudflared on this machine — a loopback address — with the visitor's
 * own address in `CF-Connecting-IP`; counting by the socket alone would put
 * every visitor in one bucket and let a single guesser lock out the owner.
 * But this server also listens on the LAN and tailnet, where anyone can
 * send that header, so it is believed only on a loopback connection.
 */
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const forwarded = req.headers['cf-connecting-ip'];
  if (
    LOOPBACK.has(peer) &&
    typeof forwarded === 'string' &&
    forwarded.length > 0 &&
    forwarded.length <= 64
  ) {
    return forwarded;
  }
  return peer;
}
