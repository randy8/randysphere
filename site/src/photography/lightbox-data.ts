import type { ArchivePhoto } from './archive.ts';
import { formatCameraLine } from './camera.ts';
import { photography } from './config.ts';
import { assetUrl, smallest, srcset, variantsOf } from './image.ts';
import type { Variant } from './manifest.ts';
import { filmStockName } from './film-stocks.ts';

/**
 * Everything the lightbox shows for one photograph, as data rather than
 * markup. Lightbox.astro writes the page's list of these into one inline
 * JSON script, and lightbox.ts pours one into a slot when that photograph
 * is about to be seen — so a page carries each photograph's markup once
 * (its grid tile), not twice. The image attributes are exactly the ones
 * Photo.astro renders for a full-viewport, unlinked picture.
 */
export interface LightboxPhoto {
  readonly id: string;
  readonly avif: string | null;
  readonly webp: string | null;
  /** JPEG srcset; null when there's only one JPEG width (src alone, as Photo.astro does). */
  readonly jpeg: string | null;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly color: string;
  readonly alt: string;
  readonly filmStock: string | null;
  /** The stock as its maker prints it (film-stocks.ts); the slug above is for its URL. */
  readonly filmStockName: string | null;
  /** Its frame on the roll — the number the roll page prints under it. */
  readonly frame: number;
  readonly caption: string | null;
  readonly camera: string | null;
}

/** The `sizes` every lightbox image uses: it fills the viewport. */
export const LIGHTBOX_SIZES = '100vw';

export function lightboxPhoto(entry: ArchivePhoto, maxWidth?: number): LightboxPhoto {
  const { photo } = entry;
  const base = photography.imageBaseUrl;
  const capped = (variants: readonly Variant[]): readonly Variant[] => {
    if (maxWidth === undefined) return variants;
    const kept = variants.filter((variant) => variant.width <= maxWidth);
    return kept.length > 0 ? kept : variants.slice(0, 1);
  };
  const avif = capped(variantsOf(photo, 'avif'));
  const webp = capped(variantsOf(photo, 'webp'));
  const jpeg = capped(variantsOf(photo, 'jpeg'));
  const fallback = smallest(photo, 'jpeg') ?? photo.variants[0];
  if (fallback === undefined) {
    throw new Error(`${photo.file} has no usable variants. Run \`pnpm ingest\`.`);
  }
  return {
    id: photo.sourceId,
    avif: avif.length > 0 ? srcset(base, avif) : null,
    webp: webp.length > 0 ? srcset(base, webp) : null,
    jpeg: jpeg.length > 1 ? srcset(base, jpeg) : null,
    src: assetUrl(base, fallback.key),
    width: photo.width,
    height: photo.height,
    color: photo.color,
    alt: entry.alt,
    filmStock: entry.roll.filmStock || null,
    filmStockName: entry.roll.filmStock ? filmStockName(entry.roll.filmStock) : null,
    frame: entry.frame,
    caption: entry.caption,
    camera: formatCameraLine(entry) || null,
  };
}

/**
 * The list (or any payload built from it, like the exhibition's) as a JSON
 * string safe to place inside a <script> element: `<` is escaped, so no
 * caption can ever close the script early.
 */
export function lightboxJson(value: object): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
