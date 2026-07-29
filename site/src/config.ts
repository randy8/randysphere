/**
 * The handful of values that are specific to you. Everything else about the
 * site is derived from the albums.
 */
export const site = {
  title: 'Photography',
  description: 'Photographs.',
  author: 'Your Name',

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
