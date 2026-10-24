import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';

const DERIVATIVES =
  join(dirname(fileURLToPath(import.meta.url)), '..', 'generated', 'derivatives') + sep;
const IMAGE_TYPES = { '.avif': 'image/avif', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

/**
 * Serves /p/... straight from generated/derivatives/ under `astro dev` and
 * `astro preview` — the same place tools/serve reads them from in
 * production. Nothing is copied into public/, so a build never drags
 * gigabytes of images into dist/. Not a symlink (see CLAUDE.md): nothing
 * here can leak into the build output, because the build never sees it.
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
  configurePreviewServer: (server) => void server.middlewares.use(serveDerivatives),
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
    },
  },
});
