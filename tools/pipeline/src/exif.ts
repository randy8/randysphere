import exifReader from 'exif-reader';

export type { CameraMetadata } from './camera-metadata.ts';
export { selectCameraMetadata } from './camera-metadata.ts';

/**
 * The whole surface of the EXIF parser dependency, in one function.
 *
 * The allow-list that decides what may reach a published page lives in
 * camera-metadata.ts and imports nothing, so it can be tested — including the
 * fact that it drops location data — without installing anything.
 *
 * Malformed EXIF is common and never worth failing an ingest over: the
 * photograph is the point, the camera model is a caption.
 */
export function parseExif(block: Uint8Array | undefined): unknown {
  if (block === undefined || block.length === 0) return null;
  try {
    return exifReader(Buffer.from(block));
  } catch {
    return null;
  }
}
