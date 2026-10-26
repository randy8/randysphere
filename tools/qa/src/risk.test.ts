import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AREAS, classify } from './risk.ts';

test('documentation alone is low risk and runs no area tests (the smoke suite still runs)', () => {
  const result = classify(['docs/decisions.md', 'CHANGELOG.md', 'site/README.md']);
  assert.equal(result.risk, 'low');
  assert.deepEqual(result.areas, []);
});

test('an isolated non-photo collection change stays low', () => {
  assert.equal(classify(['site/src/recipes/recipe.ts', 'recipes/soup.yaml']).risk, 'low');
});

test('the lightbox is medium and runs only its own area', () => {
  const result = classify(['site/src/photography/zoom.ts']);
  assert.equal(result.risk, 'medium');
  assert.deepEqual(result.areas, ['lightbox']);
});

test('the grid runs the gallery and the lightbox, which opens from it', () => {
  assert.deepEqual(classify(['site/src/photography/grid-layout.js']).areas, [
    'gallery',
    'lightbox',
  ]);
});

test('Exhibition is high risk', () => {
  const result = classify(['site/src/photography/exhibition.ts']);
  assert.equal(result.risk, 'high');
  assert.deepEqual(result.areas, ['exhibition']);
});

test('the server, deployment, dependencies and shared photo data run everything', () => {
  for (const path of [
    'tools/serve/src/server.ts',
    'deploy/deploy.sh',
    'pnpm-lock.yaml',
    'site/astro.config.mjs',
    'site/src/photography/image.ts',
    'site/src/styles/base.css',
  ]) {
    assert.deepEqual(classify([path]).areas, AREAS, path);
  }
  assert.equal(classify(['tools/serve/src/server.ts']).risk, 'high');
});

test('an unrecognised path is high risk and runs everything', () => {
  const result = classify(['somewhere/new.ts']);
  assert.equal(result.risk, 'high');
  assert.deepEqual(result.areas, AREAS);
  assert.match(result.reasons[0] ?? '', /no rule recognises/);
});

test('the highest path decides: docs plus a server change is high', () => {
  assert.equal(classify(['docs/deployment.md', 'tools/serve/src/health.ts']).risk, 'high');
});

test('a markdown file anywhere, even in a high-risk directory, is documentation', () => {
  assert.equal(classify(['tools/serve/README.md']).risk, 'low');
});

test('every reason names its path and why', () => {
  const result = classify(['site/src/photography/lightbox.ts', 'mystery']);
  assert.equal(result.reasons.length, 2);
  assert.match(result.reasons[0] ?? '', /lightbox\.ts — the lightbox/);
});
