import { defineConfig } from 'astro/config';

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
    '/': '/photography/selected/',
  },

  server: { port: 4321 },

  vite: {
    server: {
      // Vite refuses requests carrying an unexpected Host header. Tailscale
      // serves this machine as <host>.<tailnet>.ts.net, so that suffix has to
      // be allowed or every request over the tailnet returns "Blocked request".
      allowedHosts: ['.ts.net', 'localhost'],
    },
  },
});
