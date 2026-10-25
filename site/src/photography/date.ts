const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `'2025-08-27'` -> `'27 August 2025'`: day, month, year, the order a
 * catalogue or colophon dates a plate in. The capitals are `.dateline`'s
 * (base.css), not the text's, so a screen reader hears words rather than
 * spelled-out letters. Anything that isn't a plain ISO date comes back
 * unchanged.
 */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || month === undefined) return isoDate;
  return `${String(Number(match[3]))} ${month} ${match[1] ?? ''}`;
}
