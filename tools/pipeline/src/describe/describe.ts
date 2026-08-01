import { join } from 'node:path';

import { PipelineError } from '../errors.ts';
import { readPhotosFile, setPhotoDescription } from '../album-files.ts';
import { readAllManifests } from '../publish.ts';
import type { AlbumManifest, PhotoRecord } from '../manifest.ts';
import { derivativePath } from '../paths.ts';
import type { Paths } from '../paths.ts';
import { readDescriptionCache, writeDescriptionCache } from './cache.ts';
import type { DescriptionCache } from './cache.ts';
import type { DescriptionProvider } from './provider.ts';

export interface DescribeOptions {
  readonly paths: Paths;
  readonly onlyAlbums: readonly string[] | null;
  readonly provider: DescriptionProvider;
  /** Bypass the cache and call the provider again — but only for photos whose current text is still exactly what we generated last time; a hand-edited description is never touched. */
  readonly regenerate: boolean;
  readonly onProgress?: (event: DescribeEvent) => void;
}

export type DescribeOutcome =
  'generated' | 'filled-from-cache' | 'skipped-manual' | 'skipped-current' | 'failed';

export interface DescribeEvent {
  readonly album: string;
  readonly file: string;
  readonly outcome: DescribeOutcome;
  readonly message?: string;
}

export interface DescribeReport {
  readonly generated: number;
  readonly filledFromCache: number;
  readonly skipped: number;
  readonly failures: readonly {
    readonly album: string;
    readonly file: string;
    readonly message: string;
  }[];
}

/** The widest JPEG at or above 1000px, or the widest JPEG available — big enough to describe, small enough to keep the request cheap. */
function pickDescriptionImage(photo: PhotoRecord): string | null {
  const jpegs = photo.variants
    .filter((variant) => variant.format === 'jpeg')
    .sort((a, b) => a.width - b.width);
  const target = jpegs.find((variant) => variant.width >= 1000) ?? jpegs.at(-1);
  return target?.key ?? null;
}

async function describeAlbum(
  paths: Paths,
  manifest: AlbumManifest,
  provider: DescriptionProvider,
  regenerate: boolean,
  cache: DescriptionCache,
  onProgress: ((event: DescribeEvent) => void) | undefined,
): Promise<DescribeReport> {
  const albumDirectory = join(paths.albums, manifest.slug);
  const entries = await readPhotosFile(albumDirectory);
  const currentByFile = new Map(entries.map((entry) => [entry.file, entry]));

  let generated = 0;
  let filledFromCache = 0;
  let skipped = 0;
  const failures: { album: string; file: string; message: string }[] = [];

  for (const photo of manifest.photos) {
    const current = currentByFile.get(photo.file);
    const currentAlt = current?.alt ?? '';
    const cached = cache[photo.sourceId];
    const matchesCache = cached !== undefined && currentAlt === cached.alt;

    const shouldFillFromCache = !regenerate && cached !== undefined && currentAlt === '';
    const shouldGenerateFresh = cached === undefined && currentAlt === '';
    const shouldRegenerate = regenerate && (currentAlt === '' || matchesCache);

    if (!shouldFillFromCache && !shouldGenerateFresh && !shouldRegenerate) {
      const reason = currentAlt !== '' ? 'skipped-manual' : 'skipped-current';
      skipped += 1;
      onProgress?.({ album: manifest.slug, file: photo.file, outcome: reason });
      continue;
    }

    if (shouldFillFromCache && cached !== undefined) {
      await setPhotoDescription(albumDirectory, photo.file, {
        alt: cached.alt,
        caption: cached.caption,
      });
      filledFromCache += 1;
      onProgress?.({ album: manifest.slug, file: photo.file, outcome: 'filled-from-cache' });
      continue;
    }

    const key = pickDescriptionImage(photo);
    if (key === null) {
      failures.push({
        album: manifest.slug,
        file: photo.file,
        message: 'has no JPEG variant to send. Run `pnpm ingest`.',
      });
      onProgress?.({
        album: manifest.slug,
        file: photo.file,
        outcome: 'failed',
        message: 'no JPEG variant',
      });
      continue;
    }

    try {
      const description = await provider.describe({
        imagePath: derivativePath(paths, key),
        context: { album: manifest.slug, roll: photo.roll },
      });
      cache[photo.sourceId] = {
        alt: description.alt,
        caption: description.caption,
        provider: provider.name,
      };
      await writeDescriptionCache(paths.descriptionsFile, cache);
      await setPhotoDescription(albumDirectory, photo.file, description);
      generated += 1;
      onProgress?.({ album: manifest.slug, file: photo.file, outcome: 'generated' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      failures.push({ album: manifest.slug, file: photo.file, message });
      onProgress?.({ album: manifest.slug, file: photo.file, outcome: 'failed', message });
    }
  }

  return { generated, filledFromCache, skipped, failures };
}

export async function describe(options: DescribeOptions): Promise<DescribeReport> {
  const { paths, onlyAlbums, provider, regenerate, onProgress } = options;

  const manifests = await readAllManifests(paths);
  const scoped =
    onlyAlbums === null
      ? manifests
      : manifests.filter((manifest) => onlyAlbums.includes(manifest.slug));

  if (onlyAlbums !== null) {
    const found = new Set(scoped.map((manifest) => manifest.slug));
    for (const slug of onlyAlbums) {
      if (!found.has(slug)) {
        throw new PipelineError(
          `No album called "${slug}" has a manifest. Run \`pnpm ingest\` first.`,
        );
      }
    }
  }

  const cache = await readDescriptionCache(paths.descriptionsFile);

  let generated = 0;
  let filledFromCache = 0;
  let skipped = 0;
  const failures: { album: string; file: string; message: string }[] = [];

  for (const manifest of scoped) {
    const albumReport = await describeAlbum(
      paths,
      manifest,
      provider,
      regenerate,
      cache,
      onProgress,
    );
    generated += albumReport.generated;
    filledFromCache += albumReport.filledFromCache;
    skipped += albumReport.skipped;
    failures.push(...albumReport.failures);
  }

  return { generated, filledFromCache, skipped, failures };
}
