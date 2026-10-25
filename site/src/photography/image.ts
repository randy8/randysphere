import type { Photo, Variant, VariantFormat } from './manifest.ts';

/**
 * Join the configured image base onto a manifest key.
 *
 * The base may be empty (same origin), a path, or an absolute URL, and it may
 * or may not have a trailing slash. Exactly one separator is emitted in every
 * case. A double slash here would still load in most browsers and would look
 * fine in a screenshot, which is precisely why it needs a test rather than an
 * eyeball.
 */
export function assetUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;
}

export function variantsOf(photo: Photo, format: VariantFormat): Variant[] {
  return photo.variants
    .filter((variant) => variant.format === format)
    .sort((a, b) => a.width - b.width);
}

export function srcset(base: string, variants: readonly Variant[]): string {
  return variants
    .map((variant) => `${assetUrl(base, variant.key)} ${String(variant.width)}w`)
    .join(', ');
}

/** The largest variant of a format, which is what the no-JavaScript link opens. */
export function largest(photo: Photo, format: VariantFormat): Variant | undefined {
  return variantsOf(photo, format).at(-1);
}

/** The smallest JPEG, used as the plain `src` for clients that ignore srcset. */
export function smallest(photo: Photo, format: VariantFormat): Variant | undefined {
  return variantsOf(photo, format).at(0);
}

export interface OgImage {
  readonly image: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
}

/** A photo's `og` crop as the three props Base.astro's social meta tags need, as an absolute URL. */
export function ogImageOf(base: string, photo: Photo, site: URL): OgImage {
  return {
    image: new URL(assetUrl(base, photo.og.key), site).href,
    imageWidth: photo.og.width,
    imageHeight: photo.og.height,
  };
}

/**
 * `sizes` for a tile in the photo grid (.grid in base.css): 2 columns, 3
 * from 40rem, 4 from 64rem, 1rem gaps, inside .wrap's 1.5rem padding and
 * 76rem cap — so a tile is at most (73rem − 3 gaps) / 4 = 17.5rem (280px).
 * Accurate, so a browser picks the smallest srcset width that still covers
 * the tile at its own pixel density. Keep in step with base.css.
 */
export const GRID_SIZES =
  '(min-width: 76rem) 17.5rem, (min-width: 64rem) calc(25vw - 1.5rem), ' +
  '(min-width: 40rem) calc(33.33vw - 1.67rem), calc(50vw - 2rem)';
