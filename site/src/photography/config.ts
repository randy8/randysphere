/**
 * The handful of values specific to the photography collection. Everything
 * else about it is derived from the albums.
 */
export const photography = {
  title: 'Exposures',
  description: '',

  /**
   * Where derivatives are served from.
   *
   * Empty means same-origin: /p/... is served straight from
   * generated/derivatives/ by tools/serve in production and by a middleware in
   * astro.config.mjs under dev/preview. Point this at an R2
   * custom domain when you publish for real, with no trailing slash:
   *
   *   imageBaseUrl: 'https://img.example.com'
   */
  imageBaseUrl: '',
} as const;
