import type { PipelineConfig } from './tools/pipeline/src/config.ts';

/**
 * Every knob the image pipeline has. Changing anything here changes the digest
 * in the affected derivative keys, so the next `pnpm ingest` re-encodes exactly
 * what the change touched and leaves everything else alone.
 *
 * Credentials are not here. R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and
 * R2_SECRET_ACCESS_KEY belong in .env, which is git-ignored.
 */
const config: PipelineConfig = {
  /**
   * Bump this to force a re-encode when nothing else here changed — for
   * example after a sharp upgrade you want to take advantage of. It is the one
   * deliberate escape hatch from content addressing.
   *
   * Bumped to 2: encodeVariant's scaled resize used to constrain only by
   * width, so a portrait photograph's long edge (its height) was never
   * capped by a size tier at all. The digest doesn't encode *how* a resize
   * was computed, only the tier number, so this bump is the only way to
   * invalidate the existing (incorrectly-sized) portrait derivatives.
   */
  recipeVersion: 2,

  /**
   * Widths offered in srcset, in CSS pixels, up through a 2x-3840 desktop/
   * Retina full-bleed — this is a fidelity-first archive, not a bandwidth-
   * constrained feed, so the top end is sized for how large the browse view
   * actually renders a photograph (`sizes="100vw"`) on a large or Retina
   * display, not for the smallest acceptable download. Widths larger than a
   * given photograph are skipped automatically, so small scans do not
   * produce upscaled files.
   */
  widths: [400, 800, 1200, 1600, 2000, 2400, 3200, 3840],

  /** Lanczos3 is the sharpest of the available resamplers and the usual choice for photographs. */
  kernel: 'lanczos3',

  /**
   * AVIF is what almost every visitor will actually download, and image
   * fidelity is the priority here over minimum file size: quality 82 is well
   * into the range that holds up film grain, fine texture, and subtle
   * gradients rather than smoothing them away.
   *
   * Effort stays at sharp's default of 4, not higher: effort trades encode
   * time for a few percent off the file size at the *same* quality — it does
   * not affect fidelity. Effort 6 was tried first and measured in practice
   * at well over 3 hours for this collection's few hundred photographs
   * without finishing, for a saving nobody would ever see; 4 is the actual
   * bad trade 9 was already called out as being, just arrived at by
   * measuring rather than assuming.
   */
  avif: { quality: 82, effort: 4 },

  /** The fallback for anything without AVIF, held to a similarly high quality rather than a bandwidth-optimised one. */
  webp: { quality: 90, effort: 5 },

  /**
   * A genuine legacy fallback, not a primary path, so only two widths: one for
   * normal viewing and one for the lightbox and the no-JavaScript "open the
   * photograph" link — but that second one now matches the top of `widths`,
   * since it is also what a non-AVIF/WebP browser's fullscreen view opens.
   */
  jpeg: { quality: 90, widths: [1200, 3840] },

  /**
   * Open Graph images are crops of the photograph with no text on them, which
   * is why this needs no font rendering and no headless browser. JPEG because
   * social media scrapers are the least capable image clients on the internet.
   */
  og: { width: 1200, height: 630, quality: 82 },

  /**
   * The inline placeholder, used only for the image a page treats as its
   * largest paint. 20px wide lands around 250 bytes of base64.
   */
  lqip: { width: 20, quality: 35 },

  /**
   * Copies the eight allow-listed camera fields into the manifest. There is no
   * setting that adds location: it is not in the allow-list and cannot be.
   */
  cameraMetadata: true,

  /**
   * When set, exactly these two values are written into each derivative's EXIF.
   * Nothing is copied from the original — the block is built from scratch — so
   * turning this on cannot leak anything you did not type here.
   *
   * Example: { artist: 'Ansel Adams', notice: '© 2026 Ansel Adams' }
   */
  copyright: null,

  r2: { bucket: 'photographs' },

  /**
   * Where `pnpm run publish --local` writes instead of uploading. Keys begin
   * with `p/`, so derivatives land at site/public/p/... and are served from
   * /p/... by the site itself.
   */
  localPublishDir: 'site/public',
};

export default config;
