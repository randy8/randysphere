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
   */
  recipeVersion: 1,

  /**
   * Widths offered in srcset, in CSS pixels. Six covers phones through to a
   * 2x desktop full-bleed; more would mean more encoding for differences no
   * one can see. Widths larger than a given photograph are skipped
   * automatically, so small scans do not produce upscaled files.
   */
  widths: [400, 800, 1200, 1600, 2000, 2400],

  /** Lanczos3 is the sharpest of the available resamplers and the usual choice for photographs. */
  kernel: 'lanczos3',

  /**
   * AVIF is what almost every visitor will actually download. Quality 55 in
   * AVIF is roughly comparable to JPEG 80 and lands far smaller. Effort 4 is
   * sharp's default; 9 is perhaps 8% smaller for several times the encode
   * time, which is a bad trade on a collection of a few thousand.
   */
  avif: { quality: 55, effort: 4 },

  /** The fallback for anything without AVIF. Effort 5 of 6 is nearly free. */
  webp: { quality: 76, effort: 5 },

  /**
   * A genuine legacy fallback, not a primary path, so only two widths: one for
   * normal viewing and one for the lightbox and the no-JavaScript "open the
   * photograph" link.
   */
  jpeg: { quality: 80, widths: [1200, 2400] },

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
