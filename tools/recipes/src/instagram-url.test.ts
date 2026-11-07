import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InvalidReelUrl, parseReelUrl, shortcodeOf } from './instagram-url.ts';

const CANONICAL = 'https://www.instagram.com/reel/C9xYz_Ab-12/';

test('every way Instagram links one Reel resolves to the same canonical URL', () => {
  for (const input of [
    'https://www.instagram.com/reel/C9xYz_Ab-12/',
    'https://www.instagram.com/reel/C9xYz_Ab-12',
    'https://instagram.com/reel/C9xYz_Ab-12/?igsh=MWQ1ZGUxMzBkMA==',
    'https://m.instagram.com/reels/C9xYz_Ab-12/',
    'https://www.instagram.com/p/C9xYz_Ab-12/',
    'https://www.instagram.com/tv/C9xYz_Ab-12/',
    'https://www.instagram.com/somecook/reel/C9xYz_Ab-12/',
    'http://www.instagram.com/reel/C9xYz_Ab-12/#comments',
    '  www.instagram.com/reel/C9xYz_Ab-12/  ',
    'HTTPS://WWW.INSTAGRAM.COM/REEL/C9xYz_Ab-12/',
  ]) {
    assert.deepEqual(parseReelUrl(input), { shortcode: 'C9xYz_Ab-12', url: CANONICAL }, input);
  }
});

test('shortcodes keep their case: they are case-sensitive identifiers', () => {
  assert.notEqual(parseReelUrl('instagram.com/reel/AbCdEfGh/').shortcode, 'abcdefgh');
});

test('anything that is not an Instagram Reel or post is refused with a reason', () => {
  for (const input of [
    '',
    '   ',
    'not a url',
    'https://www.instagram.com/',
    'https://www.instagram.com/somecook/',
    'https://www.instagram.com/stories/somecook/3456/',
    'https://www.instagram.com/reel/',
    'https://www.instagram.com/reel/a/',
    'https://www.instagram.com/reel/<script>/',
    'https://www.instagram.com/a/b/reel/C9xYz_Ab-12/',
    'https://instagram.com.evil.example/reel/C9xYz_Ab-12/',
    'https://evilinstagram.com/reel/C9xYz_Ab-12/',
    'https://www.tiktok.com/@cook/video/123',
    'javascript:alert(1)//instagram.com/reel/C9xYz_Ab-12/',
    'ftp://www.instagram.com/reel/C9xYz_Ab-12/',
    'https://user:pass@www.instagram.com/reel/C9xYz_Ab-12/',
    'https://www.instagram.com:8443/reel/C9xYz_Ab-12/',
    `https://www.instagram.com/reel/C9xYz_Ab-12/?q=${'x'.repeat(2100)}`,
  ]) {
    assert.throws(() => parseReelUrl(input), InvalidReelUrl, input);
  }
});

test('shortcodeOf reads stored URLs and ignores anything else', () => {
  assert.equal(shortcodeOf(CANONICAL), 'C9xYz_Ab-12');
  assert.equal(shortcodeOf('https://example.com/'), null);
  assert.equal(shortcodeOf(undefined), null);
  assert.equal(shortcodeOf(42), null);
});
