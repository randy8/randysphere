import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PipelineConfig } from './config.ts';
import { isDerivativeKey, planOpenGraph, planVariants, usableWidths } from './recipe.ts';

const base: PipelineConfig = {
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

const SOURCE_ID = '0123456789abcdef';
const large = { width: 6000, height: 4000 };

function keysFor(config: PipelineConfig): string[] {
  return planVariants(SOURCE_ID, large, config)
    .map((plan) => plan.key)
    .sort();
}

test('every generated key matches the published key pattern', () => {
  for (const key of [...keysFor(base), planOpenGraph(SOURCE_ID, base).key]) {
    assert.ok(isDerivativeKey(key), `${key} does not match KEY_PATTERN`);
  }
});

test('planning is deterministic', () => {
  assert.deepEqual(keysFor(base), keysFor(base));
});

test('changing one format re-keys only that format', () => {
  const before = planVariants(SOURCE_ID, large, base);
  const after = planVariants(SOURCE_ID, large, { ...base, avif: { quality: 40, effort: 4 } });

  const changed = after.filter((plan, index) => plan.key !== before[index]?.key);
  assert.ok(changed.length > 0, 'changing AVIF quality must change AVIF keys');
  assert.ok(
    changed.every((plan) => plan.format === 'avif'),
    'only AVIF keys may change when only AVIF quality changed',
  );
});

test('bumping recipeVersion re-keys everything', () => {
  const before = keysFor(base);
  const after = keysFor({ ...base, recipeVersion: 2 });
  assert.equal(before.length, after.length);
  assert.equal(before.filter((key) => after.includes(key)).length, 0);
});

test('turning on a copyright notice re-keys everything, because the bytes change', () => {
  const after = keysFor({ ...base, copyright: { artist: 'A', notice: '(c) A' } });
  assert.equal(keysFor(base).filter((key) => after.includes(key)).length, 0);
});

test('two photographs with identical content share their derivatives', () => {
  // Content addressing means the same file in two albums is encoded and stored
  // once. Nothing special implements this; it falls out of the key scheme.
  assert.deepEqual(keysFor(base), keysFor(base));
  const other = planVariants('fedcba9876543210', large, base).map((plan) => plan.key);
  assert.equal(keysFor(base).filter((key) => other.includes(key)).length, 0);
});

test('widths wider than the source are dropped, and the native width is offered', () => {
  assert.deepEqual(usableWidths([400, 800, 1200, 2400], 6000), [400, 800, 1200, 2400]);
  assert.deepEqual(usableWidths([400, 800, 1200, 2400], 1500), [400, 800, 1200, 1500]);
  assert.deepEqual(usableWidths([400, 800], 300), [300]);
  assert.deepEqual(usableWidths([400, 800, 1200], 1200), [400, 800, 1200]);
});

test('a small source never yields two variants of the same width', () => {
  const plans = planVariants(SOURCE_ID, { width: 900, height: 600 }, base);
  for (const format of ['avif', 'webp', 'jpeg'] as const) {
    const widths = plans.filter((plan) => plan.format === format).map((plan) => plan.width);
    assert.equal(
      new Set(widths).size,
      widths.length,
      `duplicate ${format} widths: ${widths.join()}`,
    );
  }
});

test('open graph crops are keyed separately from the responsive set', () => {
  const og = planOpenGraph(SOURCE_ID, base);
  assert.equal(og.format, 'jpeg');
  assert.ok(og.key.includes('/og-'));
  assert.equal(keysFor(base).includes(og.key), false);
});
