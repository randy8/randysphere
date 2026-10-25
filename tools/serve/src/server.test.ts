import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { canonicalPagePath, createPrivateSiteServer, legacyRedirect } from './server.ts';

const PASSWORD = 'letmein';
const SECRET = 'test-session-secret';
const SITE_ORIGIN = 'https://example.test';
const SHARED_ID = '0123456789abcdef';
const TAG_PHOTO_ID = 'aaaaaaaaaaaaaaaa';

// Same fixed-width byte-packing scheme site/src/photography/share-code.ts's
// encodeIds uses — reimplemented here, not imported, for the same
// cross-workspace reason share-preview.ts itself doesn't import it either.
function encodeIdsForTest(ids: readonly string[]): string {
  const bytes = new Uint8Array(ids.length * 8);
  ids.forEach((id, index) => {
    for (let i = 0; i < 8; i += 1) {
      bytes[index * 8 + i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
    }
  });
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'photo-serve-'));
  const distDir = join(root, 'dist');
  const privatePhotosDir = join(root, 'private-photos');
  const notesPath = join(root, 'notes.yaml');
  const generatedAlbumsDir = join(root, 'albums');
  const derivativesDir = join(root, 'derivatives');

  await mkdir(distDir, { recursive: true });
  // The real build's dist/index.html is Astro's meta-refresh redirect page
  // — never served in production because the "/" route below redirects for
  // real before this file is ever read. Kept in the fixture only to prove
  // that.
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><title>Redirecting to: /exposures/</title>' +
      '<meta http-equiv="refresh" content="0;url=/exposures/">',
  );
  await mkdir(join(distDir, 'exposures'), { recursive: true });
  await writeFile(join(distDir, 'exposures', 'index.html'), '<h1>Public home</h1>');
  await writeFile(join(distDir, '404.html'), '<h1>Not found, distinctively</h1>');
  // Derivatives live outside dist/ entirely — served from where ingest wrote them.
  await mkdir(join(derivativesDir, 'p', 'abc123'), { recursive: true });
  await writeFile(
    join(derivativesDir, 'p', 'abc123', '1200-deadbeef.avif'),
    'not really avif bytes',
  );
  await mkdir(join(distDir, '_astro'), { recursive: true });
  await writeFile(join(distDir, '_astro', 'Base.aaaa1111.css'), 'body{}');
  await mkdir(join(distDir, 'fonts'), { recursive: true });
  await writeFile(join(distDir, 'fonts', 'newsreader-variable.woff2'), 'not really a font');
  await mkdir(privatePhotosDir, { recursive: true });
  await writeFile(join(privatePhotosDir, 'fence.txt'), 'not really a jpeg, just bytes');
  await writeFile(
    notesPath,
    `entries:\n  - date: '2026-08-08'\n    text: The fence finally started.\n    joy: true\n`,
  );

  // A trimmed stand-in for the real markup Base.astro/share/index.astro
  // actually produce — just the bits the og:image rewrite touches.
  await mkdir(join(distDir, 'exposures', 'share'), { recursive: true });
  await writeFile(
    join(distDir, 'exposures', 'share', 'index.html'),
    `<!doctype html><html><head>` +
      `<meta name="description" content="A shared selection of photographs.">` +
      `<meta property="og:title" content="Shared — Exposures — Randy Liang">` +
      `<meta property="og:description" content="A shared selection of photographs.">` +
      `<meta property="og:image" content="${SITE_ORIGIN}/og-default.png">` +
      `</head><body><h1>Shared</h1></body></html>`,
  );

  // A tag page, unlike /exposures/share/, already passes its own cover
  // photo as `image` to <Base> (see [tag].astro) — og:image and its
  // width/height tags are already real, just not necessarily *this*
  // photo. This fixture is what proves rewriteOgImage replaces an
  // existing value rather than only ever filling in a missing one.
  await mkdir(join(distDir, 'exposures', 'paris-2025'), { recursive: true });
  await writeFile(
    join(distDir, 'exposures', 'paris-2025', 'index.html'),
    `<!doctype html><html><head>` +
      `<meta name="description" content="Paris 2025">` +
      `<meta property="og:title" content="Paris 2025 — Exposures — Randy Liang">` +
      `<meta property="og:description" content="Paris 2025">` +
      `<meta property="og:image" content="${SITE_ORIGIN}/p/coverphoto1234567/og-cover.jpg">` +
      `<meta property="og:image:width" content="1200">` +
      `<meta property="og:image:height" content="630">` +
      `</head><body><h1>Paris 2025</h1></body></html>`,
  );

  await mkdir(generatedAlbumsDir, { recursive: true });
  await writeFile(
    join(generatedAlbumsDir, 'test.json'),
    JSON.stringify({
      schemaVersion: 2,
      slug: 'test',
      photos: [
        {
          sourceId: SHARED_ID,
          og: {
            format: 'jpeg',
            width: 1200,
            height: 630,
            bytes: 1000,
            key: `p/${SHARED_ID}/og-1.jpg`,
          },
        },
        {
          sourceId: TAG_PHOTO_ID,
          og: {
            format: 'jpeg',
            width: 1200,
            height: 675,
            bytes: 1000,
            key: `p/${TAG_PHOTO_ID}/og-2.jpg`,
          },
        },
      ],
    }),
  );

  const server = createPrivateSiteServer({
    distDir,
    notesPath,
    privatePhotosDir,
    password: PASSWORD,
    sessionSecret: SECRET,
    derivativesDir,
    generatedAlbumsDir,
    siteOrigin: SITE_ORIGIN,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(port)}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

after(async () => {
  await close();
});

test('the public site is served for an ordinary path', async () => {
  const response = await fetch(`${baseUrl}/exposures/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Public home/);
});

test('"/" issues a real HTTP redirect to Selected Work rather than serving Astro\'s meta-refresh flash page', async () => {
  const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/exposures/');
  const body = await response.text();
  assert.doesNotMatch(body, /Redirecting/);
});

test('"/" still resolves to the real page once redirects are followed', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Public home/);
});

test('a photo derivative under /p/ gets a long, immutable cache header', async () => {
  const response = await fetch(`${baseUrl}/p/abc123/1200-deadbeef.avif`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('a /p/ path that is not a derivative 404s rather than falling through to dist/', async () => {
  const response = await fetch(`${baseUrl}/p/abc123/missing.avif`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Not found, distinctively/);
});

test('an oversized login body is refused before it is read in full', async () => {
  const response = await fetch(`${baseUrl}/private/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${'x'.repeat(10_000)}`,
  });
  assert.equal(response.status, 413);
});

test("Astro's own hashed build output under /_astro/ gets the same long, immutable cache header", async () => {
  const response = await fetch(`${baseUrl}/_astro/Base.aaaa1111.css`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('a self-hosted font gets a long cache header, but not immutable (the filename is not content-hashed)', async () => {
  const response = await fetch(`${baseUrl}/fonts/newsreader-variable.woff2`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=2592000');
});

test('an HTML page gets no explicit cache-control — a rebuild reuses the same URL for different bytes', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.headers.get('cache-control'), null);
});

test('an unknown path serves the real 404.html with a 404 status, not the public home page', async () => {
  const response = await fetch(`${baseUrl}/no-such-page/`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Not found, distinctively/);
});

test('/private with no session shows the password gate, not the notes', async () => {
  const response = await fetch(`${baseUrl}/private`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Private/);
  assert.doesNotMatch(body, /fence finally started/);
});

test('a wrong password is rejected and issues no session cookie', async () => {
  const response = await fetch(`${baseUrl}/private/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'not it' }),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('the notes data file cannot be fetched by guessing its path — it is not under dist/', async () => {
  const response = await fetch(`${baseUrl}/private/notes.yaml`);
  assert.equal(response.status, 404);
});

test('a private photo requires authentication', async () => {
  const response = await fetch(`${baseUrl}/private/photos/fence.txt`);
  assert.equal(response.status, 401);
});

test('the correct password authenticates, and the session then unlocks /private and its photos', async () => {
  const login = await fetch(`${baseUrl}/private/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/private');
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';')[0];

  const archive = await fetch(`${baseUrl}/private`, { headers: { cookie } });
  assert.equal(archive.status, 200);
  assert.match(await archive.text(), /The fence finally started\./);

  const photo = await fetch(`${baseUrl}/private/photos/fence.txt`, { headers: { cookie } });
  assert.equal(photo.status, 200);
  assert.equal(await photo.text(), 'not really a jpeg, just bytes');
});

test('logging out clears the session so /private shows the gate again', async () => {
  const login = await fetch(`${baseUrl}/private/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const logout = await fetch(`${baseUrl}/private/logout`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
  });
  assert.equal(logout.status, 303);
  const cleared = logout.headers.get('set-cookie');
  assert.ok(cleared);
  assert.match(cleared, /Max-Age=0/);
});

test('a share link with a real ?s= gets its og:image rewritten to the shared photograph', async () => {
  const response = await fetch(`${baseUrl}/exposures/share/?s=${encodeIdsForTest([SHARED_ID])}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(`og:image" content="${SITE_ORIGIN}/p/${SHARED_ID}/og-1\\.jpg"`));
  assert.match(body, /og:image:width" content="1200"/);
  assert.match(body, /og:image:height" content="630"/);
  assert.doesNotMatch(body, /og-default\.png/);
});

test('a share link with no ?s= serves the page byte-for-byte unchanged', async () => {
  const response = await fetch(`${baseUrl}/exposures/share/`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /og-default\.png/);
  assert.doesNotMatch(body, /og:image:width/);
});

test('a share link whose ?s= names no real photograph also serves the page unchanged', async () => {
  const response = await fetch(
    `${baseUrl}/exposures/share/?s=${encodeIdsForTest(['ffffffffffffffff'])}`,
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /og-default\.png/);
});

test('a plain page URL with ?photo=<id> — the address bar while viewing that photo in the lightbox — gets its own og:image, replacing whatever cover photo was already there', async () => {
  const response = await fetch(`${baseUrl}/exposures/paris-2025/?photo=${TAG_PHOTO_ID}`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(`og:image" content="${SITE_ORIGIN}/p/${TAG_PHOTO_ID}/og-2\\.jpg"`));
  assert.match(body, /og:image:width" content="1200"/);
  assert.match(body, /og:image:height" content="675"/);
  assert.doesNotMatch(body, /coverphoto1234567/);
  // The page's own description is left alone — only /exposures/share/'s
  // has no better default to preserve.
  assert.match(body, /og:description" content="Paris 2025"/);
});

test('?photo= takes precedence over ?s= when a share link is open on a specific photo', async () => {
  const response = await fetch(
    `${baseUrl}/exposures/share/?s=${encodeIdsForTest([SHARED_ID])}&photo=${TAG_PHOTO_ID}`,
  );
  const body = await response.text();
  assert.match(body, new RegExp(`og:image" content="${SITE_ORIGIN}/p/${TAG_PHOTO_ID}/og-2\\.jpg"`));
});

test('?photo= naming no real photograph leaves the page unchanged', async () => {
  const response = await fetch(`${baseUrl}/exposures/paris-2025/?photo=ffffffffffffffff`);
  const body = await response.text();
  assert.match(body, /coverphoto1234567/);
});

test('a page with no ?photo= or ?s= at all is streamed unchanged (the common case)', async () => {
  const response = await fetch(`${baseUrl}/exposures/paris-2025/`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /coverphoto1234567/);
});

test('pre-rename URLs map to where their content lives now', () => {
  assert.equal(legacyRedirect('/photography/selected/'), '/exposures/');
  assert.equal(legacyRedirect('/photography/'), '/exposures/');
  assert.equal(legacyRedirect('/photography'), '/exposures/');
  assert.equal(legacyRedirect('/photography/0271/'), '/exposures/0271/');
  assert.equal(legacyRedirect('/photography/film/portra400/'), '/exposures/film/portra400/');
  assert.equal(legacyRedirect('/films/'), '/pictures/');
  assert.equal(legacyRedirect('/recipes/miso-soup/'), '/dishes/miso-soup/');
  assert.equal(legacyRedirect('/music/'), '/tunes/');
  assert.equal(legacyRedirect('/exposures/'), null);
  assert.equal(legacyRedirect('/photographyx/'), null);
});

test('an old URL gets a permanent redirect, keeping its query string', async () => {
  const response = await fetch(`${baseUrl}/photography/selected/?film=portra400`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/exposures/?film=portra400');
});

test('a page named without its trailing slash gets a permanent redirect to the slashed URL', async () => {
  const response = await fetch(`${baseUrl}/exposures`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/exposures/');
});

test('the trailing-slash redirect keeps the query string, so share links survive it', async () => {
  const response = await fetch(`${baseUrl}/exposures/share?p=AbCdEf`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/exposures/share/?p=AbCdEf');
});

test('a page reached by its index file redirects to its directory URL, not a duplicate 200', async () => {
  const response = await fetch(`${baseUrl}/exposures/index.html`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/exposures/');
});

test('the canonical URL is served directly, with no redirect', async () => {
  const response = await fetch(`${baseUrl}/exposures/`, { redirect: 'manual' });
  assert.equal(response.status, 200);
});

test('a slashless path with no page behind it still 404s rather than bouncing first', async () => {
  const response = await fetch(`${baseUrl}/no-such-page`, { redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('files are never redirected: a stylesheet, a font, a derivative', async () => {
  for (const path of [
    '/_astro/Base.aaaa1111.css',
    '/fonts/newsreader-variable.woff2',
    '/p/abc123/1200-deadbeef.avif',
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 200, path);
  }
});

test('an old URL without its trailing slash lands on the canonical new URL in one hop', async () => {
  const response = await fetch(`${baseUrl}/photography/share?p=AbCdEf`, { redirect: 'manual' });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/exposures/share/?p=AbCdEf');
});

test('canonicalPagePath refuses to look outside dist/', async () => {
  assert.equal(await canonicalPagePath('/nonexistent', '/../etc'), null);
  assert.equal(await canonicalPagePath('/nonexistent', '/p/abc123'), null);
});

async function login(password: string, client: string): Promise<Response> {
  return fetch(`${baseUrl}/private/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'cf-connecting-ip': client,
    },
    body: new URLSearchParams({ password }),
  });
}

test('five wrong passwords lock that visitor out, even with the right password, with Retry-After', async () => {
  const client = '203.0.113.10';
  for (let i = 0; i < 5; i += 1) assert.equal((await login('wrong', client)).status, 401);
  const locked = await login(PASSWORD, client);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match(await locked.text(), /Too many attempts/);
  assert.equal(locked.headers.get('set-cookie'), null);
});

test("one visitor's lockout never locks out another arriving through the tunnel", async () => {
  for (let i = 0; i < 6; i += 1) await login('wrong', '203.0.113.20');
  const owner = await login(PASSWORD, '198.51.100.5');
  assert.equal(owner.status, 303);
  assert.match(owner.headers.get('set-cookie') ?? '', /private_session=/);
});

test('a correct password before the limit clears the count', async () => {
  const client = '203.0.113.30';
  for (let i = 0; i < 4; i += 1) await login('wrong', client);
  assert.equal((await login(PASSWORD, client)).status, 303);
  for (let i = 0; i < 4; i += 1) assert.equal((await login('wrong', client)).status, 401);
  assert.equal((await login(PASSWORD, client)).status, 303);
});

test('the password gate labels its field', async () => {
  const html = await (await fetch(`${baseUrl}/private`)).text();
  assert.match(html, /<input type="password"[^>]*aria-label="Password"/);
});
