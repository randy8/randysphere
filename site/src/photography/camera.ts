import type { ArchivePhoto } from './archive.ts';

/**
 * "Leica M6 · 50mm · f/2.8 · 1/250 · ISO 400 · Rue de Bretagne, Paris" — a
 * single quiet line joining whatever EXIF the pipeline captured plus a
 * hand-written location, every piece individually optional. Returns null
 * rather than an empty string so a caller can cleanly omit the line.
 */
export function formatCameraLine(entry: ArchivePhoto): string | null {
  const { camera } = entry.photo;
  const parts = [
    camera && [camera.make, camera.model].filter(Boolean).join(' ').trim(),
    camera?.lens,
    camera?.focalLength !== null && camera?.focalLength !== undefined
      ? `${String(camera.focalLength)}mm`
      : null,
    camera?.aperture !== null && camera?.aperture !== undefined
      ? `f/${String(camera.aperture)}`
      : null,
    camera?.shutterSpeed,
    camera?.iso !== null && camera?.iso !== undefined ? `ISO ${String(camera.iso)}` : null,
    entry.location,
  ].filter((part): part is string => Boolean(part && part.length > 0));
  return parts.length > 0 ? parts.join(' · ') : null;
}
