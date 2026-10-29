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

import { FamilyChat } from '../../../serve/src/family/routes.ts';
import { browserTest, PHONE } from './harness.ts';

let chat: FamilyChat;
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
  server = createServer((req, res) => {
    void chat.handle(req, res, new URL(req.url ?? '/', 'http://localhost')).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  chat.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Signs in through the form, as a person would, and waits for the live conversation. */
async function signIn(context: BrowserContext, username: string, password: string): Promise<Page> {
  // The harness stubs images from hosts other than the site under test;
  // this server is that site here.
  await context.unrouteAll();
  const page = await context.newPage();
  await page.goto(`${origin}/family/`);
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
    await mom.locator('[data-messages]').getByText('Dinner at 7?').waitFor();
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
    await mom
      .locator('[data-messages]')
      .getByText('while you were away')
      .waitFor({ timeout: 10_000 });
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
  'rooms: switching is instant, each room keeps its own messages, and others count what you missed',
  async ({ context, page: unused }) => {
    await unused.close();
    const randy = await signIn(context, 'randy', 'battery staple');
    // Wide: the list is a sidebar beside the conversation.
    await randy.locator('.rooms .room[data-room="2"]').waitFor();
    const title = (): Promise<string> => randy.locator('[data-room-name]').innerText();
    assert.equal(await title(), 'Family');
    const loaded = await randy.evaluate(() => performance.getEntriesByType('navigation').length);

    const mom = chat.store.findUserByUsername('mom')?.id ?? 0;
    const { message } = chat.store.postMessage({
      userId: mom,
      roomId: 2,
      clientId: 'browser-disc-1',
      body: '飞盘？',
    });
    chat.hub.broadcast('message', message, { id: message.rev, room: 2 });
    const badge = randy.locator('.room[data-room="2"] .room-unread');
    await badge.waitFor();
    assert.equal(await badge.innerText(), '1');
    assert.ok(!(await bubbles(randy)).includes('飞盘？'), 'stays in Disc');

    await randy.click('.room[data-room="2"]');
    await randy.locator('[data-messages]').getByText('飞盘？').waitFor();
    assert.equal(await title(), 'Disc');
    assert.equal(new URL(randy.url()).search, '?room=disc');
    await badge.waitFor({ state: 'detached' });
    await send(randy, 'Saturday');
    await randy.locator('.receipt').waitFor();
    assert.equal(chat.store.history(null, 50, 2).messages.at(-1)?.body, 'Saturday');

    await randy.goBack();
    await randy.waitForFunction(
      () => document.querySelector('[data-room-name]')?.textContent === 'Family',
    );
    assert.ok(!(await bubbles(randy)).includes('Saturday'));
    assert.equal(
      await randy.evaluate(() => performance.getEntriesByType('navigation').length),
      loaded,
      'no reload',
    );
  },
);

browserTest(
  'rooms on a phone: the list is its own screen, Back shows it, a row opens the room',
  async ({ context, page: unused }) => {
    await unused.close();
    const mom = await signIn(context, 'mom', 'correct horse');
    const rooms = mom.locator('[data-rooms]');
    assert.ok(!(await rooms.isVisible()));
    await mom.click('[data-back]');
    await rooms.waitFor({ state: 'visible' });
    assert.ok(!(await mom.locator('[data-app]').isVisible()));
    await mom.click('.room[data-room="2"]');
    await mom.locator('[data-input]').waitFor({ state: 'visible' });
    assert.equal(await mom.locator('[data-room-name]').innerText(), 'Disc');
    assert.ok(!(await rooms.isVisible()));
  },
  PHONE,
);
