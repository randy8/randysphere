/**
 * The quiz, driven in real browsers: a host at a laptop, three contestants
 * on phones, the audience display on a "TV" — one complete game, through
 * both board rounds, a wager clue, the final round and the winner. Like
 * the family chat's tests, these start their own quiz server in this
 * process on a throwaway data directory: nothing here touches private/quiz.
 *
 * Built around what must not break: the response never reaching a phone
 * or the TV before the host reveals it; a press before the buzzers open
 * locking the player out; the first press winning and every screen
 * agreeing; wagers private; the whole game runnable from the host's
 * keyboard.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';
import type { BrowserContext, Page } from 'playwright-core';

import { createQuizOnlyServer } from '../../../serve/src/server.ts';
import { Quiz } from '../../../serve/src/quiz/quiz.ts';
import { browserTest, PHONE } from './harness.ts';

let quiz: Quiz;
let server: Server;
let origin = '';

before(async () => {
  quiz = new Quiz({ dataDir: mkdtempSync(join(tmpdir(), 'quiz-browser-')), log: () => undefined });
  server = createQuizOnlyServer(quiz);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  quiz.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const TV = { viewport: { width: 1600, height: 900 } };

/** Every response text the host has seen so far must be absent from these pages until revealed. */
async function assertSecret(pages: Page[], response: string): Promise<void> {
  for (const page of pages) {
    const text = await page.locator('body').innerText();
    assert.equal(
      text.toUpperCase().includes(response.toUpperCase()),
      false,
      `“${response}” is visible on ${page.url()} before its reveal`,
    );
  }
}

async function hostResponse(host: Page): Promise<string> {
  const text = await host.locator('.host-response').first().innerText();
  return text.replace(/^RESPONSE\s*/i, '').trim();
}

/**
 * A host key press, then wait for the state it caused. A person presses
 * the next key after seeing the screen change; pressing faster is refused
 * by design (the command names a state that has moved on).
 */
async function key(host: Page, name: string): Promise<void> {
  const before = await host.locator('body').getAttribute('data-seq');
  await host.keyboard.press(name);
  await host.waitForFunction((seq) => document.body.dataset['seq'] !== seq, before, {
    timeout: 8000,
  });
}

async function phase(host: Page, name: string): Promise<void> {
  await host
    .locator('.host-phase', { hasText: name.replace(/_/g, ' ') })
    .waitFor({ timeout: 8000 });
}

