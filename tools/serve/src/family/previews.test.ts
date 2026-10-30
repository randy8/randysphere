import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openDatabase } from './db.ts';
import type { Fetcher } from './outbound.ts';
import { metaTags, Previewer, spotifyByline } from './previews.ts';
import { FamilyStore } from './store.ts';
import type { Message } from './store.ts';

const TRACK = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';

const spotify: Fetcher = (url) =>
  Promise.resolve({
    status: 200,
    contentType: '',
    url,
    body: Buffer.from(
      url.includes('/oembed?')
        ? JSON.stringify({ title: 'Never Gonna Give You Up' })
        : '<meta content="Rick Astley · Song · 1987" property="og:description">',
    ),
  });

test('meta tags are read in any attribute order and quoting, entities decoded', () => {
  const tags = metaTags(
    `<meta property="og:title" content="A &amp; B"><META content='x' name='twitter:title'>
     <meta property="og:title" content="second">`,
  );
  assert.equal(tags.get('og:title'), 'A & B');
  assert.equal(tags.get('twitter:title'), 'x');
});

test('who a Spotify item is by, from its description, only where Spotify says it reliably', () => {
  const track = 'Rick Astley · Whenever You Need Somebody · Song · 1987';
  assert.equal(spotifyByline('track', track), 'Rick Astley');
  assert.equal(spotifyByline('album', 'Rick Astley · album · 1987 · 10 songs'), 'Rick Astley');
  assert.equal(spotifyByline('show', 'Podcast · Lex Fridman · Conversations…'), 'Lex Fridman');
  assert.equal(spotifyByline('playlist', 'The hottest 50. Cover: Tame Impala'), '');
  assert.equal(spotifyByline('artist', 'Artist · 8.6M monthly listeners.'), '');
});

test('messages from before previews existed get their cards too, as updates', async () => {
  const store = new FamilyStore(openDatabase(':memory:'));
  const mom = await store.createUser({
    username: 'mom',
    displayName: '妈妈',
    password: 'correct horse',
  });
  const { message } = store.postMessage({
    userId: mom.id,
    clientId: 'old-00001',
    body: `听 ${TRACK}?si=1`,
  });
  // As if sent before migration 11: no index of its links, nothing looked through.
  store.db.exec("DELETE FROM message_links; UPDATE meta SET value = 0 WHERE key = 'links_indexed'");

  const dir = mkdtempSync(join(tmpdir(), 'family-previews-'));
  writeFileSync(join(dir, 'f'.repeat(32)), 'left over');
  const updated: Message[] = [];
  const previewer = new Previewer({
    store,
    dir,
    fetch: spotify,
    onPreview: (messages) => updated.push(...messages),
    record: () => {},
  });
  assert.equal(existsSync(join(dir, 'f'.repeat(32))), false, 'unrecorded artwork is removed');
  previewer.sweep();
  await previewer.idle();

  assert.deepEqual(
    updated.map((m) => m.id),
    [message.id],
  );
  const card = updated[0]?.links[0]?.preview;
  assert.equal(card?.title, 'Never Gonna Give You Up');
  assert.equal(card?.subtitle, 'Rick Astley');
  assert.equal(card?.image, null, 'no artwork offered: a card without it');
  assert.ok((updated[0]?.rev ?? 0) > message.rev, 'a new rev, so a reconnect replays it');
  assert.equal(updated[0]?.sentRev, message.sentRev, 'but not a new message: receipts stay put');
  assert.equal(updated[0]?.body, `听 ${TRACK}?si=1`, 'the text is untouched');

  // Unsent, it keeps nothing of its links.
  store.db.exec('UPDATE messages SET created_at = ' + String(Date.now()));
  const gone = store.unsendMessage(mom, message.id).message;
  assert.deepEqual(gone.links, []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM message_links').get()?.['n'], 0);
});

test('a failed preview never replaces one that worked', () => {
  const store = new FamilyStore(openDatabase(':memory:'));
  store.savePreview({
    status: 'ok',
    preview: {
      url: TRACK,
      provider: 'spotify',
      kind: 'track',
      title: 'T',
      subtitle: '',
      image: null,
    },
  });
  store.savePreview({ status: 'failed', url: TRACK, provider: 'spotify', kind: 'track' });
  assert.equal(store.previewStatus(TRACK)?.status, 'ok');
});
