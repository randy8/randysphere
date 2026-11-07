import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import Anthropic from '@anthropic-ai/sdk';

import { DEFAULT_MODEL } from './extract.ts';
import { status } from './importer.ts';
import type { ImporterDeps } from './importer.ts';
import { createImporterServer } from './server.ts';

/**
 * `pnpm recipes:import` — a local page for turning an Instagram Reel into a
 * recipe: paste the link, read or paste the caption, let Claude draft it,
 * review and edit, save `recipes/<slug>.yaml`. Publishing is then the usual
 * commit and `pnpm deploy`; this never touches git or the live site.
 *
 * Needs ANTHROPIC_API_KEY in .env to draft (without it, a recipe can still
 * be written by hand in the same form). Uses yt-dlp to read the caption if
 * it's on PATH; otherwise the caption is pasted or screenshotted.
 * RECIPE_IMPORT_MODEL overrides the model (default claude-opus-5-5).
 */

const DEFAULT_PORT = 4510;

function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Could not find the repository root above ${process.cwd()}.`);
}

const ROOT = repositoryRoot();
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const port = values.port === undefined ? DEFAULT_PORT : Number.parseInt(values.port, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`--port must be a port number, got ${String(values.port)}`);
  process.exit(1);
}

const hasKey = Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);
const model = process.env['RECIPE_IMPORT_MODEL'] ?? DEFAULT_MODEL;
const deps: ImporterDeps = {
  recipesDirectory: join(ROOT, 'recipes'),
  claude: hasKey ? new Anthropic() : null,
  model,
};

const server = createImporterServer(deps, {
  fontsDirectory: join(ROOT, 'site', 'public', 'fonts'),
});
// Loopback only, never 0.0.0.0: this writes into the repository with no authentication.
server.listen(port, '127.0.0.1', () => {
  void status(deps).then((available) => {
    console.log(`Recipe importer: http://127.0.0.1:${String(port)}/`);
    console.log(
      available.claude
        ? `  Drafting with ${model}.`
        : '  ANTHROPIC_API_KEY is not set: recipes can be written by hand, not drafted.',
    );
    console.log(
      available.ytDlp
        ? '  yt-dlp found: captions are read automatically when Instagram allows it.'
        : '  yt-dlp not found: paste the caption or add screenshots.',
    );
    console.log('  Saved recipes land in recipes/. Commit and `pnpm deploy` to publish.');
  });
});
