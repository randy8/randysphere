import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from './concurrency.ts';
import { PipelineError } from './errors.ts';
import { pathExists } from './files.ts';
import type { AlbumManifest } from './manifest.ts';
import {
  albumKeyDigest,
  albumKeys,
  readAlbumManifest,
  SCHEMA_VERSION,
  writePublishedRecord,
} from './manifest.ts';
import { derivativePath } from './paths.ts';
import type { Paths } from './paths.ts';
import { CONTENT_TYPE } from './recipe.ts';
import type { Storage } from './storage/storage.ts';

const KEY_PREFIX = 'p/';

export interface PublishReport {
  readonly target: string;
  readonly totalKeys: number;
  readonly alreadyPresent: number;
  readonly uploaded: number;
  readonly replaced: number;
  readonly albumsRecorded: readonly string[];
}

export async function readAllManifests(paths: Paths): Promise<AlbumManifest[]> {
  let names: string[];
  try {
    names = (await readdir(paths.manifests)).filter((name) => name.endsWith('.json'));
  } catch (cause) {
    throw new PipelineError(`No manifests in ${paths.manifests}. Run \`pnpm ingest\` first.`, {
      cause,
    });
  }
  if (names.length === 0) {
    throw new PipelineError(`No manifests in ${paths.manifests}. Run \`pnpm ingest\` first.`);
  }
  return Promise.all(names.sort().map((name) => readAlbumManifest(join(paths.manifests, name))));
}

function contentTypeForKey(key: string): string {
  if (key.endsWith('.avif')) return CONTENT_TYPE.avif;
  if (key.endsWith('.webp')) return CONTENT_TYPE.webp;
  return CONTENT_TYPE.jpeg;
}

export interface PublishOptions {
  readonly paths: Paths;
  readonly storage: Storage;
  readonly concurrency: number;
  readonly onProgress?: (uploaded: number, total: number) => void;
}

export async function publish(options: PublishOptions): Promise<PublishReport> {
  const { paths, storage, concurrency, onProgress } = options;

  const manifests = await readAllManifests(paths);
  const expectedSize = new Map<string, number>();
  for (const manifest of manifests) {
    for (const photo of manifest.photos) {
      for (const variant of photo.variants) expectedSize.set(variant.key, variant.bytes);
      expectedSize.set(photo.og.key, photo.og.bytes);
    }
  }

  // Listing the target is authoritative. The alternative — trusting a local
  // record of what was uploaded last time — is a cache of remote state, and it
  // is wrong the moment anyone touches the bucket by hand. Thirty requests for
  // thirty thousand objects is a fine price for never having to wonder.
  const present = await storage.list(KEY_PREFIX);

  const missing: string[] = [];
  let replaced = 0;
  for (const [key, bytes] of expectedSize) {
    const actual = present.get(key);
    if (actual === undefined) {
      missing.push(key);
    } else if (actual !== bytes) {
      // A truncated or interrupted upload. Re-uploading is the repair, and it
      // happens automatically rather than needing anyone to notice.
      missing.push(key);
      replaced += 1;
    }
  }

  const absentLocally: string[] = [];
  for (const key of missing) {
    if (!(await pathExists(derivativePath(paths, key)))) absentLocally.push(key);
  }
  if (absentLocally.length > 0) {
    const sample = absentLocally.slice(0, 5).join('\n  ');
    throw new PipelineError(
      `${absentLocally.length.toString()} derivative(s) need uploading but are not in ${paths.derivatives}:\n` +
        `  ${sample}${absentLocally.length > 5 ? '\n  ...' : ''}\n` +
        'That directory is a rebuildable cache. Run `pnpm ingest` to regenerate it, then publish again.',
    );
  }

  let uploaded = 0;
  await mapWithConcurrency(missing, concurrency, async (key) => {
    const body = await readFile(derivativePath(paths, key));
    await storage.put(key, body, contentTypeForKey(key));
    uploaded += 1;
    onProgress?.(uploaded, missing.length);
  });

  // Only now, with every key confirmed present, is the record written. An
  // interrupted run above leaves the previous record untouched, so nothing ever
  // claims that a derivative was published when it was not.
  const uploadedKeys = new Set(missing);
  const albums: Record<string, string> = {};
  const recorded: string[] = [];
  for (const manifest of manifests) {
    const complete = albumKeys(manifest).every((key) => present.has(key) || uploadedKeys.has(key));
    if (complete) {
      albums[manifest.slug] = albumKeyDigest(manifest);
      recorded.push(manifest.slug);
    }
  }

  await writePublishedRecord(paths.publishedFile, {
    schemaVersion: SCHEMA_VERSION,
    target: storage.description,
    albums,
  });

  return {
    target: storage.description,
    totalKeys: expectedSize.size,
    alreadyPresent: expectedSize.size - missing.length,
    uploaded,
    replaced,
    albumsRecorded: recorded,
  };
}
