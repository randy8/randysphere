import type { ServerResponse } from 'node:http';

/**
 * The open Server-Sent Events streams, one per open chat tab. SSE rather
 * than WebSockets: it is plain HTTP that this server already speaks and
 * Cloudflare already proxies, it needs no dependency, and the browser
 * reconnects by itself, sending the last event id it saw — which is a rev,
 * so the server can replay exactly what was missed (routes.ts).
 */
export interface Connection {
  readonly id: number;
  readonly userId: number;
  readonly openedAt: number;
  readonly country: string;
  readonly userAgent: string;
  /** The session token's hash is not kept; this re-checks the cookie's session on each heartbeat. */
  readonly stillAuthorized: () => boolean;
  lastRev: number;
  /**
   * Until when this tab counts as being looked at. The page renews it
   * while it's visible (POST /family/api/presence) and gives it up when
   * hidden; it lapses on its own, so a phone that went to sleep without
   * saying so is soon notified again.
   */
  visibleUntil: number;
  res: ServerResponse;
}

/** How long one "I'm visible" from a page counts for; the page renews every 25 s. */
export const PRESENCE_MS = 40_000;

/**
 * Cloudflare drops a proxied response that has sent nothing for 100 s; a
 * comment line every 20 s keeps the stream open, and its failure is how a
 * silently dead connection (a phone that went into a tunnel) gets noticed.
 */
export const HEARTBEAT_MS = 20_000;

export interface HubEvent {
  readonly at: number;
  readonly kind: string;
  readonly userId: number | null;
  readonly detail: string;
}

export class Hub {
  readonly #connections = new Map<number, Connection>();
  #nextId = 1;
  readonly #timer: NodeJS.Timeout;
  /** Recent delivery and sign-in events for the admin page; never message content. */
  readonly events: HubEvent[] = [];
  readonly startedAt = Date.now();

  constructor() {
    this.#timer = setInterval(() => {
      this.heartbeat();
    }, HEARTBEAT_MS);
    this.#timer.unref();
  }

  record(kind: string, userId: number | null, detail = ''): void {
    this.events.push({ at: Date.now(), kind, userId, detail });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  open(init: Omit<Connection, 'id' | 'openedAt' | 'visibleUntil'>): Connection {
    const connection: Connection = {
      ...init,
      id: this.#nextId,
      openedAt: Date.now(),
      // Opening the stream is the page being opened: visible, for now.
      visibleUntil: Date.now() + PRESENCE_MS,
    };
    this.#nextId += 1;
    this.#connections.set(connection.id, connection);
    connection.res.on('close', () => {
      this.#connections.delete(connection.id);
    });
    // A write that races the socket closing surfaces as an 'error' event;
    // unheard, that would be an uncaught exception — the whole server.
    connection.res.on('error', () => {
      this.#connections.delete(connection.id);
    });
    return connection;
  }

  connections(): Connection[] {
    return [...this.#connections.values()];
  }

  isOnline(userId: number): boolean {
    return this.connections().some((connection) => connection.userId === userId);
  }

  get(id: number): Connection | undefined {
    return this.#connections.get(id);
  }

  /** Someone with the conversation on screen right now doesn't need a notification for it. */
  isViewing(userId: number, now: number = Date.now()): boolean {
    return this.connections().some(
      (connection) => connection.userId === userId && connection.visibleUntil > now,
    );
  }

  /** Writes one event to one stream; a stream that can't take it is closed. */
  send(connection: Connection, event: string, data: unknown, id?: number): void {
    if (connection.res.writableEnded || connection.res.destroyed) return;
    const lines = `${id === undefined ? '' : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      connection.res.write(lines);
      if (id !== undefined) connection.lastRev = Math.max(connection.lastRev, id);
    } catch {
      this.record('stream-write-failed', connection.userId);
      connection.res.destroy();
    }
  }

  broadcast(event: string, data: unknown, options: { id?: number; except?: number } = {}): void {
    for (const connection of this.connections()) {
      if (connection.userId === options.except) continue;
      this.send(connection, event, data, options.id);
    }
  }

  /** Ends every stream of one user (a revoked or disabled account), telling the page why. */
  disconnectUser(userId: number): void {
    for (const connection of this.connections()) {
      if (connection.userId !== userId) continue;
      this.send(connection, 'signed-out', {});
      this.#end(connection);
    }
  }

  /** Ends a stream and forgets it at once — not on 'close', which comes a tick later. */
  #end(connection: Connection): void {
    this.#connections.delete(connection.id);
    connection.res.end();
  }

  heartbeat(): void {
    for (const connection of this.connections()) {
      if (!connection.stillAuthorized()) {
        this.record('stream-closed-unauthorized', connection.userId);
        this.send(connection, 'signed-out', {});
        this.#end(connection);
        continue;
      }
      if (connection.res.writableEnded) {
        this.#connections.delete(connection.id);
        continue;
      }
      try {
        connection.res.write(': \n\n');
      } catch {
        connection.res.destroy();
      }
    }
  }

  /** For SIGTERM: ends every stream so the server can close; browsers reconnect to the new one. */
  shutdown(): void {
    clearInterval(this.#timer);
    for (const connection of this.connections()) this.#end(connection);
  }
}
