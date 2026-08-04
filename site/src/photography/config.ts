/**
 * The handful of values specific to the photography collection. Everything
 * else about it is derived from the albums.
 */
export const photography = {
  title: 'Photography',
  description: '',

  /**
   * Where derivatives are served from.
   *
   * Empty means same-origin, which is what `pnpm run publish --local` produces:
   * files land in site/public/p/ and are served at /p/... . Point this at an R2
   * custom domain when you publish for real, with no trailing slash:
   *
   *   imageBaseUrl: 'https://img.example.com'
   */
  imageBaseUrl: '',
} as const;
