import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PipelineConfig } from './config.ts';
import { configureSharp, encodeVariant } from './encode.ts';
import type { NormalisedImage } from './encode.ts';
import type { EncodeSpec, VariantPlan } from './recipe.ts';

configureSharp();

const CONFIG: PipelineConfig = {
  recipeVersion: 1,
  widths: [400, 800, 1200],
  kernel: 'lanczos3',
  avif: { quality: 55, effort: 4 },
  webp: { quality: 76, effort: 5 },
  jpeg: { quality: 80, widths: [1200] },
  og: { width: 1200, height: 630, quality: 82 },
  lqip: { width: 20, quality: 35 },
  cameraMetadata: true,
  copyright: null,
  r2: { bucket: 'photographs' },
  localPublishDir: 'site/public',
};

/** A flat mid-grey raw buffer — pixel content doesn't matter, only the dimensions being resized. */
function rawImage(width: number, height: number): NormalisedImage {
  const channels = 3;
  return {
    pixels: Buffer.alloc(width * height * channels, 128),
    width,
    height,
    channels,
    color: '#808080',
  };
}

/** A square width×width bounding box, exactly as planVariants builds one for a scaled tier. */
function scaledPlan(width: number): VariantPlan {
  const spec: EncodeSpec = {
    recipeVersion: 1,
    sourceId: '0123456789abcdef',
    kind: 'scaled',
    format: 'jpeg',
    width,
    height: null,
    quality: 80,
    effort: null,
    kernel: 'lanczos3',
    colorspace: 'srgb',
    orientation: 'applied',
    copyright: null,
  };
  return {
    kind: 'scaled',
    format: 'jpeg',
    width,
    height: width,
    key: `p/0123456789abcdef/${String(width)}-01234567.jpg`,
    spec,
  };
}

test('encodeVariant caps a portrait photograph by its long edge (height), not its width, with no padding', async () => {
  const source = rawImage(2000, 3000); // portrait, 2:3
  const encoded = await encodeVariant(source, scaledPlan(1200), CONFIG);
  assert.equal(encoded.height, 1200);
  assert.equal(encoded.width, 800); // 2000/3000 * 1200, aspect ratio exactly preserved
});

test('encodeVariant caps a landscape photograph by its long edge (width), with no padding', async () => {
  const source = rawImage(3000, 2000); // landscape, 3:2
  const encoded = await encodeVariant(source, scaledPlan(1200), CONFIG);
  assert.equal(encoded.width, 1200);
  assert.equal(encoded.height, 800);
});

test('encodeVariant never enlarges a source smaller than the requested tier', async () => {
  const source = rawImage(500, 400);
  const encoded = await encodeVariant(source, scaledPlan(1200), CONFIG);
  assert.equal(encoded.width, 500);
  assert.equal(encoded.height, 400);
});
