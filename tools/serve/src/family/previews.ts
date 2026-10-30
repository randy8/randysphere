import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanText, decodeEntities, previewable } from './links.ts';
import type { Previewable } from './links.ts';
import { fetchOutbound } from './outbound.ts';
import type { Fetcher } from './outbound.ts';
import { sniffImage } from './sniff.ts';
import type { FamilyStore, LinkPreview, Message, PreviewResult } from './store.ts';

/**
 * Link previews, fetched by the server — never by the page, which loads
 * nothing from another origin (the CSP, and a mother in mainland China
 * where Spotify's hosts are blocked). Each link is fetched once and kept
 * (`link_previews`); its artwork is copied into `previews/`. Nothing here
 * is on the path of sending: a message is stored and delivered first, and
 * its card arrives later as an 'update' (store.ts savePreview).
 */

/** A link whose preview couldn't be had is tried again after this long. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** …or after this, if someone sends it again (it may have been a passing failure). */
const RETRY_ON_SEND_MS = 10 * 60 * 1000;
const CONCURRENCY = 2;
/** Beyond this many waiting, the rest wait for the hourly sweep. */
const MAX_QUEUE = 200;

export interface PreviewerOptions {
  readonly store: FamilyStore;
  /** private/<chat>/previews: the artwork. */
  readonly dir: string;
  /** Tests only: stands in for the internet. */
  readonly fetch?: Fetcher;
  /** Messages that now have a card: broadcast as updates. */
  readonly onPreview: (messages: Message[]) => void;
  /** Diagnostics (the Members page): never the link itself, which is message content. */
  readonly record: (kind: string, detail: string) => void;
}

/** What a provider's resolver found: the card's words, and artwork to copy. */
interface Resolved {
  readonly title: string;
  readonly subtitle: string;
  readonly artwork: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  } | null;
  /** Hosts the artwork may come from. */
  readonly artworkHosts: (host: string) => boolean;
}

/** A link the provider says isn't there (or isn't public): not tried again soon. */
class NotFound extends Error {}

export class Previewer {
  readonly #options: PreviewerOptions;
  readonly #fetch: Fetcher;
  readonly #queue: Previewable[] = [];
  readonly #queued = new Set<string>();
  #running = 0;
  #idle: (() => void)[] = [];

  constructor(options: PreviewerOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetchOutbound;
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    // Artwork written but never recorded (the server stopped in between).
    const known = options.store.previewImageIds();
    for (const name of readdirSync(options.dir)) {
      if (!known.has(name)) rmSync(join(options.dir, name), { force: true });
    }
  }

  /** A message just sent or edited: its links' previews, unless already had. */
  wantFor(message: Message): void {
    for (const link of message.links) {
      if (link.preview) continue;
      const item = previewable(link.url);
      if (item) this.#want(item, RETRY_ON_SEND_MS);
    }
  }

  /**
   * Looks through messages not yet indexed (those from before previews,
   * or from a deploy's overlap), then queues every link still without a
   * preview. At startup, and hourly.
   */
  sweep(now: number = Date.now()): void {
    while (this.#options.store.indexLinks() > 0) {
      // Batches of 500, each its own short transaction.
    }
    for (const url of this.#options.store.previewsWanted(now - RETRY_AFTER_MS)) {
      const item = previewable(url);
      if (item) this.#want(item, RETRY_AFTER_MS);
    }
  }

  /** Resolves once nothing is queued or being fetched (tests, and shutdown). */
  idle(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  #want(item: Previewable, retryAfterMs: number): void {
    if (this.#queued.has(item.url) || this.#queue.length >= MAX_QUEUE) return;
    const stored = this.#options.store.previewStatus(item.url);
    if (stored?.status === 'ok') return;
    if (stored && Date.now() - stored.fetchedAt < retryAfterMs) return;
    this.#queued.add(item.url);
    this.#queue.push(item);
    this.#pump();
  }

  #pump(): void {
    while (this.#running < CONCURRENCY && this.#queue.length > 0) {
      const item = this.#queue.shift();
      if (!item) break;
      this.#running += 1;
      void this.#resolve(item).finally(() => {
        this.#running -= 1;
        this.#queued.delete(item.url);
        this.#pump();
        if (this.#running === 0 && this.#queue.length === 0) {
          for (const resolve of this.#idle.splice(0)) resolve();
        }
      });
    }
  }

  async #resolve(item: Previewable): Promise<void> {
    const { store, dir, onPreview, record } = this.#options;
    let result: PreviewResult;
    try {
      const found = await RESOLVERS[item.provider]?.(item, this.#fetch);
      if (!found) throw new Error('no resolver');
      const image = found.artwork ? await this.#copyArtwork(found) : null;
      const preview: LinkPreview = {
        url: item.url,
        provider: item.provider,
        kind: item.kind,
        title: found.title,
        subtitle: found.subtitle,
        image,
      };
      result = { status: 'ok', preview };
    } catch (error) {
      record(
        'link-preview-failed',
        `${item.provider} ${item.kind}: ${error instanceof NotFound ? 'not found' : error instanceof Error ? error.message : 'error'}`,
      );
      result = { status: 'failed', url: item.url, provider: item.provider, kind: item.kind };
    }
    try {
      const { messages, replacedImage } = store.savePreview(result);
      if (replacedImage) await rm(join(dir, replacedImage), { force: true });
      if (messages.length > 0) onPreview(messages);
    } catch (error) {
      // The database is closing (shutdown): the next start tries again.
      if (result.status === 'ok' && result.preview.image) {
        await rm(join(dir, result.preview.image.id), { force: true });
      }
      console.error('link preview:', error instanceof Error ? error.message : 'error');
    }
  }

  /** The artwork, copied here (checked to be an image by its bytes); null if it can't be had. */
  async #copyArtwork(found: Resolved): Promise<LinkPreview['image']> {
    if (!found.artwork) return null;
    try {
      const response = await this.#fetch(found.artwork.url, {
        allowHost: found.artworkHosts,
        accept: 'image/jpeg, image/png, image/webp',
        maxBytes: 1024 * 1024,
      });
      if (response.status !== 200 || !sniffImage(response.body)) return null;
      const id = randomBytes(16).toString('hex');
      await writeFile(join(this.#options.dir, id), response.body, { mode: 0o600 });
      return { id, width: found.artwork.width, height: found.artwork.height };
    } catch {
      // A card without artwork is still a card.
      return null;
    }
  }
}

