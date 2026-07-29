/**
 * Mean colour of raw interleaved RGB pixels, as a hex string.
 *
 * The mean rather than a histogram's dominant bin: a dominant colour picks the
 * loudest thing in the frame, which for a photograph is often a small saturated
 * highlight, and a placeholder should be the quiet overall tone of the picture.
 */
export function averageColorHex(pixels: Uint8Array, channels: number): string {
  if (channels < 3) {
    throw new Error(`averageColorHex expects at least 3 channels, got ${channels.toString()}`);
  }
  const pixelCount = Math.floor(pixels.length / channels);
  if (pixelCount === 0) return '#000000';

  let red = 0;
  let green = 0;
  let blue = 0;
  for (let offset = 0; offset + channels <= pixels.length; offset += channels) {
    red += pixels[offset] ?? 0;
    green += pixels[offset + 1] ?? 0;
    blue += pixels[offset + 2] ?? 0;
  }

  const component = (total: number): string =>
    Math.round(total / pixelCount)
      .toString(16)
      .padStart(2, '0');

  return `#${component(red)}${component(green)}${component(blue)}`;
}
