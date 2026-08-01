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
