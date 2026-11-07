import { execFile } from 'node:child_process';

import { cleanText } from './draft.ts';
import type { ReelReference } from './instagram-url.ts';

/**
 * Reads a Reel's caption and creator with yt-dlp, when it's installed.
 *
 * Instagram has no sanctioned way to read a caption: its logged-out pages
 * are a JavaScript shell with no caption in them, and Meta's oEmbed endpoint
 * (token-free since June 2026) forbids "extracting or persisting" what it
 * returns for anything but displaying an embed. yt-dlp is a widely used,
 * actively maintained downloader that tracks Instagram's changes so this
 * repository doesn't have to — but it is still scraping, it breaks when
 * Instagram changes, and Instagram often refuses logged-out requests. So it
 * is optional, never a dependency (`docs/dependencies.md`), and every
 * failure here is an ordinary outcome that hands the person the paste or
 * screenshot path instead. Only metadata is requested (`--skip-download`);
 * nothing is downloaded or kept.
 */

export interface Caption {
  readonly caption: string;
  /** Instagram handle without @, or "". */
  readonly creator: string;
  readonly creatorName: string;
}

export type CaptionResult =
  { readonly ok: true; readonly value: Caption } | { readonly ok: false; readonly message: string };

/** Runs yt-dlp with these arguments; resolves its stdout, rejects with the process error. */
export type YtDlp = (args: readonly string[]) => Promise<string>;

const TIMEOUT_MS = 45_000;

export const runYtDlp: YtDlp = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      [...args],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const failure: Error = Object.assign(error, { stderr: String(stderr) });
          reject(failure);
        } else resolve(String(stdout));
      },
    );
  });

/** True when a `yt-dlp` binary answers on PATH. */
export async function ytDlpAvailable(run: YtDlp = runYtDlp): Promise<boolean> {
  try {
    await run(['--version']);
    return true;
  } catch {
    return false;
  }
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** yt-dlp's Instagram fields: `channel` is the handle in current versions; older ones put it in `uploader_id`. */
export function captionFromMetadata(json: string): Caption | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const info = data as Record<string, unknown>;
  const handle = [info['channel'], info['uploader_id']].find(
    (value): value is string =>
      typeof value === 'string' && HANDLE.test(value) && !/^\d+$/.test(value),
  );
  // The caption keeps its line breaks: an ingredient list is usually one per line.
  const caption =
    typeof info['description'] === 'string'
      ? info['description'].replace(/\r\n?/g, '\n').slice(0, 20_000).trim()
      : '';
  return {
    caption,
    creator: handle ?? '',
    creatorName: cleanText(info['uploader'], 80),
  };
}

function explain(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT')
    return 'yt-dlp isn’t installed, so the caption can’t be read automatically.';
  if ((error as { killed?: unknown }).killed === true) return 'Instagram took too long to answer.';
  const raw = (error as { stderr?: unknown }).stderr;
  const stderr = (typeof raw === 'string' ? raw : '').toLowerCase();
  if (/login|log in|cookies|rate.?limit|429|401|403/.test(stderr)) {
    return 'Instagram wouldn’t show this Reel without logging in.';
  }
  if (/not available|404|private|removed|does not exist/.test(stderr)) {
    return 'That Reel isn’t available — it may be private or deleted.';
  }
  return 'The caption couldn’t be read automatically.';
}

export async function fetchCaption(
  reel: ReelReference,
  run: YtDlp = runYtDlp,
): Promise<CaptionResult> {
  let stdout: string;
  try {
    stdout = await run([
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--ignore-config',
      '--',
      reel.url,
    ]);
  } catch (error) {
    return { ok: false, message: explain(error) };
  }
  const caption = captionFromMetadata(stdout);
  if (caption === null)
    return { ok: false, message: 'The caption couldn’t be read automatically.' };
  if (caption.caption.length === 0) {
    return {
      ok: false,
      message: 'This Reel has no caption, so there’s nothing to read automatically.',
    };
  }
  return { ok: true, value: caption };
}
