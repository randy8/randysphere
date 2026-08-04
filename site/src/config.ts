/**
 * Site-wide identity, shared by every collection. A collection with its own
 * settings (e.g. photography's `imageBaseUrl`) keeps them in its own
 * `config.ts`, colocated with the rest of that collection's code.
 */
export const site = {
  title: 'Randy Liang',
  description: 'A personal archive.',
  author: 'Randy Liang',
} as const;