// ---- providers ------------------------------------------------------------

type Resolver = (item: Previewable, fetch: Fetcher) => Promise<Resolved>;

/** `<meta property|name="…" content="…">` in a page's head, by name (first wins). */
export function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string): string | undefined =>
      new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
        .exec(tag[0])
        ?.slice(1)
        .find((v) => v !== undefined);
    const key = (attr('property') ?? attr('name'))?.toLowerCase();
    const content = attr('content');
    if (key && content !== undefined && !tags.has(key)) tags.set(key, decodeEntities(content));
  }
  return tags;
}

const SPOTIFY_HOST = (host: string): boolean => host === 'open.spotify.com';
const SPOTIFY_IMAGE_HOSTS = (host: string): boolean =>
  /(^|\.)scdn\.co$/.test(host) || /(^|\.)spotifycdn\.com$/.test(host);

/**
 * Who a Spotify item is by, from its page's og:description — which reads
 * "Rick Astley · Whenever You Need Somebody · Song · 1987" for a track,
 * "Rick Astley · album · 1987 · 10 songs" for an album, "Podcast · Lex
 * Fridman · …" for a show. Kinds without a reliable byline get none.
 */
export function spotifyByline(kind: string, description: string): string {
  const parts = description.split(' · ').map((part) => part.trim());
  if (kind === 'track' || kind === 'album') return parts[0] ?? '';
  if (
    (kind === 'show' && parts[0] === 'Podcast') ||
    (kind === 'playlist' && parts[0] === 'Playlist')
  )
    return parts[1] ?? '';
  return '';
}

/**
 * Spotify: its oEmbed endpoint (public, no sign-in) for the title and
 * artwork, and the item's own page's Open Graph tags for who it's by —
 * oEmbed doesn't say. The page is optional: without it the card has no
 * byline. For a show (a podcast) oEmbed describes its latest episode, so
 * the page's own title and image are used instead.
 */
const spotify: Resolver = async (item, fetch) => {
  const oembed = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(item.url)}`,
    { allowHost: SPOTIFY_HOST, accept: 'application/json', maxBytes: 64 * 1024 },
  );
  if (oembed.status === 400 || oembed.status === 404) throw new NotFound();
  if (oembed.status !== 200) throw new Error(`oEmbed ${String(oembed.status)}`);
  const data = JSON.parse(oembed.body.toString('utf8')) as Record<string, unknown>;
  let title = cleanText(data['title']);
  if (title === '') throw new NotFound();

  let subtitle = '';
  let showImage: { url: string; width: number; height: number } | undefined;
  try {
    const page = await fetch(item.url, {
      allowHost: SPOTIFY_HOST,
      accept: 'text/html',
      maxBytes: 256 * 1024,
      stopAt: '</head>',
    });
    if (page.status === 200) {
      const meta = metaTags(page.body.toString('utf8'));
      subtitle = cleanText(spotifyByline(item.kind, meta.get('og:description') ?? ''), 120);
      if (item.kind === 'show') {
        title = cleanText(meta.get('og:title')) || title;
        const image = meta.get('og:image');
        if (image) {
          showImage = {
            url: image,
            width: Number(meta.get('og:image:width') ?? 640),
            height: Number(meta.get('og:image:height') ?? 640),
          };
        }
      }
    }
  } catch {
    // No byline, then.
  }

  const thumbnail = showImage?.url ?? data['thumbnail_url'];
  const size = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 1), 2000) : 300;
  return {
    title,
    subtitle,
    artwork:
      typeof thumbnail === 'string' && thumbnail.startsWith('https://')
        ? {
            url: thumbnail,
            width: size(showImage?.width ?? data['thumbnail_width']),
            height: size(showImage?.height ?? data['thumbnail_height']),
          }
        : null,
    artworkHosts: SPOTIFY_IMAGE_HOSTS,
  };
};

/** One resolver per provider in links.ts. */
const RESOLVERS: Readonly<Record<string, Resolver>> = { spotify };
