import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

/**
 * Not a playlist library — a running log of whatever I'm genuinely into
 * right now, one hand-written entry per "wow I'm really into this," read
 * straight from a single committed `music/tracks.yaml` the same way
 * `films/five-star-ratings.csv` is: no pipeline, no images, no per-item
 * file. `postedAt` is when the entry was logged, not when the track came
 * out — the point is the moment, not a discography.
 */
export type Platform = 'spotify' | 'youtube';

export interface Track {
  readonly url: string;
  readonly postedAt: string;
  readonly note: string;
  readonly platform: Platform;
  readonly embedUrl: string;
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
  readonly note?: string;
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
  const host = parsed.hostname.replace(/^www\./, '');

  if (host === 'open.spotify.com') {
    const match = /^\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/.exec(parsed.pathname);
    if (!match) return null;
    return {
      platform: 'spotify',
      embedUrl: `https://open.spotify.com/embed/${match[1]}/${match[2]}`,
    };
  }

  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const shorts = /^\/shorts\/([^/]+)/.exec(parsed.pathname);
    const id = parsed.searchParams.get('v') ?? shorts?.[1];
    if (!id) return null;
    return { platform: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` };
  }

  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1);
    if (!id) return null;
    return { platform: 'youtube', embedUrl: `https://www.youtube.com/embed/${id}` };
  }

  return null;
}

/** Every logged track, newest `postedAt` first. Empty if the file hasn't been added yet or has no valid links. */
export function loadTracks(): Track[] {
  if (!existsSync(TRACKS_FILE)) return [];
  const data = (parse(readFileSync(TRACKS_FILE, 'utf8')) ?? []) as TrackFile[];
  return data
    .map((entry): Track | null => {
      if (!entry.url) return null;
      const embed = toEmbed(entry.url);
      if (!embed) return null;
      return {
        url: entry.url,
        postedAt: entry.postedAt ?? '',
        note: entry.note ?? '',
        platform: embed.platform,
        embedUrl: embed.embedUrl,
      };
    })
    .filter((track): track is Track => track !== null)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
}

/** `'2026-08-13'` -> `'Aug 13, 2026'`. Returns the raw string unchanged if it isn't a plain ISO date. */
export function formatPostedAt(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
