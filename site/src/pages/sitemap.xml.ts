import type { APIContext } from 'astro';

import { collections } from '../collections.ts';

// '/' itself is a redirect (see astro.config.mjs), not a real page — list
// the collections index it used to be instead of a URL a crawler would just
// bounce off of.
const STATIC_PAGES = ['/collections/'];

export function GET(context: APIContext): Response {
  const siteUrl = context.site?.href ?? 'https://randyliang.net';
  const paths = [...STATIC_PAGES, ...collections.flatMap((collection) => collection.urls())];
  const urls = paths
    .map((path) => `  <url>\n    <loc>${new URL(path, siteUrl).href}</loc>\n  </url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
