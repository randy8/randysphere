import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createPrivateSiteServer } from './server.ts';
import { tailscaledWhois } from './infra.ts';
import { FamilyChat } from './family/routes.ts';

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

// --preview (`pnpm preview`): the same server on a local port, to look at
// a build exactly as production serves it. Without a .env — a fresh clone —
// it seals /private with a throwaway password nobody knows, rather than
// refusing to start; production never passes this flag.
const preview = process.argv.includes('--preview');
const throwaway = (): string => randomBytes(32).toString('hex');
const password = process.env['PRIVATE_SITE_PASSWORD'] ?? (preview ? throwaway() : undefined);
const sessionSecret = process.env['PRIVATE_SESSION_SECRET'] ?? (preview ? throwaway() : undefined);
// Production serves site/release, which only `pnpm deploy` writes — so a
// local `pnpm build` (into site/dist) can never change the live site.
// --preview serves that local build instead; --dist= lets the deploy start
// a candidate server on a new release before switching to it.
const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
const distDir = distArg
  ? distArg.slice('--dist='.length)
  : join(ROOT, 'site', process.argv.includes('--preview') ? 'dist' : 'release');

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
  // --preview gets an empty chat of its own: looking at a build must never
  // read, or write to, the family's real conversation.
  const family = new FamilyChat({
    dataDir: preview
      ? mkdtempSync(join(tmpdir(), 'family-preview-'))
      : join(ROOT, 'private', 'family'),
  });
  const server = createPrivateSiteServer({
    distDir,
    notesPath: join(ROOT, 'private', 'notes.yaml'),
    privatePhotosDir: join(ROOT, 'private', 'photos'),
    password,
    sessionSecret,
    derivativesDir: join(ROOT, 'generated', 'derivatives'),
    generatedAlbumsDir: join(ROOT, 'generated', 'albums'),
    // Matches astro.config.mjs's `site` — see the duplication note in
    // share-preview.ts/docs/decisions.md.
    siteOrigin: 'https://randyliang.net',
    statusDir: join(ROOT, 'status'),
    infraServicesPath: join(ROOT, 'infra', 'services.yaml'),
    whois: tailscaledWhois(),
    family,
  });
  server.listen(port, () => {
    console.log(
      `Serving ${distDir} (images from generated/derivatives) on http://0.0.0.0:${String(port)} — private area at /private`,
    );
  });

  // systemd stops the service with SIGTERM: finish what's in flight, then
  // exit, rather than cutting a download off mid-file. Bounded, so a stuck
  // connection can't hold a restart up past TimeoutStopSec.
  process.once('SIGTERM', () => {
    console.log('SIGTERM: finishing in-flight requests');
    // Open chat streams never go idle by themselves; ending them lets the
    // close finish, and every browser reconnects to the next server.
    family.shutdown();
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
