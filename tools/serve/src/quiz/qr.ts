/**
 * A QR code encoder (ISO/IEC 18004), byte mode only, versions 1–10 — the
 * join link is a short URL, so that is all this needs, and it saves a
 * dependency with its own dependencies for one SVG. Follows the structure
 * of Project Nayuki's reference implementation (MIT); checked module for
 * module against an independent encoder (qr.test.ts's fixtures were made
 * with Python's segno).
 */

type Ecl = 'L' | 'M' | 'Q' | 'H';
const ECL_ORDINAL: Record<Ecl, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits for each level, as the standard numbers them. */
const ECL_FORMAT: Record<Ecl, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index [ecl][version]; version 0 unused.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];

const MAX_VERSION = 10;

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const table = (rows: number[][], ecl: Ecl, version: number): number =>
  rows[ECL_ORDINAL[ecl]]?.[version] ?? 0;

function dataCodewords(version: number, ecl: Ecl): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    table(ECC_PER_BLOCK, ecl, version) * table(BLOCKS, ecl, version)
  );
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = Array.from({ length: degree }, () => 0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < degree) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach(
      (coefficient, i) => (result[i] = (result[i] ?? 0) ^ gfMultiply(coefficient, factor)),
    );
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 17 - 7; result.length < count; position -= step)
    result.splice(1, 0, position);
  return result;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fixed: boolean[][];
  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
    this.fixed = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const fixedRow = this.fixed[y];
    if (!row || !fixedRow) return;
    row[x] = dark;
    fixedRow[x] = true;
  }
  get(x: number, y: number): boolean {
    return this.modules[y]?.[x] === true;
  }
}

function drawFormat(matrix: Matrix, ecl: Ecl, mask: number): void {
  const data = (ECL_FORMAT[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const size = matrix.size;
  for (let i = 0; i <= 5; i += 1) matrix.setFunction(8, i, bit(i));
  matrix.setFunction(8, 7, bit(6));
  matrix.setFunction(8, 8, bit(7));
  matrix.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) matrix.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) matrix.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) matrix.setFunction(8, size - 15 + i, bit(i));
  matrix.setFunction(8, size - 8, true);
}

function drawFunctionPatterns(matrix: Matrix, version: number, ecl: Ecl): void {
  const size = matrix.size;
  for (let i = 0; i < size; i += 1) {
    matrix.setFunction(6, i, i % 2 === 0);
    matrix.setFunction(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size)
          matrix.setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((px, i) =>
    positions.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1)
          matrix.setFunction(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }),
  );
  drawFormat(matrix, ecl, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      matrix.setFunction(a, b, dark);
      matrix.setFunction(b, a, dark);
    }
  }
}

function codewords(bytes: Uint8Array, version: number, ecl: Ecl): number[] {
  const capacity = dataCodewords(version, ecl) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const blocks = table(BLOCKS, ecl, version);
  const eccLength = table(ECC_PER_BLOCK, ecl, version);
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLength);
  const all: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const chunk = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += chunk.length;
    const ecc = rsRemainder(chunk, divisor);
    if (i < shortBlocks) chunk.push(0);
    all.push([...chunk, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < (all[0]?.length ?? 0); i += 1) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i] ?? 0);
    });
  }
  return result;
}

function drawCodewords(matrix: Matrix, data: readonly number[]): void {
  const size = matrix.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!matrix.fixed[y]?.[x] && i < data.length * 8) {
          const row = matrix.modules[y];
          if (row) row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) !== 0;
          i += 1;
        }
      }
    }
  }
}

function applyMask(matrix: Matrix, mask: number): void {
  const test = MASKS[mask];
  if (!test) return;
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      const row = matrix.modules[y];
      if (row && !matrix.fixed[y]?.[x] && test(x, y)) row[x] = !row[x];
    }
  }
}

/** The standard's penalty score (lower is easier to scan); used only to choose a mask. */
function penalty(matrix: Matrix): number {
  const size = matrix.size;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y += 1)
    lines.push(Array.from({ length: size }, (_, x) => matrix.get(x, y)));
  for (let x = 0; x < size; x += 1)
    lines.push(Array.from({ length: size }, (_, y) => matrix.get(x, y)));
  const finderLike = [true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 7 <= size; i += 1) {
      if (!finderLike.every((dark, k) => line[i + k] === dark)) continue;
      const before = i >= 4 && [1, 2, 3, 4].every((k) => line[i - k] === false);
      const after = i + 11 <= size && [7, 8, 9, 10].every((k) => line[i + k] === false);
      if (before || after) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const color = matrix.get(x, y);
      if (
        color === matrix.get(x + 1, y) &&
        color === matrix.get(x, y + 1) &&
        color === matrix.get(x + 1, y + 1)
      )
        score += 3;
    }
  }
  const dark = matrix.modules.flat().filter(Boolean).length;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  readonly modules: readonly (readonly boolean[])[];
}

export function encode(text: string, ecl: Ecl = 'M', forceMask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (
    version <= MAX_VERSION &&
    dataCodewords(version, ecl) * 8 < 4 + (version <= 9 ? 8 : 16) + bytes.length * 8
  )
    version += 1;
  if (version > MAX_VERSION) throw new Error('too long for a QR code here');
  const data = codewords(bytes, version, ecl);
  let best: { matrix: Matrix; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const matrix = new Matrix(version * 4 + 17);
    drawFunctionPatterns(matrix, version, ecl);
    drawCodewords(matrix, data);
    applyMask(matrix, mask);
    drawFormat(matrix, ecl, mask);
    const score = penalty(matrix);
    if (best === null || score < best.score) best = { matrix, mask, score };
  }
  if (!best) throw new Error('no mask');
  return { version, size: best.matrix.size, mask: best.mask, modules: best.matrix.modules };
}

/** Dark modules as one SVG path, with the standard four-module quiet zone. */
export function toSvg(code: QrCode): string {
  const border = 4;
  const parts: string[] = [];
  code.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${String(x + border)} ${String(y + border)}h1v1h-1z`);
    }),
  );
  const extent = code.size + border * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(extent)} ${String(extent)}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${parts.join('')}"/></svg>`
  );
}
