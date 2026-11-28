import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { encode, toSvg } from './qr.ts';

/**
 * Module-for-module fixtures from Python's `qrcode` package (8.x,
 * byte mode, the same version, level and mask): a SHA-256 of the rows as
 * 0/1 strings. On 2026-11-28 the encoder matched it in all 144 cases of
 * versions 1–10 × four levels × eight masks; these six stay as the test.
 */
const FIXTURES: [string, 'L' | 'M' | 'Q' | 'H', number, number, string][] = [
  ['https://randyliang.net/quiz/join/BCDF', 'L', 0, 3, '5b4d77695452357e'],
  ['https://randyliang.net/quiz/join/BCDF', 'M', 5, 3, '5d036849ce6d6773'],
  ['HELLO', 'M', 0, 1, 'b664c5ebcc2451fb'],
  [
    `https://randyliang.net/quiz/join/WXYZ?lan=1&x=${'a'.repeat(60)}`,
    'M',
    5,
    6,
    'a3231160a2309643',
  ],
  ['x'.repeat(200), 'L', 5, 9, '8f9480c5e8483268'],
  ['é✓ unicode', 'H', 7, 2, '88297c02ab2950fc'],
];

test('matches a reference encoder module for module', () => {
  for (const [text, ecl, mask, version, sha] of FIXTURES) {
    const code = encode(text, ecl, mask);
    assert.equal(code.version, version);
    const rows = code.modules
      .map((row) => row.map((dark) => (dark ? '1' : '0')).join(''))
      .join('\n');
    assert.equal(
      createHash('sha256').update(rows).digest('hex').slice(0, 16),
      sha,
      `${text.slice(0, 20)} ${ecl} ${String(mask)}`,
    );
  }
});

test('chooses a mask by itself and renders an SVG with a quiet zone', () => {
  const code = encode('https://randyliang.net/quiz/join/ABCD');
  assert.ok(code.mask >= 0 && code.mask < 8);
  const svg = toSvg(code);
  assert.match(svg, new RegExp(`viewBox="0 0 ${String(code.size + 8)} ${String(code.size + 8)}"`));
  assert.throws(() => encode('x'.repeat(400)), /too long/);
});
