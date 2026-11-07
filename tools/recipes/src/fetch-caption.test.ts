import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captionFromMetadata, fetchCaption, ytDlpAvailable } from './fetch-caption.ts';
import type { YtDlp } from './fetch-caption.ts';
import { parseReelUrl } from './instagram-url.ts';

const REEL = parseReelUrl('https://www.instagram.com/reel/C9xYz_Ab-12/');

function failing(fields: Record<string, unknown>): YtDlp {
  return () => Promise.reject(Object.assign(new Error('yt-dlp failed'), fields));
}

test('the caption, handle and name come from yt-dlp’s metadata', async () => {
  let seen: readonly string[] = [];
  const run: YtDlp = (args) => {
    seen = args;
    return Promise.resolve(
      JSON.stringify({
        description: 'Gochujang tofu\r\n\r\n1 block tofu\r\n2 tbsp gochujang',
        channel: 'somecook',
        uploader_id: '2815873',
        uploader: 'Some Cook',
      }),
    );
  };
  assert.deepEqual(await fetchCaption(REEL, run), {
    ok: true,
    value: {
      caption: 'Gochujang tofu\n\n1 block tofu\n2 tbsp gochujang',
      creator: 'somecook',
      creatorName: 'Some Cook',
    },
  });
  // Metadata only, our config only, and the URL can never be read as an option.
  assert.ok(seen.includes('--skip-download'));
  assert.ok(seen.includes('--ignore-config'));
  assert.deepEqual(seen.slice(-2), ['--', REEL.url]);
});

test('an older yt-dlp’s uploader_id handle is used; a numeric id is not', () => {
  assert.equal(
    captionFromMetadata(JSON.stringify({ uploader_id: 'somecook' }))?.creator,
    'somecook',
  );
  assert.equal(captionFromMetadata(JSON.stringify({ uploader_id: '2815873' }))?.creator, '');
  assert.equal(captionFromMetadata('not json'), null);
  assert.equal(captionFromMetadata('"a string"'), null);
});

test('each way yt-dlp fails becomes a sentence, never a crash', async () => {
  const cases: [YtDlp, RegExp][] = [
    [failing({ code: 'ENOENT' }), /isn’t installed/],
    [failing({ killed: true }), /too long/],
    [
      failing({
        stderr:
          'ERROR: [Instagram] C9x: Requested content is not available, rate-limit reached or login required',
      }),
      /logging in|isn’t available/,
    ],
    [failing({ stderr: 'ERROR: HTTP Error 404: Not Found' }), /private or deleted/],
    [failing({ stderr: 'something else entirely' }), /couldn’t be read/],
    [() => Promise.resolve('garbage'), /couldn’t be read/],
    [() => Promise.resolve(JSON.stringify({ description: '   ' })), /no caption/],
  ];
  for (const [run, message] of cases) {
    const result = await fetchCaption(REEL, run);
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.message : '', message);
  }
});

test('ytDlpAvailable answers from whether the binary runs', async () => {
  assert.equal(await ytDlpAvailable(() => Promise.resolve('2026.10.01')), true);
  assert.equal(await ytDlpAvailable(failing({ code: 'ENOENT' })), false);
});
