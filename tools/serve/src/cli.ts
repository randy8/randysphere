import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createPrivateSiteServer } from './server.ts';

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

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = portArg ? Number.parseInt(portArg.slice('--port='.length), 10) : 4322;

const password = process.env['PRIVATE_SITE_PASSWORD'];
const sessionSecret = process.env['PRIVATE_SESSION_SECRET'];
const distDir = join(ROOT, 'site', 'dist');

if (!password || !sessionSecret) {
  console.error(
    'PRIVATE_SITE_PASSWORD and PRIVATE_SESSION_SECRET must both be set in .env. ' +
      'Generate a secret with: openssl rand -hex 32',
  );
  process.exitCode = 1;
} else if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`${distDir} has no build yet. Run \`pnpm build\` first.`);
  process.exitCode = 1;
} else {
  const server = createPrivateSiteServer({
    distDir,
    notesPath: join(ROOT, 'private', 'notes.yaml'),
    privatePhotosDir: join(ROOT, 'private', 'photos'),
    password,
    sessionSecret,
  });
  server.listen(port, () => {
    console.log(`Serving site/dist on http://0.0.0.0:${String(port)} — private area at /private`);
  });
}
