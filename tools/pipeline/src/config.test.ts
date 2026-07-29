import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateConfig } from './config.ts';

const valid = {
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

test('a valid configuration passes and comes back sorted', () => {
  const config = validateConfig({ ...valid, widths: [1200, 400, 800] });
  assert.deepEqual(config.widths, [400, 800, 1200]);
});

test('errors name the setting, the expectation, and what was actually there', () => {
  assert.throws(
    () => validateConfig({ ...valid, avif: { quality: 'high', effort: 4 } }),
    /pipeline\.config\.ts: avif\.quality must be a whole number between 1 and 100, got "high"/,
  );
  assert.throws(
    () => validateConfig({ ...valid, widths: [400, '800'] }),
    /widths\[1\] must be a whole number/,
  );
  assert.throws(() => validateConfig({ ...valid, kernel: 'bilinear' }), /kernel must be one of/);
});

test('a duplicated width is caught, because it would mean two identical variants', () => {
  assert.throws(() => validateConfig({ ...valid, widths: [400, 800, 400] }), /lists 400 more than once/);
});

test('a JPEG width wider than every responsive width is caught', () => {
  assert.throws(
    () => validateConfig({ ...valid, jpeg: { quality: 80, widths: [4000] } }),
    /wider than the widest entry in widths/,
  );
});

test('copyright is either absent or complete', () => {
  assert.equal(validateConfig(valid).copyright, null);
  assert.throws(
    () => validateConfig({ ...valid, copyright: { artist: 'A' } }),
    /copyright\.notice must be a non-empty string/,
  );
  assert.deepEqual(validateConfig({ ...valid, copyright: { artist: 'A', notice: 'N' } }).copyright, {
    artist: 'A',
    notice: 'N',
  });
});

test("this repository's own pipeline.config.ts is valid", async () => {
  // Catches a broken config in CI rather than three minutes into an ingest.
  const module = (await import('../../../pipeline.config.ts')) as { default: unknown };
  assert.doesNotThrow(() => validateConfig(module.default));
});
