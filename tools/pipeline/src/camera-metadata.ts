/**
 * The complete set of camera fields that can ever reach the manifest or the
 * website. There is no configuration option that extends it.
 *
 * This is an allow-list rather than a deny-list on purpose. Location data hides
 * in more places than most people expect — the GPS IFD, XMP packets, and vendor
 * maker notes all carry it — so a deny-list leaks the first time a firmware
 * update invents a tag nobody has heard of. Nothing is copied out of the
 * original except the eight values named below.
 */
export interface CameraMetadata {
  readonly make: string | null;
  readonly model: string | null;
  readonly lens: string | null;
  /** Millimetres, as recorded. Not corrected to a 35mm equivalent. */
  readonly focalLength: number | null;
  /** The f-number, so 2.8 rather than the string "f/2.8". */
  readonly aperture: number | null;
  /** Conventional photographic form: "1/500", or "4s" for long exposures. */
  readonly shutterSpeed: string | null;
  readonly iso: number | null;
  /**
   * The camera's own clock, verbatim. EXIF carries no time zone, so this is a
   * wall-clock reading and not an instant. Never treat it as UTC.
   */
  readonly takenAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Some bodies write ISO as a single-element array.
  if (Array.isArray(value)) return asFiniteNumber(value[0]);
  return null;
}

function formatShutterSpeed(seconds: unknown): string | null {
  const value = asFiniteNumber(seconds);
  if (value === null || value <= 0) return null;
  if (value >= 1) {
    return `${Number(value.toFixed(1)).toString()}s`;
  }
  return `1/${Math.round(1 / value).toString()}`;
}

function formatTakenAt(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  // exif-reader builds the Date from the file's literal digits treated as UTC,
  // so reading it back out in UTC returns exactly what the camera wrote.
  return value.toISOString().slice(0, 19);
}

/**
 * Pure. Takes whatever an EXIF parser produced and returns only the allowed
 * fields. Kept separate from the parser so that the allow-list — the one piece
 * of this pipeline that can leak where somebody lives — is testable on its own.
 */
export function selectCameraMetadata(parsed: unknown): CameraMetadata | null {
  const root = asRecord(parsed);
  if (root === null) return null;

  const image = asRecord(root['Image']) ?? {};
  const photo = asRecord(root['Photo']) ?? {};

  const metadata: CameraMetadata = {
    make: asTrimmedString(image['Make']),
    model: asTrimmedString(image['Model']),
    lens: asTrimmedString(photo['LensModel']),
    focalLength: asFiniteNumber(photo['FocalLength']),
    aperture: asFiniteNumber(photo['FNumber']),
    shutterSpeed: formatShutterSpeed(photo['ExposureTime']),
    iso: asFiniteNumber(photo['ISOSpeedRatings']),
    takenAt: formatTakenAt(photo['DateTimeOriginal']),
  };

  const hasAnything = Object.values(metadata).some((field) => field !== null);
  return hasAnything ? metadata : null;
}
