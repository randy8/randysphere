/**
 * What kind of image some bytes are, read from the bytes themselves —
 * never from what a request or another site claims. JPEG, PNG, GIF and
 * WebP only: what every browser in the family shows. Used for uploads
 * (routes.ts) and for link previews' artwork (previews.ts).
 */
const IMAGE_TYPES: readonly (readonly [string, (b: Buffer) => boolean])[] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  [
    'image/png',
    (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ],
  ['image/gif', (b) => b.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'image/webp',
    (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
];

export function sniffImage(bytes: Buffer): string | null {
  return IMAGE_TYPES.find(([, test]) => test(bytes))?.[0] ?? null;
}
