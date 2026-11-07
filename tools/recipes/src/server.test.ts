import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  createImporterServer,
  isOwnHost,
  MAX_SCREENSHOTS,
  parseScreenshots,
  sniffImage,
} from './server.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

const recipes = mkdtempSync(join(tmpdir(), 'recipes-'));
const server = createImporterServer(
  { recipesDirectory: recipes, claude: null, ytDlp: () => Promise.reject(new Error('no')) },
  { fontsDirectory: join(import.meta.dirname, '../../../site/public/fonts') },
);
let port = 0;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${String(port)}`,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const RECIPE = {
  title: 'Gochujang Tofu',
  ingredients: [{ amount: '1 block', text: 'tofu', flag: '' }],
  instructions: [{ text: 'Cook.', flag: '' }],
  source: {
    url: 'https://www.instagram.com/reel/C9xYz_Ab-12/',
    creator: 'somecook',
    via: 'pasted',
  },
};

test('the page and its assets are served with a strict content security policy', async () => {
  const page = await send('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Import from a Reel/);
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
  assert.equal((await send('GET', '/app.js')).status, 200);
  assert.equal((await send('GET', '/fonts/newsreader-variable.woff2')).status, 200);
});

test('nothing outside the fixed list of files is served', async () => {
  for (const path of ['/../package.json', '/static/app.js', '/server.ts', '/%2e%2e/cli.ts']) {
    assert.equal((await send('GET', path)).status, 404, path);
  }
});

test('a request naming another host is refused (DNS rebinding)', async () => {
  assert.equal((await send('GET', '/', { headers: { host: 'evil.example' } })).status, 421);
  assert.equal(
    (await send('GET', '/api/status', { headers: { host: `attacker.example:${String(port)}` } }))
      .status,
    421,
  );
});

test('a write must be JSON from this page’s own origin', async () => {
  const form = await send('POST', '/api/save', {
    body: RECIPE,
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(form.status, 415);
  const crossSite = await send('POST', '/api/save', {
    body: RECIPE,
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(readdirSync(recipes), []);
});

test('status reports what is available', async () => {
  assert.deepEqual(JSON.parse((await send('GET', '/api/status')).body), {
    ytDlp: false,
    claude: false,
  });
});

test('check, save, then the same Reel again is a duplicate', async () => {
  const check = await send('POST', '/api/check', {
    body: { url: 'instagram.com/reel/C9xYz_Ab-12' },
  });
  assert.deepEqual(JSON.parse(check.body), {
    ok: true,
    url: 'https://www.instagram.com/reel/C9xYz_Ab-12/',
  });

  const saved = await send('POST', '/api/save', {
    body: RECIPE,
    headers: { origin: `http://127.0.0.1:${String(port)}` },
  });
  assert.equal(saved.status, 201);
  assert.equal((JSON.parse(saved.body) as { slug: string }).slug, 'gochujang-tofu');

  const again = await send('POST', '/api/check', { body: { url: RECIPE.source.url } });
  assert.match((JSON.parse(again.body) as { message: string }).message, /Already imported/);
  assert.equal((await send('POST', '/api/save', { body: RECIPE })).status, 409);
  assert.deepEqual(readdirSync(recipes), ['gochujang-tofu.yaml']);
});

test('without an API key, drafting explains itself instead of failing', async () => {
  const reply = await send('POST', '/api/draft', {
    body: { url: 'https://www.instagram.com/reel/Other12345/', text: 'tofu' },
  });
  assert.match((JSON.parse(reply.body) as { message: string }).message, /ANTHROPIC_API_KEY/);
});

test('bad JSON and oversized bodies are refused', async () => {
  const bad = await new Promise<number>((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/check',
        headers: { host: `127.0.0.1:${String(port)}`, 'content-type': 'application/json' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.end('{nope');
  });
  assert.equal(bad, 400);
  const big = await send('POST', '/api/check', { body: { url: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(big.status, 413);
});

test('isOwnHost accepts only this server’s loopback names', () => {
  assert.equal(isOwnHost('127.0.0.1:4510', 4510), true);
  assert.equal(isOwnHost('localhost:4510', 4510), true);
  assert.equal(isOwnHost('127.0.0.1:4511', 4510), false);
  assert.equal(isOwnHost('0.0.0.0:4510', 4510), false);
  assert.equal(isOwnHost(undefined, 4510), false);
});

test('screenshot types come from their bytes, not their claims', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
});

test('screenshots are limited in number, size and type', () => {
  const png = `data:image/png;base64,${PNG.toString('base64')}`;
  assert.deepEqual(parseScreenshots([png]), [
    { mediaType: 'image/png', data: PNG.toString('base64') },
  ]);
  assert.deepEqual(parseScreenshots(undefined), []);
  assert.throws(() => parseScreenshots('nope'), /list/);
  assert.throws(() => parseScreenshots(Array(MAX_SCREENSHOTS + 1).fill(png)), /Up to/);
  assert.throws(() => parseScreenshots(['data:image/png;base64,***']), /couldn’t be read/);
  assert.throws(
    () => parseScreenshots([`data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`]),
    /JPEG, PNG/,
  );
  const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
  assert.throws(() => parseScreenshots([huge]), /5 MB/);
});
