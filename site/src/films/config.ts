/** The handful of values specific to the films collection. */
export const films = {
  title: 'Films',
  description: 'A five-star viewing log.',
  /** TMDB serves posters at a handful of fixed widths; w500 is plenty for a grid card. */
  posterBaseUrl: 'https://image.tmdb.org/t/p/w500',
  tmdbAttribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
} as const;
