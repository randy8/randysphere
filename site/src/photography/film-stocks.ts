/**
 * Film stocks by name. rolls.yaml and every URL carry a slug
 * (`cinestill400d`); people read the stock as its maker prints it on the
 * box. Display only — the slug stays the key everywhere else.
 */

export const FILM_STOCK_NAMES: Readonly<Record<string, string>> = {
  cinestill400d: 'CineStill 400D',
  ektar100: 'Kodak Ektar 100',
  harmanphoenixii200: 'Harman Phoenix II 200',
  ilfordhp5plus400: 'Ilford HP5 Plus 400',
  kodakgold200: 'Kodak Gold 200',
  kodaktrix400: 'Kodak Tri-X 400',
  kodakultramax400: 'Kodak UltraMax 400',
  lomochromepurple: 'LomoChrome Purple',
  portra400: 'Kodak Portra 400',
};

/**
 * The stock's printed name. A stock not in the table yet still reads as
 * words rather than a slug: its letters and its speed split apart and the
 * first letter capitalised (`fomapan100` → "Fomapan 100") — add it to
 * FILM_STOCK_NAMES for the exact spelling.
 */
export function filmStockName(slug: string): string {
  const known = FILM_STOCK_NAMES[slug];
  if (known !== undefined) return known;
  const spaced = slug.replace(/([a-z])(\d)/gi, '$1 $2').replace(/(\d)([a-z])/gi, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