browserTest(
  'a complete three-contestant game, run from the host’s keyboard',
  async ({ page: host, context }) => {
    const browser = context.browser();
    assert.ok(browser);
    const contexts: BrowserContext[] = [];
    try {
      // ---- Setup: the host chooses an episode and a short final.
      await host.goto(`${origin}/quiz/host/`);
      await host.getByText('Demonstration Game One').click();
      await host.locator('summary', { hasText: 'Rules' }).click();
      await host.fill('input[name=finalSeconds]', '20');
      await host.getByRole('button', { name: 'Create the game' }).click();
      await host.waitForURL(/\/quiz\/host\/[A-Z]{4}$/);
      const code = /host\/([A-Z]{4})/.exec(host.url())?.[1] ?? '';
      assert.equal(host.url().includes('#'), false, 'the credential leaves the address bar');

      // ---- The TV.
      const tvContext = await browser.newContext(TV);
      contexts.push(tvContext);
      const tv = await tvContext.newPage();
      await tv.goto(`${origin}/quiz/display/${code}`);
      await tv.locator('.display-start').click();
      await tv.locator('.lobby-code', { hasText: code }).waitFor();

      // ---- Three phones join through the code.
      const phones: Page[] = [];
      for (const name of ['Ada', 'Grace', 'Alan']) {
        const phoneContext = await browser.newContext(PHONE);
        contexts.push(phoneContext);
        const phone = await phoneContext.newPage();
        await phone.goto(`${origin}/quiz/join/${code}`);
        await phone.fill('input[name=name]', name);
        await phone.getByRole('button', { name: 'Join' }).click();
        await phone.waitForURL(`${origin}/quiz/play/${code}`);
        await phone
          .locator('.play-name', { hasText: name.toUpperCase() })
          .or(phone.locator('.play-name', { hasText: name }))
          .waitFor();
        phones.push(phone);
      }
      const [ada, grace, alan] = phones as [Page, Page, Page];
      await tv.locator('.podium-name', { hasText: 'Alan' }).waitFor();

      // ---- Buzzer test: every press shows up on the host's diagnostic.
      await key(host, 't');
      await phase(host, 'buzzer_test');
      for (const phone of phones) await phone.locator('.buzzer').tap();
      await host.locator('.diag td', { hasText: /^1$/ }).nth(2).waitFor();

      // ---- Start: introduce the six categories, then the board.
      await key(host, ' ');
      await phase(host, 'round_intro');
      for (let i = 0; i < 6; i += 1) await key(host, ' ');
      await tv.locator('.tile.head', { hasText: 'SPACE PROBES' }).waitFor();
      await key(host, ' ');
      await phase(host, 'board');
      await ada.locator('.select-cell').first().waitFor();

      // ---- Clue 1: Grace rings in and is right; she takes the board.
      const ordinary = host.locator('.mini-cell:not(.wager):not(.played)');
      await ordinary.first().click();
      await phase(host, 'reading');
      let response = await hostResponse(host);
      await tv.locator('.clue-text').waitFor();
      await assertSecret([tv, ada, grace, alan], response);
      await key(host, ' ');
      await phase(host, 'open');
      await tv.locator('.signal.lit').first().waitFor();
      await grace.locator('.buzzer[data-state="ready"]').waitFor();
      await grace.locator('.buzzer').tap();
      await grace.locator('.buzzer[data-state="won"]').waitFor();
      await tv.locator('.podium.responding .podium-name', { hasText: 'Grace' }).waitFor();
      await ada.locator('.play-message', { hasText: 'Grace is responding' }).waitFor();
      await key(host, 'y');
      await phase(host, 'clue_end');
      await assertSecret([tv, ada, grace, alan], response);
      await key(host, ' '); // show the response
      await tv
        .locator('.clue-response', { hasText: response.toUpperCase() })
        .or(tv.locator('.clue-response', { hasText: response }))
        .waitFor();
      await key(host, ' '); // back to the board
      await phase(host, 'board');
      await grace.locator('.select-cell').first().waitFor();
      await tv.locator('.podium-score', { hasText: '$200' }).waitFor();

      // ---- Clue 2: Alan presses during the reading — locked out; Ada misses; Alan rebounds.
      await ordinary.first().click();
      await phase(host, 'reading');
      response = await hostResponse(host);
      await alan.locator('.buzzer').tap();
      // His lockout is a quarter second; a person's next press comes well after it.
      await alan.waitForTimeout(400);
      await key(host, ' ');
      await phase(host, 'open');
      await ada.locator('.buzzer[data-state="ready"]').waitFor();
      await ada.locator('.buzzer').tap();
      await ada.locator('.buzzer[data-state="won"]').waitFor();
      await key(host, 'n');
      await phase(host, 'open');
      await ada.locator('.play-message', { hasText: 'responded' }).waitFor();
      // A press before this phone has seen the buzzers reopen counts as early — wait for the light.
      await alan.locator('.buzzer[data-state="ready"]').waitFor();
      await alan.locator('.buzzer').tap();
      await alan.locator('.buzzer[data-state="won"]').waitFor();
      await key(host, 'y');
      await phase(host, 'clue_end');
      await tv.locator('.podium-score.negative').waitFor();
      await key(host, 'r');
      await key(host, ' ');
      await phase(host, 'board');

      // ---- The wager clue: chosen for Alan, who has the board; his phone takes the bid.
      await host.locator('.mini-cell.wager').first().click();
      await phase(host, 'wager_reveal');
      await tv.locator('.wager-word').waitFor();
      response = await hostResponse(host);
      await assertSecret([tv, ada, grace, alan], response);
      await key(host, ' ');
      await phase(host, 'wager');
      await alan.locator('.wager-input').fill('1');
      await alan.getByRole('button', { name: 'Lock in' }).click();
      await alan.locator('.panel-error', { hasText: 'whole number' }).waitFor();
      assert.equal(await grace.locator('.wager-input').count(), 0, 'only the selector wagers');
      await alan.locator('.wager-input').fill('500');
      await alan.getByRole('button', { name: 'Lock in' }).click();
      await phase(host, 'reading');
      await tv.locator('.clue-value', { hasText: '$500' }).waitFor();
      await key(host, ' ');
      await phase(host, 'responding');
      await key(host, 'y');
      await key(host, ' ');
      await key(host, ' ');
      await phase(host, 'board');

      // ---- End the round early (unplayed clues stay), introduce round two, end it too.
      host.once('dialog', (dialog) => void dialog.accept());
      await key(host, 'e');
      await phase(host, 'round_end');
      await tv.locator('.round-banner').waitFor();
      await key(host, ' ');
      await phase(host, 'round_intro');
      for (let i = 0; i < 7; i += 1) await key(host, ' ');
      await phase(host, 'board');
      await tv.locator('.tile.cell', { hasText: '$2,000' }).first().waitFor();
      host.once('dialog', (dialog) => void dialog.accept());
      await key(host, 'e');
      await phase(host, 'round_end');
      await key(host, ' ');

      // ---- The final: Ada (negative) sits out; the others wager privately and write.
      await phase(host, 'final_category');
      await ada.locator('.play-message', { hasText: 'sit out' }).waitFor();
      await key(host, ' ');
      await phase(host, 'final_wager');
      const finalResponse = (await host.locator('.host-response').innerText())
        .replace(/^RESPONSE\s*/i, '')
        .trim();
      for (const [phone, amount] of [
        [grace, '200'],
        [alan, '0'],
      ] as const) {
        await phone.locator('.wager-input').fill(amount);
        await phone.getByRole('button', { name: 'Lock in' }).click();
        await phone.locator('#final-wager-status', { hasText: 'locked in' }).waitFor();
      }
      // Wagers are private: nobody else's screen shows Grace's 200.
      assert.equal((await tv.locator('.screen').innerText()).includes('200'), false);
      await key(host, ' ');
      await phase(host, 'final_clue');
      await assertSecret([tv, ada, grace, alan], finalResponse);
      await key(host, ' ');
      await phase(host, 'final_response');
      await grace.locator('.final-input:not([disabled])').fill(`What is ${finalResponse}?`);
      await alan.locator('.final-input:not([disabled])').fill('What is the wrong answer?');
      await host.locator('.final-table td', { hasText: 'wrong answer' }).waitFor();
      assert.equal(
        (await tv.locator('body').innerText()).includes('wrong answer'),
        false,
        'responses are private until revealed',
      );
      host.once('dialog', (dialog) => void dialog.accept());
      await host.getByRole('button', { name: 'End thinking time now' }).click();
      await phase(host, 'final_reveal');

      // Revealed lowest score first: Grace (200) before Alan.
      for (const [name, right] of [
        ['Grace', true],
        ['Alan', false],
      ] as const) {
        await key(host, ' ');
        await tv.locator('.final-reveal .card-kicker', { hasText: name }).waitFor();
        await tv
          .locator('.final-response', { hasText: right ? finalResponse : 'wrong answer' })
          .waitFor();
        await key(host, right ? 'y' : 'n');
        await key(host, ' ');
        await tv.locator('.final-wager', { hasText: right ? '$200' : '$0' }).waitFor();
      }
      await key(host, ' ');
      await phase(host, 'game_over');

      // ---- The winner, on the TV and every phone; the host's statistics.
      await tv.locator('.game-over .card-title').waitFor();
      const winner = await tv.locator('.game-over .card-title').innerText();
      assert.ok(
        ['GRACE', 'ALAN'].some((name) => winner.toUpperCase().includes(name)),
        `winner shown: ${winner}`,
      );
      await grace.locator('.play-message', { hasText: /win/ }).waitFor();
      await host.locator('.stats-table').waitFor();
      assert.equal(await host.locator('.stats-table tbody tr').count(), 3);
    } finally {
      for (const other of contexts) await other.close();
    }
  },
  { allowErrors: [] },
);

browserTest('the editor: write a game, see what is missing, host it', async ({ page }) => {
  await page.goto(`${origin}/quiz/edit/`);
  await page.getByRole('button', { name: 'New game' }).click();
  await page.waitForURL(/\/quiz\/edit\/\d+#/);
  await page.locator('.edit-ready.no').waitFor();
  await page.locator('.edit-title').fill('Kitchen Table');
  // One category with one clue, in a one-round game.
  const categories = page.locator('.edit-category');
  await categories.first().fill('Cheeses');
  await page.locator('.edit-cell').first().click();
  await page.locator('.clue-input').fill('Holes are its trademark');
  await page.locator('.edit-side input[type=text]').first().fill('Swiss');
  await page.locator('.edit-status', { hasText: 'Saved' }).waitFor({ timeout: 5000 });
  // Still not ready: other categories have no title in round one, and round two and the final are empty.
  const problem = await page.locator('.edit-ready').innerText();
  assert.match(problem, /Not ready/);
  // Reload: the draft persisted.
  await page.reload();
  await page.locator('.edit-cell.filled').first().waitFor();
  assert.equal(await page.locator('.edit-title').inputValue(), 'Kitchen Table');
});
