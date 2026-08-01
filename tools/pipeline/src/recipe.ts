import type { PipelineConfig } from './config.ts';
import { canonicalJson, sha256Hex } from './hash.ts';
import type { Dimensions } from './orientation.ts';
import { scaledHeight } from './orientation.ts';

export type VariantFormat = 'avif' | 'webp' | 'jpeg';

export const FILE_EXTENSION: Record<VariantFormat, string> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
};

export const CONTENT_TYPE: Record<VariantFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};

export const SOURCE_ID_LENGTH = 16;
export const VARIANT_DIGEST_LENGTH = 8;

/**
 * Every derivative key matches this, and nothing else is ever written.
 *
 * The restriction is load bearing in two places: it keeps keys safe to join
 * onto a filesystem path in local publishing mode, and it means the S3 list
 * response can be read without an XML parser, because no key can ever contain
 * a character that XML escapes.
 */
export const KEY_PATTERN = /^p\/[0-9a-f]{16}\/(?:\d{2,5}|og)-[0-9a-f]{8}\.(?:avif|webp|jpg)$/;

export function isDerivativeKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/**
 * Exactly what determines the bytes of one derivative. This object is the input
 * to the digest in its key, so adding a field here invalidates every key that
 * the new field affects, and nothing else.
 *
 * Deliberately absent: the sharp and libvips versions. Including them would
 * move every URL on the site whenever a patch release landed. Content
 * addressing here expresses our declared encoding intent, not bit-exact
 * reproducibility across encoder releases.
 */
export type EncodeSpec = {
  readonly recipeVersion: number;
  readonly sourceId: string;
  readonly kind: 'scaled' | 'og';
  readonly format: VariantFormat;
  readonly width: number;
  readonly height: number | null;
  readonly quality: number;
  readonly effort: number | null;
  readonly kernel: string;
  readonly colorspace: string;
  readonly orientation: 'applied';
  readonly copyright: { readonly artist: string; readonly notice: string } | null;
};

export interface VariantPlan {
  readonly kind: 'scaled' | 'og';
  readonly format: VariantFormat;
  readonly width: number;
  readonly height: number;
  readonly key: string;
  readonly spec: EncodeSpec;
}

export function variantDigest(spec: EncodeSpec): string {
  return sha256Hex(canonicalJson(spec)).slice(0, VARIANT_DIGEST_LENGTH);
}

function buildKey(sourceId: string, label: string, digest: string, format: VariantFormat): string {
  return `p/${sourceId}/${label}-${digest}.${FILE_EXTENSION[format]}`;
}

/**
 * Widths worth encoding for a source of this size.
 *
 * Configured widths larger than the source are dropped, because enlarging a
 * photograph produces a file that is bigger in bytes and no better to look at,
 * and because two variants that resolve to the same pixel width make a
 * nonsense of a srcset. If the source is not already covered, its native width
 * is added so the largest offering is the best available.
 */
export function usableWidths(configured: readonly number[], sourceWidth: number): number[] {
  const widest = Math.max(...configured);
  const widths = configured.filter((width) => width <= sourceWidth).sort((a, b) => a - b);

  // Only when the photograph is smaller than the largest size we would normally
  // offer is its native width added, so that the best available is on offer.
  // For a source larger than the configured range this must not fire: adding
  // the native width there would publish a full resolution copy of every
  // photograph, which is both enormous and precisely what we do not want.
  if (sourceWidth < widest && !widths.includes(sourceWidth)) {
    widths.push(sourceWidth);
  }
  return widths;
}

export function planVariants(
  sourceId: string,
  source: Dimensions,
  config: PipelineConfig,
): VariantPlan[] {
  const plans: VariantPlan[] = [];

  const formats: {
    format: VariantFormat;
    widths: readonly number[];
    quality: number;
    effort: number | null;
  }[] = [
    {
      format: 'avif',
      widths: config.widths,
      quality: config.avif.quality,
      effort: config.avif.effort,
    },
    {
      format: 'webp',
      widths: config.widths,
      quality: config.webp.quality,
      effort: config.webp.effort,
    },
    { format: 'jpeg', widths: config.jpeg.widths, quality: config.jpeg.quality, effort: null },
  ];

  for (const { format, widths, quality, effort } of formats) {
    for (const width of usableWidths(widths, source.width)) {
      const height = scaledHeight(source, width);
      const spec: EncodeSpec = {
        recipeVersion: config.recipeVersion,
        sourceId,
        kind: 'scaled',
        format,
        width,
        height: null,
        quality,
        effort,
        kernel: config.kernel,
        colorspace: 'srgb',
        orientation: 'applied',
        copyright: config.copyright,
      };
      plans.push({
        kind: 'scaled',
        format,
        width,
        height,
        key: buildKey(sourceId, String(width), variantDigest(spec), format),
        spec,
      });
    }
  }

  return plans;
}

export function planOpenGraph(sourceId: string, config: PipelineConfig): VariantPlan {
  const spec: EncodeSpec = {
    recipeVersion: config.recipeVersion,
    sourceId,
    kind: 'og',
    format: 'jpeg',
    width: config.og.width,
    height: config.og.height,
    quality: config.og.quality,
    effort: null,
    kernel: config.kernel,
    colorspace: 'srgb',
    orientation: 'applied',
    copyright: config.copyright,
  };
  return {
    kind: 'og',
    format: 'jpeg',
    width: config.og.width,
    height: config.og.height,
    key: buildKey(sourceId, 'og', variantDigest(spec), 'jpeg'),
    spec,
  };
}
