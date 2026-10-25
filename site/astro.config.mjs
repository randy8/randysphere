import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, '..');
const DERIVATIVES = join(ROOT, 'generated', 'derivatives') + sep;
const IMAGE_TYPES = { '.avif': 'image/avif', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

/**
 * Serves /p/... straight from generated/derivatives/ under `astro dev` — the
 * same place tools/serve reads them from in production. Nothing is copied
 * into public/, so a build never drags gigabytes of images into dist/. Not
 * a symlink (see CLAUDE.md): nothing here can leak into the build output,
 * because the build never sees it. Dev only: `astro preview` drops every
 * user Vite plugin, so `pnpm preview` runs tools/serve on the build instead
 * (see package.json).
 */
function serveDerivatives(req, res, next) {
  const path = (req.url ?? '').split('?')[0];
  if (!path.startsWith('/p/')) return next();
  const file = normalize(join(DERIVATIVES, decodeURIComponent(path)));
  if (!file.startsWith(DERIVATIVES)) return next();
  try {
    if (!statSync(file).isFile()) return next();
  } catch {
    return next();
  }
  res.setHeader('content-type', IMAGE_TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}

const derivatives = {
  name: 'serve-derivatives',
  configureServer: (server) => void server.middlewares.use(serveDerivatives),
};

export default defineConfig({
  // Used for canonical, Open Graph, sitemap, and feed URLs.
  site: 'https://randyliang.net',

  // One canonical shape for every URL, so a page is never reachable at two
  // addresses and search engines never have to pick.
  trailingSlash: 'always',
  build: { format: 'directory' },

  // Photography is the flagship collection and the reason this site exists;
  // "/" sends a visitor straight there instead of making every visit stop
  // at the collections index first. The collections homepage still exists,
  // just at /collections/ (see src/pages/collections/index.astro) — this
  // literal must match collections.ts's photography entry's own `href`,
  // which is the same string for the same reason (straight into Selected
  // Work, not a preview page). See docs/decisions.md, 2026-08-24.
  redirects: {
    '/': '/exposures/',
  },

  server: { port: 4321 },

  vite: {
    plugins: [derivatives],
    server: {
      // Vite refuses requests carrying an unexpected Host header. Tailscale
      // serves this machine as <host>.<tailnet>.ts.net, so that suffix has to
      // be allowed or every request over the tailnet returns "Blocked request".
      allowedHosts: ['.ts.net', 'localhost'],
      // What the dev server may hand out over /@fs/. Vite's default is the
      // whole pnpm workspace — this repository — which put private/ (the
      // /private notebook) and full-resolution originals/ one URL away from
      // anyone on the LAN or tailnet while `astro dev --host` ran. The
      // site's own build-time reads (manifests, albums/, recipes/) go
      // through Node's fs and aren't affected; over HTTP the dev server
      // only ever needs site/ and node_modules/. The deny list keeps Vite's
      // defaults and names the two directories that must never be served,
      // whatever `allow` becomes later.
      fs: {
        allow: [SITE, join(ROOT, 'node_modules')],
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/private/**', '**/originals/**'],
      },
    },
  },
});
