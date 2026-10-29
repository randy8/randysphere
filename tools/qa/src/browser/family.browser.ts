/**
 * The family chat, driven in a real browser. These tests start their own
 * chat server in this process, on a throwaway data directory with test
 * accounts — never the harness's server and never private/family: a
 * deploy's candidate server opens the real conversation, and nothing here
 * may write to it. (Hence `BASE` is unused: /family/ on the harness server
 * has no accounts to sign in with.)
 *
 * Built around what must not break: a message reaching the other person
 * live and exactly once, through a dropped connection and an offline
 * spell; the details sheet as a proper dialog; the service worker caching
 * nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';

import { DISC } from '../../../serve/src/family/chats.ts';
import { FamilyChat } from '../../../serve/src/family/routes.ts';
import { browserTest, PHONE } from './harness.ts';

let chat: FamilyChat;
let disc: FamilyChat;
let server: Server;
let origin = '';

before(async () => {
  chat = new FamilyChat({
    dataDir: mkdtempSync(join(tmpdir(), 'family-browser-')),
    // No notification ever leaves this machine from a test.
    pushFetch: () => Promise.resolve(new Response(null, { status: 201 })),
  });
  await Promise.all([
    chat.store.createUser({
      username: 'mom',
      displayName: '妈妈',
      password: 'correct horse',
      lang: 'zh',
    }),
    chat.store.createUser({
      username: 'randy',
      displayName: 'Randy',
      password: 'battery staple',
      isAdmin: true,
    }),
  ]);
  disc = new FamilyChat({
    chat: DISC,
    dataDir: mkdtempSync(join(tmpdir(), 'disc-browser-')),
    pushFetch: () => Promise.resolve(new Response(null, { status: 201 })),
  });
  await disc.store.createUser({
    username: 'randy',
    displayName: 'Randy',
    password: 'disc password',
    isAdmin: true,
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void (async () => (await chat.handle(req, res, url)) || disc.handle(req, res, url))().then(
      (handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  chat.shutdown();
  disc.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Signs in through the form, as a person would, and waits for the live conversation. */
async function signIn(
  context: BrowserContext,
  username: string,
  password: string,
  path = '/family/',
): Promise<Page> {
  // The harness stubs images from hosts other than the site under test;
  // this server is that site here.
  await context.unrouteAll();
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.locator('[data-input]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-messages] [data-static]'));
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-input]', text);
  await page.click('[data-send]');
}

const bubbles = (page: Page): Promise<string[]> =>
  page.$$eval('[data-messages] .msg:not(.typing) .bubble', (nodes) =>
    nodes.map((node) => node.textContent ?? ''),
  );

browserTest(
  'a message reaches the other person live, once, and says Delivered',
  async ({ context, page: unused }) => {
    await unused.close();
    const mom = await signIn(context, 'mom', 'correct horse');
    const other = await context.browser()?.newContext(PHONE);
    assert.ok(other);
    const randy = await signIn(other, 'randy', 'battery staple');

    await send(randy, 'Dinner at 7?');
    await mom.getByText('Dinner at 7?').waitFor();
    await randy.locator('.receipt').waitFor();
    assert.equal((await bubbles(mom)).filter((text) => text === 'Dinner at 7?').length, 1);
    assert.equal((await bubbles(randy)).filter((text) => text === 'Dinner at 7?').length, 1);
    await other.close();
  },
  PHONE,
);

browserTest(
  'a dropped connection reconnects and replays what was missed, without duplicates',
  async ({ context, page: unused }) => {
    await unused.close();
    const mom = await signIn(context, 'mom', 'correct horse');
    // The server ends every stream (a deploy's restart does the same).
    for (const connection of chat.hub.connections()) connection.res.end();
    const randy = chat.store.findUserByUsername('randy')?.id ?? 0;
    const { message } = chat.store.postMessage({
      userId: randy,
      clientId: 'while-away-1',
      body: 'while you were away',
    });
    chat.hub.broadcast('message', message, { id: message.rev });
    await mom.getByText('while you were away').waitFor({ timeout: 10_000 });
    await mom.waitForTimeout(500);
    assert.equal((await bubbles(mom)).filter((text) => text === 'while you were away').length, 1);
  },
  PHONE,
);

