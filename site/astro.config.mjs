import { defineConfig } from 'astro/config';

export default defineConfig({
  // Change this to your own domain. It is used for canonical and Open Graph
  // URLs; nothing else depends on it.
  site: 'https://example.com',

  // One canonical shape for every URL, so a page is never reachable at two
  // addresses and search engines never have to pick.
  trailingSlash: 'always',
  build: { format: 'directory' },

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
