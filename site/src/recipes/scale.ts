/**
 * A serving-size scaler over the ingredients list only — never the
 * instructions' embedded measurements (a splash of pasta water, cook
 * times), which don't scale linearly with quantity and live in a
 * deliberately quieter markup form (`.measurement`, from `renderQuiet`)
 * for exactly that reason: they're not ingredients to shop for. Runs
 * entirely against each `<strong>`'s original text, cached on first read,
 * so repeatedly switching multipliers never compounds rounding error.
 *
 * Every number is reformatted to a "nice" cooking value on the way back
 * out — a common fraction glyph (¼ ⅓ ½ ⅔ ¾) or a whole number, never a
 * raw decimal like "2.333" — because a scaled recipe is still something a
 * person has to read off a measuring cup, not a spreadsheet.
 */

const FRACTIONS: readonly { readonly value: number; readonly glyph: string }[] = [
  { value: 1 / 8, glyph: '⅛' },
  { value: 1 / 4, glyph: '¼' },
  { value: 1 / 3, glyph: '⅓' },
  { value: 1 / 2, glyph: '½' },
  { value: 2 / 3, glyph: '⅔' },
  { value: 3 / 4, glyph: '¾' },
];
const FRACTION_VALUES: Readonly<Record<string, number>> = Object.fromEntries(
  FRACTIONS.map((f) => [f.glyph, f.value]),
);
const NUMBER_TOKEN = /^(\d+(?:\.\d+)?)?([⅛¼⅓½⅔¾])?$/;
/** A leading number/fraction, an optional en-dash range, then whatever text follows (a unit, usually). */
const QUANTITY = /^([\d⅛¼⅓½⅔¾.]+)(?:–([\d⅛¼⅓½⅔¾.]+))?(.*)$/su;

function parseToken(token: string): number | null {
  const match = NUMBER_TOKEN.exec(token);
  if (!match) return null;
  const [, whole, fraction] = match;
  if (whole === undefined && fraction === undefined) return null;
  return (
    (whole === undefined ? 0 : Number.parseFloat(whole)) +
    (fraction ? (FRACTION_VALUES[fraction] ?? 0) : 0)
  );
}

/** Snaps to the nearest common cooking fraction/whole rather than printing a raw decimal. */
export function formatNice(value: number): string {
  if (value <= 0) return '0';
  const whole = Math.floor(value);
  const remainder = value - whole;

  if (remainder < 0.06) return String(whole);
  if (remainder > 0.94) return String(whole + 1);

  const closest = FRACTIONS.reduce((best, candidate) =>
    Math.abs(remainder - candidate.value) < Math.abs(remainder - best.value) ? candidate : best,
  );
  return whole > 0 ? `${String(whole)}${closest.glyph}` : closest.glyph;
}

/**
 * Scales one quantity string ("600–800 g", "3–4", "½") by `factor` and
 * reformats it. Text with no recognizable leading number ("a pinch") comes
 * back unchanged rather than throwing — an ingredient line is free prose
 * with a bolded quantity in it, not a guaranteed-numeric field.
 */
export function scaleQuantity(text: string, factor: number): string {
  const match = QUANTITY.exec(text.trim());
  if (!match) return text;
  const [, low, high, rest] = match;
  const lowValue = low === undefined ? null : parseToken(low);
  if (lowValue === null) return text;
  const scaledLow = formatNice(lowValue * factor);
  if (high === undefined) return `${scaledLow}${rest ?? ''}`;
  const highValue = parseToken(high);
  if (highValue === null) return text;
  const scaledHigh = formatNice(highValue * factor);
  return `${scaledLow}–${scaledHigh}${rest ?? ''}`;
}
