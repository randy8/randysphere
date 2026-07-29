import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.ts';
import { doctor } from './doctor.ts';
import { PipelineError } from './errors.ts';
import { defaultConcurrency, ingest } from './ingest.ts';
import { resolvePaths, repositoryRoot } from './paths.ts';
import { publish } from './publish.ts';
import { createLocalStorage } from './storage/local.ts';
import { createR2Storage, readCredentialsFromEnvironment } from './storage/r2.ts';
import type { Storage } from './storage/storage.ts';

const USAGE = `
Usage: pnpm <command> [options]

  pnpm ingest              Encode derivatives and rewrite the manifests.
  pnpm run publish         Upload derivatives to Cloudflare R2.
  pnpm doctor              Report drift without changing anything.

Options:
  --album <slug>           Restrict to one album. Repeatable.
  --local                  Publish into a directory instead of R2.
  --concurrency <n>        Photographs or uploads in flight. Default: half your cores.
  --help                   This.

Note: pnpm has a built-in \`publish\` command, so the image publisher is
\`pnpm run publish\`. \`pnpm publish:images\` does the same thing unambiguously.
`.trim();

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toString()} ${count === 1 ? singular : pluralForm}`;
}

async function runIngest(onlyAlbums: string[] | null, concurrency: number): Promise<void> {
  const paths = resolvePaths(repositoryRoot());
  const config = await loadConfig(paths.configFile);
  const report = await ingest({ paths, config, onlyAlbums, concurrency });

  for (const album of report.albums) {
    const parts = [`${album.slug}: ${plural(album.photos, 'photograph')}`];
    if (album.encoded > 0) parts.push(`${plural(album.encoded, 'derivative')} encoded`);
    if (album.reused > 0) parts.push(`${album.reused.toString()} unchanged`);
    console.log(parts.join(', '));

    if (album.newIdentities > 0) {
      console.log(
        `  ${plural(album.newIdentities, 'photograph')} changed on disk and got a new identity, ` +
          'so every derivative and URL for them is new.',
      );
    }
    if (album.albumFileCreated) console.log(`  created albums/${album.slug}/album.md`);
    if (album.photosFileCreated) console.log(`  created albums/${album.slug}/photos.yaml`);
    if (album.added.length > 0) console.log(`  added to photos.yaml: ${album.added.join(', ')}`);
    if (album.removed.length > 0) {
      console.log(`  removed from photos.yaml: ${album.removed.join(', ')} (their captions are gone)`);
    }
    if (album.missingAlt.length > 0) {
      console.log(`  ${plural(album.missingAlt.length, 'photograph')} still without alt text`);
    }
  }

  for (const slug of report.orphanManifests) {
    console.log(`generated/albums/${slug}.json has no originals/${slug}/ any more; delete it if the album is gone.`);
  }
}

function buildStorage(
  root: string,
  local: boolean,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Storage {
  if (local) {
    return createLocalStorage(join(root, config.localPublishDir));
  }
  return createR2Storage(readCredentialsFromEnvironment(config.r2.bucket));
}

async function runPublish(local: boolean, concurrency: number): Promise<void> {
  const root = repositoryRoot();
  const paths = resolvePaths(root);
  const config = await loadConfig(paths.configFile);
  const storage = buildStorage(root, local, config);

  console.log(`Publishing to ${storage.description}`);
  const report = await publish({
    paths,
    storage,
    concurrency,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) console.log(`  ${done.toString()}/${total.toString()}`);
    },
  });

  console.log(
    `${plural(report.totalKeys, 'derivative')}: ${report.alreadyPresent.toString()} already there, ` +
      `${report.uploaded.toString()} uploaded` +
      (report.replaced > 0 ? ` (${report.replaced.toString()} replaced after a size mismatch)` : ''),
  );
  console.log(`Recorded ${plural(report.albumsRecorded.length, 'album')} as published.`);
}

async function runDoctor(): Promise<number> {
  const paths = resolvePaths(repositoryRoot());
  const config = await loadConfig(paths.configFile);
  const findings = await doctor(paths, config);

  if (findings.length === 0) {
    console.log('Everything agrees: originals, manifests, captions, derivatives, and publish state.');
    return 0;
  }
  for (const finding of findings) {
    console.log(`${finding.severity === 'error' ? 'error' : 'warn '}  ${finding.where} ${finding.message}`);
  }
  return findings.some((finding) => finding.severity === 'error') ? 1 : 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      album: { type: 'string', multiple: true },
      local: { type: 'boolean', default: false },
      concurrency: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  const [command] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const concurrency =
    values.concurrency === undefined ? defaultConcurrency() : Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new PipelineError(`--concurrency must be a whole number of 1 or more, got ${String(values.concurrency)}`);
  }
  const onlyAlbums = values.album ?? null;

  switch (command) {
    case 'ingest':
      await runIngest(onlyAlbums, concurrency);
      return 0;
    case 'publish':
      await runPublish(values.local, concurrency);
      return 0;
    case 'doctor':
      return runDoctor();
    default:
      throw new PipelineError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

// A .env at the repository root is the documented place for R2 credentials. It
// is git-ignored, and loading it here means no command needs a wrapper script.
const envFile = join(repositoryRoot(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof PipelineError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
