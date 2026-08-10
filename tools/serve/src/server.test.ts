import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createPrivateSiteServer } from './server.ts';

const PASSWORD = 'letmein';
const SECRET = 'test-session-secret';

let baseUrl: string;
let close: () => Promise<void>;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'photo-serve-'));
  const distDir = join(root, 'dist');
  const privatePhotosDir = join(root, 'private-photos');
  const notesPath = join(root, 'notes.yaml');

  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<h1>Public home</h1>');
  await writeFile(join(distDir, '404.html'), '<h1>Not found, distinctively</h1>');
  await mkdir(join(distDir, 'p', 'abc123'), { recursive: true });
  await writeFile(join(distDir, 'p', 'abc123', '1200-deadbeef.avif'), 'not really avif bytes');
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

  const server = createPrivateSiteServer({
    distDir,
    notesPath,
    privatePhotosDir,
    password: PASSWORD,
    sessionSecret: SECRET,
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
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Public home/);
});

test('a photo derivative under /p/ gets a long, immutable cache header', async () => {
  const response = await fetch(`${baseUrl}/p/abc123/1200-deadbeef.avif`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
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
