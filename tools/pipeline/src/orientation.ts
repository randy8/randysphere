export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * EXIF orientation 5 through 8 describe a quarter-turn, which means the pixel
 * dimensions stored in the file are transposed relative to how the photograph
 * is meant to be seen.
 *
 * Derivatives are written with the rotation baked in and the EXIF discarded, so
 * every dimension the manifest reports has to be the displayed one. Getting
 * this wrong ships portrait photographs in landscape boxes, which is both ugly
 * and a layout shift.
 */
export function isQuarterTurn(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8;
}

export function displayedDimensions(
  stored: Dimensions,
  orientation: number | undefined,
): Dimensions {
  return isQuarterTurn(orientation)
    ? { width: stored.height, height: stored.width }
    : { width: stored.width, height: stored.height };
}

/** Height of a variant scaled to `width`, matching how the encoder rounds. */
export function scaledHeight(source: Dimensions, width: number): number {
  return Math.max(1, Math.round((width * source.height) / source.width));
}

/**
 * A photographer-chosen quarter turn, clockwise, applied on top of whatever
 * EXIF orientation the original already carries — `rotate:` in photos.yaml.
 * Exists for scans, which arrive with no orientation tag at all and are as
 * often sideways as not. The original is never touched; the turn is baked
 * into the derivatives only.
 */
export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export function isRotation(value: unknown): value is Rotation {
  return ROTATIONS.includes(value as Rotation);
}

/** `displayed` after a further clockwise `rotate` — a quarter turn swaps the edges. */
export function rotatedDimensions(displayed: Dimensions, rotate: Rotation): Dimensions {
  return rotate === 90 || rotate === 270
    ? { width: displayed.height, height: displayed.width }
    : displayed;
}
