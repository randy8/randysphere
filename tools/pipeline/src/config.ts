import { pathToFileURL } from 'node:url';

import { PipelineError } from './errors.ts';

export interface PipelineConfig {
  /**
   * Bump by hand when you change encoder behaviour in a way that should
   * invalidate derivatives that are otherwise identically configured. Every
   * derivative key contains this number.
   */
  readonly recipeVersion: number;
  readonly widths: readonly number[];
  readonly kernel: 'nearest' | 'cubic' | 'mitchell' | 'lanczos2' | 'lanczos3';
  readonly avif: { readonly quality: number; readonly effort: number };
  readonly webp: { readonly quality: number; readonly effort: number };
  readonly jpeg: { readonly quality: number; readonly widths: readonly number[] };
  readonly og: { readonly width: number; readonly height: number; readonly quality: number };
  readonly lqip: { readonly width: number; readonly quality: number };
  /** Copy the allow-listed camera fields into the manifest. Never includes location. */
  readonly cameraMetadata: boolean;
  /**
   * When set, exactly these two values are written into each derivative's EXIF.
   * Nothing is ever copied from the original: the EXIF block is constructed
   * from scratch, which is why there is no way for location data to survive.
   */
  readonly copyright: { readonly artist: string; readonly notice: string } | null;
  readonly r2: { readonly bucket: string };
  /** Where `publish --local` writes derivatives, relative to the repository root. */
  readonly localPublishDir: string;
}

const SOURCE = 'pipeline.config.ts';

function fail(path: string, expectation: string, actual: unknown): never {
  throw new PipelineError(`${SOURCE}: ${path} ${expectation}, got ${JSON.stringify(actual) ?? 'undefined'}`);
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object', value);
  }
  return value as Record<string, unknown>;
}

function readInteger(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `must be a whole number between ${min} and ${max}`, value);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be true or false', value);
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string', value);
  return value;
}

function readWidths(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array of pixel widths', value);
  }
  const widths = value.map((entry, index) => readInteger(entry, `${path}[${index}]`, 16, 10000));
  const sorted = [...widths].sort((a, b) => a - b);
  const duplicate = sorted.find((width, index) => index > 0 && width === sorted[index - 1]);
  if (duplicate !== undefined) {
    throw new PipelineError(`${SOURCE}: ${path} lists ${duplicate} more than once`);
  }
  return sorted;
}

function readKernel(value: unknown, path: string): PipelineConfig['kernel'] {
  const allowed = ['nearest', 'cubic', 'mitchell', 'lanczos2', 'lanczos3'] as const;
  const found = allowed.find((kernel) => kernel === value);
  if (found === undefined) fail(path, `must be one of ${allowed.join(', ')}`, value);
  return found;
}

export function validateConfig(input: unknown): PipelineConfig {
  const root = readObject(input, 'the default export');

  const avif = readObject(root['avif'], 'avif');
  const webp = readObject(root['webp'], 'webp');
  const jpeg = readObject(root['jpeg'], 'jpeg');
  const og = readObject(root['og'], 'og');
  const lqip = readObject(root['lqip'], 'lqip');
  const r2 = readObject(root['r2'], 'r2');

  let copyright: PipelineConfig['copyright'] = null;
  if (root['copyright'] !== null && root['copyright'] !== undefined) {
    const value = readObject(root['copyright'], 'copyright');
    copyright = {
      artist: readString(value['artist'], 'copyright.artist'),
      notice: readString(value['notice'], 'copyright.notice'),
    };
  }

  const config: PipelineConfig = {
    recipeVersion: readInteger(root['recipeVersion'], 'recipeVersion', 1, 1_000_000),
    widths: readWidths(root['widths'], 'widths'),
    kernel: readKernel(root['kernel'], 'kernel'),
    avif: {
      quality: readInteger(avif['quality'], 'avif.quality', 1, 100),
      effort: readInteger(avif['effort'], 'avif.effort', 0, 9),
    },
    webp: {
      quality: readInteger(webp['quality'], 'webp.quality', 1, 100),
      effort: readInteger(webp['effort'], 'webp.effort', 0, 6),
    },
    jpeg: {
      quality: readInteger(jpeg['quality'], 'jpeg.quality', 1, 100),
      widths: readWidths(jpeg['widths'], 'jpeg.widths'),
    },
    og: {
      width: readInteger(og['width'], 'og.width', 200, 4000),
      height: readInteger(og['height'], 'og.height', 200, 4000),
      quality: readInteger(og['quality'], 'og.quality', 1, 100),
    },
    lqip: {
      width: readInteger(lqip['width'], 'lqip.width', 8, 64),
      quality: readInteger(lqip['quality'], 'lqip.quality', 1, 100),
    },
    cameraMetadata: readBoolean(root['cameraMetadata'], 'cameraMetadata'),
    copyright,
    r2: { bucket: readString(r2['bucket'], 'r2.bucket') },
    localPublishDir: readString(root['localPublishDir'], 'localPublishDir'),
  };

  const widest = config.widths.at(-1) ?? 0;
  const widestJpeg = config.jpeg.widths.at(-1) ?? 0;
  if (widestJpeg > widest) {
    throw new PipelineError(
      `${SOURCE}: jpeg.widths includes ${widestJpeg}, which is wider than the widest entry in widths (${widest}). ` +
        'The JPEG set is meant to be a subset of the responsive widths.',
    );
  }

  return config;
}

export async function loadConfig(configFile: string): Promise<PipelineConfig> {
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(configFile).href)) as { default?: unknown };
  } catch (cause) {
    throw new PipelineError(
      `Could not load ${configFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  if (module.default === undefined) {
    throw new PipelineError(`${configFile} must have a default export.`);
  }
  return validateConfig(module.default);
}
