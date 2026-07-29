import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { isMap, isSeq, parseDocument } from 'yaml';

import type { PipelineConfig } from './config.ts';
import { pathExists } from './files.ts';
import { albumKeyDigest, albumKeys, readPublishedRecord } from './manifest.ts';
import type { Paths } from './paths.ts';
import { listSourceFiles } from './sources.ts';
import { readAllManifests } from './publish.ts';

export type Severity = 'error' | 'warning';

export interface Finding {
  readonly severity: Severity;
  readonly where: string;
  readonly message: string;
}

async function collectDerivativeKeys(root: string, prefix: string, into: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectDerivativeKeys(join(root, entry.name), key, into);
    } else if (entry.isFile()) {
      into.add(key);
    }
  }
}

async function listedInPhotosFile(albumDirectory: string): Promise<string[] | null> {
  const path = join(albumDirectory, 'photos.yaml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const node = parseDocument(text).get('photos', true);
  if (!isSeq(node)) return [];
  return node.items
    .map((item) => (isMap(item) ? item.get('file') : undefined))
    .filter((file): file is string => typeof file === 'string');
}

/**
 * Checks the things that are true when everything is consistent, and says
 * precisely which one is not. It never changes anything: a report that also
 * repairs is a report you stop reading.
 */
export async function doctor(paths: Paths, config: PipelineConfig): Promise<Finding[]> {
  const findings: Finding[] = [];
  const manifests = await readAllManifests(paths);

  const localDerivatives = new Set<string>();
  await collectDerivativeKeys(paths.derivatives, '', localDerivatives);

  const referenced = new Set<string>();
  for (const manifest of manifests) {
    const albumOriginals = join(paths.originals, manifest.slug);
    const albumDirectory = join(paths.albums, manifest.slug);
    const where = relative(paths.root, join(paths.manifests, `${manifest.slug}.json`));

    if (!(await pathExists(albumOriginals))) {
      findings.push({
        severity: 'warning',
        where,
        message:
          `there is no originals/${manifest.slug}/ any more. The manifest is stale; ` +
          'delete it if the album is gone.',
      });
    } else {
      const onDisk = await listSourceFiles(albumOriginals);
      const inManifest = manifest.photos.map((photo) => photo.file);
      for (const file of onDisk) {
        if (!inManifest.includes(file)) {
          findings.push({
            severity: 'error',
            where: `originals/${manifest.slug}/${file}`,
            message: 'is not in the manifest. Run `pnpm ingest`.',
          });
        }
      }
      for (const file of inManifest) {
        if (!onDisk.includes(file)) {
          findings.push({
            severity: 'error',
            where: `${where} -> ${file}`,
            message: 'names a photograph that is no longer in originals/. Run `pnpm ingest`.',
          });
        }
      }
    }

    const listed = await listedInPhotosFile(albumDirectory);
    if (listed === null) {
      findings.push({
        severity: 'error',
        where: `albums/${manifest.slug}/photos.yaml`,
        message: 'is missing. Run `pnpm ingest` to create it.',
      });
    } else {
      for (const photo of manifest.photos) {
        if (!listed.includes(photo.file)) {
          findings.push({
            severity: 'error',
            where: `albums/${manifest.slug}/photos.yaml`,
            message: `does not list ${photo.file}. Run \`pnpm ingest\`.`,
          });
        }
      }
    }

    for (const key of albumKeys(manifest)) {
      referenced.add(key);
      if (!localDerivatives.has(key)) {
        findings.push({
          severity: 'warning',
          where: `generated/derivatives/${key}`,
          message: 'is missing locally. Publishing will need it; run `pnpm ingest` to rebuild.',
        });
      }
    }
  }

  for (const key of localDerivatives) {
    if (!referenced.has(key)) {
      findings.push({
        severity: 'warning',
        where: `generated/derivatives/${key}`,
        message: 'is not referenced by any manifest. Safe to delete; nothing deletes it for you.',
      });
    }
  }

  const published = await readPublishedRecord(paths.publishedFile);
  if (published === null) {
    findings.push({
      severity: 'warning',
      where: 'generated/published.json',
      message: 'does not exist, so nothing has been published yet.',
    });
  } else {
    for (const manifest of manifests) {
      const recorded = published.albums[manifest.slug];
      if (recorded === undefined) {
        findings.push({
          severity: 'error',
          where: `album ${manifest.slug}`,
          message: `has never been published to ${published.target}. Run \`pnpm run publish\`.`,
        });
      } else if (recorded !== albumKeyDigest(manifest)) {
        findings.push({
          severity: 'error',
          where: `album ${manifest.slug}`,
          message:
            `has changed since it was published to ${published.target}. ` +
            'Run `pnpm run publish` before deploying, or the site will reference images that do not exist.',
        });
      }
    }
  }

  const currentRecipeVersion = config.recipeVersion;
  const indexRaw = await readFile(paths.indexFile, 'utf8').catch(() => null);
  if (indexRaw !== null) {
    const parsed = JSON.parse(indexRaw) as { recipe?: { recipeVersion?: number } };
    const recorded = parsed.recipe?.recipeVersion;
    if (recorded !== undefined && recorded !== currentRecipeVersion) {
      findings.push({
        severity: 'warning',
        where: 'pipeline.config.ts',
        message:
          `recipeVersion is ${currentRecipeVersion.toString()} but the last ingest used ` +
          `${recorded.toString()}. Run \`pnpm ingest\` to re-encode.`,
      });
    }
  }

  return findings;
}
