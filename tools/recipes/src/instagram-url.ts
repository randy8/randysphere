/**
 * The only Instagram URLs the importer accepts, and the one canonical form
 * each is stored and compared in. A Reel is identified by its shortcode, the
 * path segment after /reel/ — the same video is linked as /reel/, /reels/,
 * /p/ or /tv/, with or without www., m., the owner's username in front, or a
 * share-tracking query (?igsh=…), and every one of those must count as the
 * same Reel for duplicate detection.
 */

const HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const KINDS = new Set(['reel', 'reels', 'p', 'tv']);
/** Instagram shortcodes are URL-safe base64; real ones are 11 characters, longer for private-share links. */
const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;

export interface ReelReference {
  readonly shortcode: string;
  /** Always `https://www.instagram.com/reel/<shortcode>/`. */
  readonly url: string;
}

export class InvalidReelUrl extends Error {}

/**
 * Parses a pasted link into its Reel reference, or throws `InvalidReelUrl`
 * with a sentence to show the person. Accepts surrounding whitespace and a
 * missing scheme, because that's what copying from an app's share sheet or
 * an address bar produces; rejects everything that isn't an Instagram
 * post/Reel path on an Instagram host (no profiles, stories or lookalikes).
 */
export function parseReelUrl(input: string): ReelReference {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidReelUrl('Paste a link to an Instagram Reel.');
  if (trimmed.length > 2048) throw new InvalidReelUrl('That link is too long to be a Reel link.');

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new InvalidReelUrl('That doesn’t look like a link.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new InvalidReelUrl('Only web links (https://…) are accepted.');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
    throw new InvalidReelUrl('That isn’t an Instagram link.');
  }
  if (!HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new InvalidReelUrl('That isn’t an Instagram link — it should start with instagram.com.');
  }

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  // /reel/<code>/ or /<username>/reel/<code>/ (the form Instagram now shares).
  const at = segments.findIndex((segment) => KINDS.has(segment.toLowerCase()));
  const shortcode = at === -1 ? undefined : segments[at + 1];
  if (at > 1 || shortcode === undefined || !SHORTCODE.test(shortcode)) {
    throw new InvalidReelUrl(
      'That Instagram link isn’t a Reel or post. Use “Copy link” on the Reel itself.',
    );
  }

  return { shortcode, url: `https://www.instagram.com/reel/${shortcode}/` };
}

/** The shortcode of an already-stored source URL, or null if it isn't one this importer would accept. */
export function shortcodeOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return parseReelUrl(url).shortcode;
  } catch {
    return null;
  }
}
