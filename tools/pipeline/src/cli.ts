import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.ts';
import { createClaudeDescriptionProvider } from './describe/claude-provider.ts';
import { describe } from './describe/describe.ts';
import { doctor } from './doctor.ts';
import { createEditorServer } from './editor/server.ts';
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
  pnpm describe            Generate alt text and captions for photos missing one.
  pnpm edit                Local web UI for batch-tagging and captioning, loopback-only.

Options:
  --album <slug>           Restrict to one album. Repeatable.
  --local                  Publish into a directory instead of R2.
  --concurrency <n>        Photographs or uploads in flight. Default: half your cores.
  --regenerate             describe: re-generate photos already described, unless hand-edited since.
  --model <id>             describe: override the Claude model (default claude-opus-5).
  --port <n>               edit: port to listen on (default 4500). Always binds 127.0.0.1 only.
  --help                   This.

\`pnpm describe\` needs ANTHROPIC_API_KEY in .env. It never touches originals/
or generated/albums/*.json; it only fills in empty alt/caption fields in
albums/<slug>/photos.yaml and caches what it generated in
generated/descriptions.json. \`pnpm ingest\` never calls it and never needs
network access.

Note: pnpm has a built-in \`publish\` command, so the image publisher is
\`pnpm run publish\`. \`pnpm publish:images\` does the same thing unambiguously.
`.trim();

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toString()} ${count === 1 ? singular : pluralForm}`;
}

const PROGRESS_BAR_WIDTH = 24;

/**
 * A single overwriting line, not scrolling log spam — `\r` with no trailing
 * newline until the bar reaches 100%. Only when stdout is a real terminal:
 * piped to a file or captured by another process, `\r` would just corrupt
 * the log instead of animating, so this is silent there and the run is still
 * fully observable from the final per-album summary either way.
 */
function renderProgressBar(label: string, completed: number, total: number): void {
  if (!process.stdout.isTTY) return;
  const filled = Math.round((completed / total) * PROGRESS_BAR_WIDTH);
  const bar = '#'.repeat(filled) + '-'.repeat(PROGRESS_BAR_WIDTH - filled);
  const line = `  [${bar}] ${label}: ${completed.toString()}/${total.toString()}`;
  process.stdout.write(`\r${line.padEnd(72)}`);
  if (completed === total) process.stdout.write('\n');
}

async function runIngest(onlyAlbums: string[] | null, concurrency: number): Promise<void> {
  const paths = resolvePaths(repositoryRoot());
  const config = await loadConfig(paths.configFile);
  const report = await ingest({
    paths,
    config,
    onlyAlbums,
    concurrency,
    onProgress: (slug, completed, total) => {
      renderProgressBar(slug, completed, total);
    },
  });

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
      console.log(
        `  removed from photos.yaml: ${album.removed.join(', ')} (their captions are gone)`,
      );
    }
    if (album.moved.length > 0) {
      const moves = album.moved.map((entry) => `${entry.from} -> ${entry.to}`).join(', ');
      console.log(
        `  ${plural(album.moved.length, 'photograph')} matched by content across a move: ${moves}`,
      );
    }
    if (album.missingAlt.length > 0) {
      console.log(`  ${plural(album.missingAlt.length, 'photograph')} still without alt text`);
    }
    if (album.tagsBackfilled.length > 0) {
      console.log(
        `  ${plural(album.tagsBackfilled.length, 'photograph')} tagged "${album.slug}" (had no tags yet)`,
      );
    }
    if (album.sourceIdBackfilled.length > 0) {
      console.log(
        `  ${plural(album.sourceIdBackfilled.length, 'photograph')} gained a content id (one-time upgrade)`,
      );
    }
  }

  for (const slug of report.removedAlbums) {
    console.log(
      `removed ${slug}: no originals/${slug}/ any more (its manifest and albums/${slug}/ are gone)`,
    );
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
      renderProgressBar('uploading', done, total);
    },
  });

  console.log(
    `${plural(report.totalKeys, 'derivative')}: ${report.alreadyPresent.toString()} already there, ` +
      `${report.uploaded.toString()} uploaded` +
      (report.replaced > 0
        ? ` (${report.replaced.toString()} replaced after a size mismatch)`
        : ''),
  );
  console.log(`Recorded ${plural(report.albumsRecorded.length, 'album')} as published.`);
}

async function runDescribe(
  onlyAlbums: string[] | null,
  regenerate: boolean,
  model: string | undefined,
): Promise<number> {
  const paths = resolvePaths(repositoryRoot());
  const provider = createClaudeDescriptionProvider(model === undefined ? {} : { model });

  const report = await describe({
    paths,
    onlyAlbums,
    provider,
    regenerate,
    onProgress: (event) => {
      if (
        event.outcome === 'generated' ||
        event.outcome === 'filled-from-cache' ||
        event.outcome === 'failed'
      ) {
        console.log(
          `  [${event.album}] ${event.file}: ${event.outcome}${event.message ? ` (${event.message})` : ''}`,
        );
      }
    },
  });

  console.log(
    `${plural(report.generated, 'description')} generated, ` +
      `${report.filledFromCache.toString()} filled from cache, ` +
      `${report.skipped.toString()} left alone (already described).`,
  );
  if (report.failures.length > 0) {
    console.log(`${plural(report.failures.length, 'failure')}:`);
    for (const failure of report.failures) {
      console.log(`  [${failure.album}] ${failure.file}: ${failure.message}`);
    }
    return 1;
  }
  return 0;
}

const DEFAULT_EDITOR_PORT = 4500;

/**
 * Loopback-only by construction — `127.0.0.1`, never `0.0.0.0` (see
 * `createEditorServer`'s own doc comment). This writes to `photos.yaml` on
 * every batch edit with no authentication of its own; the only thing making
 * that acceptable is that it is never reachable from outside this machine.
 */
async function runEditor(port: number): Promise<number> {
  const paths = resolvePaths(repositoryRoot());
  const server = createEditorServer(paths);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`Editor running at http://127.0.0.1:${port.toString()} (Ctrl+C to stop)`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      server.close(() => resolve());
    });
  });
  return 0;
}

async function runDoctor(): Promise<number> {
  const paths = resolvePaths(repositoryRoot());
  const config = await loadConfig(paths.configFile);
  const findings = await doctor(paths, config);

  if (findings.length === 0) {
    console.log(
      'Everything agrees: originals, manifests, captions, derivatives, and publish state.',
    );
    return 0;
  }
  for (const finding of findings) {
    console.log(
      `${finding.severity === 'error' ? 'error' : 'warn '}  ${finding.where} ${finding.message}`,
    );
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
      regenerate: { type: 'boolean', default: false },
      model: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });

  const [command] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const concurrency =
    values.concurrency === undefined
      ? defaultConcurrency()
      : Number.parseInt(values.concurrency, 10);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new PipelineError(
      `--concurrency must be a whole number of 1 or more, got ${String(values.concurrency)}`,
    );
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
    case 'describe':
      return runDescribe(onlyAlbums, values.regenerate, values.model);
    case 'edit': {
      const port =
        values.port === undefined ? DEFAULT_EDITOR_PORT : Number.parseInt(values.port, 10);
      if (!Number.isInteger(port) || port < 1) {
        throw new PipelineError(
          `--port must be a whole number of 1 or more, got ${String(values.port)}`,
        );
      }
      return runEditor(port);
    }
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
