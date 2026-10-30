/**
 * Links in a message: finding them, tidying them for display, and knowing
 * which ones a provider can preview. Pure functions, no network — the
 * fetching is previews.ts.
 *
 * The stored message is never changed: its body keeps every link exactly
 * as it was typed or pasted. What's derived here is what's shown.
 */

/**
 * The same pattern the page's script linkifies with (static/chat.js
 * URL_PATTERN): what the server finds and what the page underlines must be
 * the same links, or a card would have no link to replace.
 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'，。！？；：、（）「」『』【】《》]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** At most this many links in one message are previewed (the rest stay plain links). */
export const MAX_PREVIEWS_PER_MESSAGE = 4;

export interface FoundLink {
  /** Exactly as it appears in the message's text. */
  readonly raw: string;
  /** Where in the text it starts. */
  readonly index: number;
  /** Absolute and without tracking parameters: the href. */
  readonly url: string;
  /** What's shown: `raw` itself unless something was taken out of it. */
  readonly text: string;
}

/** Every http(s) link in `text`, in order. */
export function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const trailing = TRAILING.exec(match[0])?.[0] ?? '';
    const raw = match[0].slice(0, match[0].length - trailing.length);
    const url = cleanUrl(raw);
    if (url !== null) found.push({ raw, index: match.index, url, text: displayText(raw, url) });
  }
  return found;
}

/**
 * Query parameters that only say who shared a link, or from where: never
 * what it points to. `si` is Spotify's and YouTube's share id; `t`/`s` on
 * X are its share tokens.
 */
const TRACKING =
  /^(?:utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|mc_cid|mc_eid|igshid|igsh|_hsenc|_hsmi|ref_src|ref_url|si)$/i;
const TRACKING_BY_HOST: readonly (readonly [RegExp, RegExp])[] = [
  [/(^|\.)(x|twitter)\.com$/i, /^(?:s|t)$/],
];

/**
 * `raw` as an absolute http(s) URL without tracking parameters, or null
 * if it isn't one. Everything else — path, meaningful query, fragment —
 * is kept as it was.
 */
export function cleanUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const spotify = spotifyItem(url);
  if (spotify) return spotify.url;
  const extra = TRACKING_BY_HOST.find(([host]) => host.test(url.hostname))?.[1];
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.test(name) || extra?.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}

/** Longer than this, a link is shown shortened (its href is always whole). */
const SHOWN_CHARS = 40;

/**
 * A link as shown: as it was written if cleaning took nothing out (so
 * "example.com" isn't shown back as "https://example.com/"), else the
 * cleaned address — without the scheme, if it was written without one.
 * A long one is cut short, without its scheme, as iMessage does.
 */
function displayText(raw: string, url: string): string {
  const bare = /^www\./i.test(raw);
  let text = new URL(bare ? `https://${raw}` : raw).href === url ? raw : url;
  if (bare) text = text.replace(/^https:\/\//, '');
  const chars = [...text];
  if (chars.length <= SHOWN_CHARS) return text;
  return `${[...text.replace(/^https?:\/\//, '')].slice(0, SHOWN_CHARS - 1).join('')}…`;
}

// ---- providers ------------------------------------------------------------

/**
 * Something a provider can preview: `url` is its canonical address (the
 * cache key, and where the card goes), `kind` what it is.
 */
export interface Previewable {
  readonly provider: string;
  readonly kind: string;
  readonly url: string;
}

const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist', 'artist', 'episode', 'show']);

/**
 * A Spotify link — open.spotify.com/<kind>/<id>, with or without the
 * intl-xx/ locale and the ?si= share id — as its canonical address.
 */
function spotifyItem(url: URL): Previewable | null {
  if (url.hostname !== 'open.spotify.com' || (url.port !== '' && url.port !== '443')) return null;
  const match = /^\/(?:intl-[a-z]{2}(?:-[a-z]{2,4})?\/)?([a-z]+)\/([A-Za-z0-9]{22})\/?$/i.exec(
    url.pathname,
  );
  const kind = match?.[1]?.toLowerCase() ?? '';
  if (!match || !SPOTIFY_KINDS.has(kind)) return null;
  return { provider: 'spotify', kind, url: `https://open.spotify.com/${kind}/${match[2] ?? ''}` };
}

/**
 * Each provider recognises its own links. Spotify is the first; another
 * (or a generic Open Graph fallback) is one more entry here and a resolver
 * in previews.ts.
 */
const PROVIDERS: readonly ((url: URL) => Previewable | null)[] = [spotifyItem];

/** What a provider could preview for this (already cleaned) URL, or null. */
export function previewable(url: string): Previewable | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const provider of PROVIDERS) {
    const item = provider(parsed);
    if (item) return item;
  }
  return null;
}

/** The distinct previewable links in `text`, in order, at most MAX_PREVIEWS_PER_MESSAGE. */
export function previewableLinks(text: string): Previewable[] {
  const seen = new Set<string>();
  const out: Previewable[] = [];
  for (const link of findLinks(text)) {
    const item = previewable(link.url);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
    if (out.length === MAX_PREVIEWS_PER_MESSAGE) break;
  }
  return out;
}

// ---- metadata hygiene -------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML character references in an attribute's text, decoded (`&amp;` → `&`, `&#x27;` → `'`). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (typeof name === 'string') return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = Number.parseInt(typeof dec === 'string' ? dec : String(hex), dec ? 10 : 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : '';
  });
}

/**
 * Text from another site, made safe to keep and show as text: no control
 * or bidirectional-override characters (which could make a title appear
 * to say something else), whitespace collapsed, at most `max` characters.
 * It is still only ever rendered as text, never as HTML.
 */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  const text = value
    .normalize('NFC')
    // Format characters go, except the zero-width joiner inside emoji.
    .replace(/[\p{Cc}\u2028\u2029]|(?!\u200d)\p{Cf}/gu, (c) => (/\s/.test(c) ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}
