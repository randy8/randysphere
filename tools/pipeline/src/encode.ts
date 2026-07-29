import sharp from 'sharp';

import { averageColorHex } from './color.ts';
import type { PipelineConfig } from './config.ts';
import { PipelineError } from './errors.ts';
import type { Dimensions } from './orientation.ts';
import { displayedDimensions } from './orientation.ts';
import type { VariantPlan } from './recipe.ts';

/**
 * libvips parallelises inside a single operation, and the pipeline
 * parallelises across photographs. Doing both oversubscribes the machine and
 * makes everything slower, so the inner parallelism is switched off and the
 * outer one is the only knob.
 */
export function configureSharp(): void {
  sharp.concurrency(1);
  sharp.cache(false);
}

export interface SourceInspection {
  readonly displayed: Dimensions;
  readonly exif: Uint8Array | undefined;
}

/**
 * Reads the header only. Cheap enough to run over every photograph on every
 * ingest, which is what makes it possible to plan variants before deciding
 * whether a decode is needed at all.
 */
export async function inspectSource(file: string): Promise<SourceInspection> {
  try {
    const metadata = await sharp(file, { failOn: 'error' }).metadata();
    const { width, height, orientation, exif } = metadata;
    if (width === undefined || height === undefined) {
      throw new PipelineError(`${file}: no image dimensions. Is this actually an image?`);
    }
    return { displayed: displayedDimensions({ width, height }, orientation), exif };
  } catch (cause) {
    if (cause instanceof PipelineError) throw cause;
    throw new PipelineError(
      `${file}: could not be read as an image (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
  }
}

export interface NormalisedImage {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly color: string;
}

/**
 * Decode once, orient once, convert once.
 *
 * Every derivative is then produced from this buffer instead of reopening the
 * original, which turns fifteen full decodes per photograph into one. The cost
 * is a two-step downscale for the smallest sizes; with lanczos3 the difference
 * is not visible, and the first ingest of a large collection finishes in a
 * fifth of the time.
 */
export async function normalise(
  file: string,
  config: PipelineConfig,
  maximumWidth: number,
): Promise<NormalisedImage> {
  const { data, info } = await sharp(file, { failOn: 'error' })
    // No arguments: apply the EXIF orientation and discard it. Everything
    // downstream, including the dimensions in the manifest, is post-rotation.
    .rotate()
    // Photographs do not have transparency, and flattening here means the raw
    // buffer is always three channels.
    .flatten({ background: '#ffffff' })
    // Converts a wide-gamut original into sRGB using its embedded profile.
    // Not attached to the output: browsers assume sRGB, and a 3 KB profile on
    // a 9 KB thumbnail is a third of the file for no visible benefit.
    .withIccProfile('srgb', { attach: false })
    .resize({
      width: maximumWidth,
      withoutEnlargement: true,
      fit: 'inside',
      kernel: config.kernel,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    color: averageColorHex(data, info.channels),
  };
}

function openNormalised(base: NormalisedImage): sharp.Sharp {
  return sharp(base.pixels, {
    raw: { width: base.width, height: base.height, channels: base.channels as 1 | 2 | 3 | 4 },
  });
}

/**
 * Only ever constructs an EXIF block; never copies one. This is the reason
 * there is no path by which a GPS tag can reach a published file.
 */
function applyMetadata(image: sharp.Sharp, config: PipelineConfig): sharp.Sharp {
  if (config.copyright === null) return image;
  return image.withExif({
    IFD0: { Copyright: config.copyright.notice, Artist: config.copyright.artist },
  });
}

export interface EncodedVariant {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export async function encodeVariant(
  base: NormalisedImage,
  plan: VariantPlan,
  config: PipelineConfig,
): Promise<EncodedVariant> {
  let image = openNormalised(base);

  image =
    plan.kind === 'og'
      ? image.resize({
          width: plan.width,
          height: plan.height,
          fit: 'cover',
          position: 'attention',
          kernel: config.kernel,
        })
      : image.resize({
          width: plan.width,
          withoutEnlargement: true,
          fit: 'inside',
          kernel: config.kernel,
        });

  image = applyMetadata(image, config);

  switch (plan.format) {
    case 'avif':
      image = image.avif({ quality: config.avif.quality, effort: config.avif.effort });
      break;
    case 'webp':
      image = image.webp({ quality: config.webp.quality, effort: config.webp.effort });
      break;
    case 'jpeg':
      image = image.jpeg({ quality: config.jpeg.quality, progressive: true, mozjpeg: true });
      break;
  }

  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: data.byteLength };
}

/**
 * A placeholder small enough to inline in markup. Used only for the image the
 * page treats as its largest paint; everywhere else the average colour is both
 * cheaper and calmer to look at.
 */
export async function encodeLqip(base: NormalisedImage, config: PipelineConfig): Promise<string> {
  const data = await openNormalised(base)
    .resize({ width: config.lqip.width, fit: 'inside', kernel: 'cubic' })
    .webp({ quality: config.lqip.quality, effort: 6 })
    .toBuffer();
  return `data:image/webp;base64,${data.toString('base64')}`;
}
