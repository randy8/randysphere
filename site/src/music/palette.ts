/**
 * The viewer's ambient light: a few colours read from a video's thumbnail,
 * then pushed down into a dim, muted range so they glow behind the player
 * rather than compete with it. Pure functions over raw RGBA pixels — the
 * canvas that produces them lives in tunes.ts — so this is testable
 * without a browser.
 */
export type Rgb = readonly [number, number, number];

/** Used when a thumbnail can't be read: the site's own warm browns, dimmed. */
export const FALLBACK_AMBIENT: readonly string[] = [
  'rgb(74 58 44)',
  'rgb(58 46 38)',
  'rgb(44 36 30)',
];

// Letterbox bars, black backgrounds and white title cards are what most
// thumbnails have the most of, and none of them is the video's colour.
const MIN_LUMA = 24;
const MAX_LUMA = 235;
// Two picks closer than this read as one colour, so the next one is skipped.
const MIN_DISTANCE = 60;

function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Up to `count` dominant colours, most dominant first. Pixels are bucketed
 * at 3 bits a channel (512 boxes); a saturated pixel counts for more than
 * a grey one, since a frame's colour is what the eye remembers of it. Each
 * result is its box's average, not the box's corner. Empty when nothing
 * survives the luma filter (an all-black or all-white frame).
 */
export function dominantColors(rgba: ArrayLike<number>, count = 3): Rgb[] {
  const boxes = new Map<number, { r: number; g: number; b: number; n: number; weight: number }>();
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const pixel: Rgb = [rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0];
    if ((rgba[i + 3] ?? 255) < 128) continue;
    const y = luma(pixel);
    if (y < MIN_LUMA || y > MAX_LUMA) continue;
    const key = ((pixel[0] >> 5) << 6) | ((pixel[1] >> 5) << 3) | (pixel[2] >> 5);
    const box = boxes.get(key) ?? { r: 0, g: 0, b: 0, n: 0, weight: 0 };
    box.r += pixel[0];
    box.g += pixel[1];
    box.b += pixel[2];
    box.n += 1;
    box.weight += 1 + 2 * saturation(pixel);
    boxes.set(key, box);
  }

  const ranked = [...boxes.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((box): Rgb => [box.r / box.n, box.g / box.n, box.b / box.n]);

  const picked: Rgb[] = [];
  for (const color of ranked) {
    if (picked.length === count) break;
    if (picked.every((other) => distance(color, other) >= MIN_DISTANCE)) picked.push(color);
  }
  return picked;
}

/**
 * A colour as ambient light: same hue, saturation capped at 55%, lightness
 * held between 18% and 38% — present in a dark room, never bright enough
 * to pull the eye off the picture or wash out the paper-coloured text.
 */
export function toAmbient([r, g, b]: Rgb): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const hue = Math.round(h);
  const sat = Math.round(Math.min(s, 0.55) * 100);
  const light = Math.round(Math.min(Math.max(l, 0.18), 0.38) * 100);
  return `hsl(${String(hue)} ${String(sat)}% ${String(light)}%)`;
}

/**
 * Exactly three ambient colours for the viewer's three glows. A frame with
 * fewer distinct colours repeats its first; one with none gets the fallback.
 */
export function ambientPalette(rgba: ArrayLike<number>): string[] {
  const colors = dominantColors(rgba, 3).map(toAmbient);
  const [first] = colors;
  if (first === undefined) return [...FALLBACK_AMBIENT];
  while (colors.length < 3) colors.push(first);
  return colors;
}
