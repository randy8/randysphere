import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatCameraLine } from './camera.ts';
import type { ArchivePhoto } from './archive.ts';
import type { Camera, Photo, Variant } from './manifest.ts';

const VARIANT: Variant = {
  format: 'avif',
  width: 400,
  height: 267,
  bytes: 1000,
  key: 'p/aaaaaaaaaaaaaaaa/400-11111111.avif',
};

function camera(overrides: Partial<Camera> = {}): Camera {
  return {
    make: null,
    model: null,
    lens: null,
    focalLength: null,
    aperture: null,
    shutterSpeed: null,
    iso: null,
    takenAt: null,
    ...overrides,
  };
}

function entry(overrides: { camera?: Camera | null; location?: string | null } = {}): ArchivePhoto {
  const photo: Photo = {
    file: '001.tif',
    roll: '0827',
    sourceId: '001.tif',
    width: 1800,
    height: 1200,
    color: '#6b7a82',
    lqip: 'data:image/webp;base64,AAAA',
    camera: overrides.camera === undefined ? null : overrides.camera,
    variants: [VARIANT],
    og: VARIANT,
  };
  return {
    photo,
    batch: 'test-batch',
    roll: { id: '0827', photoCount: 1, filmStock: '', notes: '', date: null },
    frame: 1,
    tags: [],
    alt: '',
    caption: null,
    location: overrides.location ?? null,
    featured: false,
    featuredOrder: null,
    cover: false,
  };
}

test('formatCameraLine returns null when there is no camera and no location', () => {
  assert.equal(formatCameraLine(entry()), null);
});

test('formatCameraLine joins every field with the camera present', () => {
  const line = formatCameraLine(
    entry({
      camera: camera({
        make: 'Leica',
        model: 'M6',
        lens: '50mm Summicron',
        focalLength: 50,
        aperture: 2.8,
        shutterSpeed: '1/250',
        iso: 400,
      }),
      location: 'Rue de Bretagne, Paris',
    }),
  );
  assert.equal(
    line,
    'Leica M6 · 50mm Summicron · 50mm · f/2.8 · 1/250 · ISO 400 · Rue de Bretagne, Paris',
  );
});

test('formatCameraLine omits missing fields cleanly, without stray separators', () => {
  const line = formatCameraLine(entry({ camera: camera({ make: 'Leica', model: 'M6' }) }));
  assert.equal(line, 'Leica M6');
});

test('formatCameraLine shows just the location when there is no camera data at all', () => {
  const line = formatCameraLine(entry({ location: 'Rue de Bretagne, Paris' }));
  assert.equal(line, 'Rue de Bretagne, Paris');
});
