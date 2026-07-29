import assert from 'node:assert/strict';
import { test } from 'node:test';

import { selectCameraMetadata } from './camera-metadata.ts';

/** Shaped like what an EXIF parser returns for a real photograph. */
const parsed = {
  Image: { Make: 'Fujifilm  ', Model: 'X-Pro3', Orientation: 6, Artist: 'someone', Copyright: 'x' },
  Photo: {
    LensModel: 'XF35mmF2 R WR',
    FocalLength: 35,
    FNumber: 2,
    ExposureTime: 0.002,
    ISOSpeedRatings: 160,
    DateTimeOriginal: new Date(Date.UTC(2024, 1, 11, 8, 14, 23)),
    UserComment: 'private note',
  },
  GPSInfo: {
    GPSLatitude: [43, 3, 43.2],
    GPSLatitudeRef: 'N',
    GPSLongitude: [141, 20, 59.9],
    GPSLongitudeRef: 'E',
    GPSAltitude: 17,
  },
  ThumbnailTags: { JPEGInterchangeFormat: 1000 },
};

test('only the eight allow-listed fields come through', () => {
  const metadata = selectCameraMetadata(parsed);
  assert.deepEqual(Object.keys(metadata ?? {}).sort(), [
    'aperture',
    'focalLength',
    'iso',
    'lens',
    'make',
    'model',
    'shutterSpeed',
    'takenAt',
  ]);
});

test('no location value survives, in any form', () => {
  // The one property in this pipeline that can tell a stranger where somebody
  // lives. Serialised and searched rather than key-checked, so that a nested
  // leak would still fail this.
  const serialised = JSON.stringify(selectCameraMetadata(parsed));
  for (const forbidden of ['GPS', 'Latitude', 'Longitude', 'Altitude', '43', '141', '17']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}: ${serialised}`);
  }
});

test('unlisted fields are dropped even when they look harmless', () => {
  const serialised = JSON.stringify(selectCameraMetadata(parsed));
  for (const forbidden of ['Artist', 'someone', 'UserComment', 'private note', 'Orientation']) {
    assert.equal(serialised.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test('a parser that returns something unexpected yields null rather than throwing', () => {
  for (const input of [null, undefined, 'nonsense', 42, [], { Image: 'not an object' }]) {
    assert.doesNotThrow(() => selectCameraMetadata(input));
  }
  assert.equal(selectCameraMetadata(null), null);
  assert.equal(selectCameraMetadata({}), null);
  assert.equal(selectCameraMetadata({ Image: {}, Photo: {} }), null);
});

test('shutter speeds are written the way photographers read them', () => {
  const shutter = (seconds: unknown): string | null =>
    selectCameraMetadata({ Photo: { ExposureTime: seconds } })?.shutterSpeed ?? null;

  assert.equal(shutter(0.002), '1/500');
  assert.equal(shutter(1 / 60), '1/60');
  assert.equal(shutter(4), '4s');
  assert.equal(shutter(2.5), '2.5s');
  assert.equal(shutter(0), null);
  assert.equal(shutter('1/500'), null);
});

test('the capture time is the camera clock, recorded verbatim', () => {
  const metadata = selectCameraMetadata(parsed);
  assert.equal(metadata?.takenAt, '2024-02-11T08:14:23');
});

test('ISO written as a single element array is read', () => {
  assert.equal(selectCameraMetadata({ Photo: { ISOSpeedRatings: [800] } })?.iso, 800);
});

test('surrounding whitespace in maker strings is trimmed', () => {
  assert.equal(selectCameraMetadata(parsed)?.make, 'Fujifilm');
});
