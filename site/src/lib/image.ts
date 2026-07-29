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
  return photo.variants.filter((variant) => variant.format === format).sort((a, b) => a.width - b.width);
}

export function srcset(base: string, variants: readonly Variant[]): string {
  return variants.map((variant) => `${assetUrl(base, variant.key)} ${String(variant.width)}w`).join(', ');
}

/** The largest variant of a format, which is what the no-JavaScript link opens. */
export function largest(photo: Photo, format: VariantFormat): Variant | undefined {
  return variantsOf(photo, format).at(-1);
}

/** The smallest JPEG, used as the plain `src` for clients that ignore srcset. */
export function smallest(photo: Photo, format: VariantFormat): Variant | undefined {
  return variantsOf(photo, format).at(0);
}