browserTest(
  'sent while offline: shown at once, delivered once the network is back',
  async ({ context, page: unused }) => {
    await unused.close();
    const mom = await signIn(context, 'mom', 'correct horse');
    await context.setOffline(true);
    await send(mom, '没网了');
    await mom.locator('.msg.pending').getByText('没网了').waitFor();
    await context.setOffline(false);
    await mom.locator('.msg:not(.pending)').getByText('没网了').waitFor({ timeout: 20_000 });
    const stored = chat.store
      .history(null, 50)
      .messages.filter((message) => message.body === '没网了');
    assert.equal(stored.length, 1);
  },
  PHONE,
);

browserTest(
  'the details sheet is a dialog: opens from the title, traps focus, Escape returns focus',
  async ({ context, page: unused }) => {
    await unused.close();
    const page = await signIn(context, 'randy', 'battery staple');
    await page.click('.bar-title');
    const sheet = page.getByRole('dialog', { name: 'Details' });
    await sheet.waitFor();
    await sheet.getByRole('heading', { name: 'Notifications' }).waitFor();
    assert.ok((await page.locator('[data-app]').getAttribute('inert')) !== null);
    // Inside the sheet: the members, and the switch to turn notifications on.
    await sheet.getByText('妈妈').waitFor();
    // A browser that has refused notifications is told how to allow them…
    await sheet.getByText('blocked for this site').waitFor();
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    // …one that hasn't been asked yet gets the button (never an unasked
    // prompt). Headless Chromium refuses notifications whatever it is
    // granted, so "not asked yet" is what the page is told, not real.
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    });
    await page.reload();
    await page.locator('[data-input]').waitFor();
    await page.click('.bar-title');
    await sheet.getByRole('button', { name: 'Turn On Notifications' }).waitFor();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
    assert.ok(
      await page.evaluate(() => document.activeElement?.closest('.sheet') !== null),
      'focus left the sheet',
    );
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'bar-title');
    assert.equal(await page.locator('[data-app]').getAttribute('inert'), null);
  },
);

browserTest(
  'the service worker is scoped to /family/ and caches nothing',
  async ({ context, page: unused }) => {
    await unused.close();
    const page = await signIn(context, 'mom', 'correct horse');
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return registration.scope;
    });
    assert.equal(new URL(scope).pathname, '/family/');
    const caches = await page.evaluate(async () => (await window.caches.keys()).length);
    assert.equal(caches, 0);
  },
);

browserTest(
  'Disc is its own chat at /disc/: its title, its messages, nothing leading to Family',
  async ({ context, page: unused }) => {
    await unused.close();
    const randy = await signIn(context, 'randy', 'disc password', '/disc/');
    assert.equal(await randy.locator('.bar h1').innerText(), 'Disc');
    // As iMessage: under the name, no line of members while connected.
    assert.ok(!(await randy.locator('[data-subtitle]').isVisible()));
    await send(randy, 'Saturday at the course?');
    await randy.locator('.receipt').waitFor();
    assert.equal(disc.store.history(null, 50).messages.at(-1)?.body, 'Saturday at the course?');
    assert.ok(!chat.store.history(null, 50).messages.some((m) => m.body.startsWith('Saturday')));
    const links = await randy.$$eval('a[href], form[action]', (nodes) =>
      nodes.map((node) => node.getAttribute('href') ?? node.getAttribute('action') ?? ''),
    );
    assert.ok(!links.some((link) => link.startsWith('/family')), links.join(' '));
    const scope = await randy.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(new URL(scope).pathname, '/disc/');
  },
  PHONE,
);

