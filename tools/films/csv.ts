/**
 * RFC 4180 CSV, both ways — Letterboxd titles contain commas and quotes
 * ("Synecdoche, New York"). Shared by import-ratings.ts and
 * fetch-posters.ts.
 */

// Duplicated from site/src/films/films.ts rather than imported — this
// script lives on the tooling side of the same boundary that keeps the
// pipeline and the site from importing each other's code (see
// docs/decisions.md, "type-only boundary"). It's ~30 lines.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0) || row.length > 1) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** One CSV line: a field is quoted only when it has to be, the way Letterboxd's own export writes it. */
export function formatCsvRow(cells: readonly string[]): string {
  return cells
    .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}
