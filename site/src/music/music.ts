import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

/**
 * Not a playlist library — a collection of songs I keep coming back to,
 * one hand-written entry each, read straight from a single committed
 * `music/tracks.yaml` the same way `films/ratings.csv` is: no pipeline, no
 * images, no per-item file. `postedAt` is when the entry was added; it
 * orders the page (newest first, later in the file first on the same day)
 * but is never shown — being here is the
 * whole endorsement, not a moment in a listening log.
 */
export type Platform = 'spotify' | 'youtube';

export interface Track {
  readonly url: string;
  readonly postedAt: string;
  readonly title: string;
  readonly artist: string;
  readonly platform: Platform;
  readonly embedUrl: string;
  /** The YouTube video id, or null for a Spotify entry (which has no thumbnail to show). */
  readonly videoId: string | null;
}

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `Could not find the repository root above ${process.cwd()} (looking for pnpm-workspace.yaml). ` +
      'Run the site from inside the repository.',
  );
}

const ROOT = repositoryRoot();
const TRACKS_FILE = join(ROOT, 'music', 'tracks.yaml');

interface TrackFile {
  readonly url?: string;
  readonly postedAt?: string;
  readonly title?: string;
  readonly artist?: string;
}

/** The video id in any ordinary YouTube link (watch, youtu.be, shorts, music.youtube.com), or null. */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const shorts = /^\/shorts\/([^/]+)/.exec(parsed.pathname);
    return parsed.searchParams.get('v') ?? shorts?.[1] ?? null;
  }
  if (host === 'youtu.be') return parsed.pathname.slice(1) || null;
  return null;
}

/**
 * The largest still YouTube publishes for a video: 1280×720, 16:9, no
 * letterbox bars. Not every upload has one — tunes.ts steps down through
 * the smaller sizes in the browser when it turns out to be missing.
 */
export function youtubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
}

/**
 * Rewrites an ordinary YouTube/Spotify share link into that platform's own
 * embeddable URL. No API call, no scraping: both platforms' embed paths are
 * a deterministic rewrite of the link a person would actually paste.
 * Returns `null` for anything that isn't a recognized track/video link, so
 * a bad paste in `tracks.yaml` just drops that entry instead of building a
 * broken page.
 */
export function toEmbed(url: string): { platform: Platform; embedUrl: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname.replace(/^www\./, '') === 'open.spotify.com') {
    const match = /^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/.exec(parsed.pathname);
    if (!match) return null;
    return {
      platform: 'spotify',
      embedUrl: `https://open.spotify.com/embed/${match[1]}/${match[2]}`,
    };
  }

  const videoId = youtubeVideoId(url);
  if (videoId !== null) {
    return { platform: 'youtube', embedUrl: `https://www.youtube.com/embed/${videoId}` };
  }
  return null;
}

/**
 * Every track, newest `postedAt` first. Empty if the file hasn't been added
 * yet or has no valid links. A link with no `title` stops the build — the
 * page has nothing else to call it by.
 */
export function loadTracks(): Track[] {
  if (!existsSync(TRACKS_FILE)) return [];
  const data = (parse(readFileSync(TRACKS_FILE, 'utf8')) ?? []) as TrackFile[];
  return (
    data
      .map((entry): Track | null => {
        if (!entry.url) return null;
        const embed = toEmbed(entry.url);
        if (!embed) return null;
        if (!entry.title?.trim()) {
          throw new Error(`music/tracks.yaml: ${entry.url} has no \`title\`.`);
        }
        return {
          url: entry.url,
          postedAt: entry.postedAt ?? '',
          title: entry.title.trim(),
          artist: entry.artist?.trim() ?? '',
          platform: embed.platform,
          embedUrl: embed.embedUrl,
          videoId: embed.platform === 'youtube' ? youtubeVideoId(entry.url) : null,
        };
      })
      .filter((track): track is Track => track !== null)
      // Same-day entries: the one further down the file was added later, so
      // it goes first. Array.prototype.reverse before a stable sort does that.
      .reverse()
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
  );
}