browserTest(
  'search: a result opens the conversation at that message, fetching back to an old one',
  async ({ context, page: unused }) => {
    await unused.close();
    const randy = chat.store.findUserByUsername('randy')?.id ?? 0;
    chat.store.postMessage({ userId: randy, clientId: 'search-old-1', body: 'the pelican picnic' });
    // Enough newer messages that it isn't in the first page loaded.
    for (let i = 0; i < 120; i += 1) {
      chat.store.postMessage({
        userId: randy,
        clientId: `search-filler-${String(i)}`,
        body: `filler ${String(i)}`,
      });
    }
    const page = await signIn(context, 'mom', 'correct horse');
    await page.goto(`${origin}/family/search?q=pelican`);
    await page.click('.search-result');
    const target = page.locator('[data-messages]').getByText('the pelican picnic');
    await target.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => location.hash === '');
    assert.ok(await target.isVisible());
  },
  PHONE,
);

browserTest(
  'read receipts: Delivered turns into Read as the other person reads, and Info says who and when',
  async ({ context, page: unused }) => {
    await unused.close();
    const randy = await signIn(context, 'randy', 'battery staple');
    await send(randy, 'Are you up?');
    const receipt = randy.locator('.receipt');
    await receipt.filter({ hasText: 'Delivered' }).waitFor();
    // Mom opens the chat, at the bottom: she has read it.
    const other = await context.browser()?.newContext(PHONE);
    assert.ok(other);
    const mom = await signIn(other, 'mom', 'correct horse');
    await mom.locator('[data-messages]').getByText('Are you up?').waitFor();
    await receipt.filter({ hasText: /^Read$/ }).waitFor({ timeout: 10_000 });
    // Long-press → Info: read by 妈妈, with a time.
    await randy.locator('.msg-out .bubble', { hasText: 'Are you up?' }).click({ button: 'right' });
    await randy.getByRole('menuitem', { name: 'Info' }).click();
    const sheet = randy.getByRole('dialog', { name: 'Info' });
    await sheet.getByText('Read By').waitFor();
    await sheet.getByText('妈妈').waitFor();
    assert.match(await sheet.locator('.cell .dim').first().innerText(), /\d/);
    await other.close();
  },
);

browserTest(
  'Tapback, Edit and Undo Send: from the message’s menu, live on the other side',
  async ({ context, page: unused }) => {
    await unused.close();
    const randy = await signIn(context, 'randy', 'battery staple');
    const other = await context.browser()?.newContext(PHONE);
    assert.ok(other);
    const mom = await signIn(other, 'mom', 'correct horse');
    await send(randy, 'Lunch at noon');
    const hers = mom.locator('.msg-in .bubble', { hasText: 'Lunch at noon' });
    await hers.waitFor();

    // Mom loves it: the bar over the pressed message, the badge on Randy's bubble.
    await hers.click({ button: 'right' });
    await mom.getByRole('button', { name: '喜欢' }).click();
    await randy.locator('.msg-out .tapback', { hasText: '❤️' }).waitFor();
    await mom.locator('.msg-in .tapback', { hasText: '❤️' }).waitFor();

    // Randy edits it in place; Mom sees the new words and "Edited", and its history.
    await randy
      .locator('.msg-out .bubble', { hasText: 'Lunch at noon' })
      .click({ button: 'right' });
    await randy.getByRole('menuitem', { name: 'Edit' }).click();
    const field = randy.locator('.edit-field textarea');
    await field.fill('Lunch at one');
    await randy.getByRole('button', { name: 'Save' }).click();
    await mom.locator('.msg-in .bubble', { hasText: 'Lunch at one' }).waitFor();
    await mom.getByRole('button', { name: '已编辑' }).click();
    await mom.locator('.bubble.past', { hasText: 'Lunch at noon' }).waitFor();
    assert.equal(await randy.locator('.tapback').count(), 1, 'the Tapback stays through an edit');

    // Undo Send: gone for both, a note in its place.
    await randy.locator('.msg-out .bubble', { hasText: 'Lunch at one' }).click({ button: 'right' });
    await randy.getByRole('menuitem', { name: 'Undo Send' }).click();
    await randy.getByText('You unsent a message.').waitFor();
    await mom.getByText('Randy撤回了一条信息。').waitFor();
    assert.equal(await mom.getByText('Lunch at').count(), 0);
    await other.close();
  },
);
