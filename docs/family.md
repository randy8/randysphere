# Family chat

A private conversation for the family at **https://randyliang.net/family/**:
one group, each person with their own account, messages and photos kept on
this machine. Not a messaging platform: no public sign-up, no other rooms, no
third-party services.

Code: `tools/serve/src/family/`. Data: `private/family/` (git-ignored):
`chat.db` (SQLite) and `images/`. Nothing in the Astro build knows it exists.

## Disc

The same code runs a second, entirely separate chat at
**https://randyliang.net/disc/**. Separate means: its own database and
photos (`private/disc/`), its own accounts and passwords, its own sign-in
cookie (sent only to `/disc`), its own notifications and home-screen app.
Nothing on a Disc page links to Family, a Family sign-in opens nothing
there (nor the reverse), and a message can't cross between them.
Everything in this document applies to it with `pnpm disc` in place of
`pnpm family` and `/disc/` in place of `/family/`:

```sh
pnpm disc add randy --name=Randy --admin   # its first account: yours
pnpm disc list
pnpm disc backup
```

The chats are listed in `tools/serve/src/family/chats.ts`; another one is
an entry there and a script in `package.json`.

## How it works

| Part      | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server    | Part of `tools/serve` (the existing production server), mounted at `/family/` before anything else is routed. No separate app.                                                                                                                                                                                                                                                                                                                  |
| Storage   | Node's built-in SQLite (`node:sqlite`), WAL, `synchronous = FULL`: a message is on disk before its sender is told "Delivered". Migrations are `user_version`-numbered in `db.ts`, append-only.                                                                                                                                                                                                                                                  |
| Live      | Server-Sent Events (`/family/api/events`). Every insert and deletion gets the next `rev`; a reconnecting browser sends the last rev it saw and gets exactly what it missed. 20 s heartbeats keep Cloudflare (100 s idle limit) and phone networks from dropping it.                                                                                                                                                                             |
| Sending   | Each message carries a client-generated id, unique per author: a retry after a lost response returns the original instead of a duplicate. Unsent text survives a reload (localStorage outbox) and is retried with backoff until it goes through.                                                                                                                                                                                                |
| Accounts  | Username + password, hashed with Argon2id (`node:crypto`, 64 MiB, 3 passes). Sessions are random tokens, stored only as SHA-256 hashes, so they can be revoked; the cookie is `HttpOnly; Secure; SameSite=Lax`, 400 days, renewed as it's used.                                                                                                                                                                                                 |
| Interface | Server-rendered page + plain ES modules (`static/chat.js` and the modules it imports), no framework, no build step: at startup the server stamps every relative import with one shared version and the page preloads them, so they arrive together. Works without JavaScript too: the latest 50 messages and a form that posts.                                                                                                                 |
| Notify    | Web Push (RFC 8291 encryption, RFC 8292 VAPID) in `webpush.ts`, `node:crypto` only. A service worker (`static/sw.js`) shows notifications and does nothing else — no `fetch` handler, so nothing private is ever cached.                                                                                                                                                                                                                        |
| Changes   | Edit (own text, 15 min, 5 times, every version kept in `message_edits`), Undo Send (own, 2 min: text, versions, Tapbacks and photo are deleted, the row stays as "… unsent a message"), Tapbacks (`reactions`, one per person). Each change moves the message's `rev` (so a reconnect replays it as an `update`); `sent_rev` keeps the rev it was sent at, which read positions and unread counts use. A Tapback notifies the message's author. |

The reasoning, and what was rejected, is in `docs/decisions.md`
(2026-10-28, "Family chat").

## First-time setup

On the server, make your own account (admin), then everyone else's from the
Members page:

```sh
pnpm family add randy --name=Randy --admin       # asks for a password
```

Deploy (`pnpm deploy`; the server restarts because its code changed). Then
sign in at `/family/`, open **⋯ → Members**, and add each person: display
name (Chinese is fine: 妈妈), a username they'll type on a phone (`mom`), a
password, and their language (中文 gives them a Chinese interface).

Give each person their username and password however you'd give a house key:
in person or by phone, not in WeChat.

### On their phone

1. Open `https://randyliang.net/family/` **in Safari** (not inside WeChat; see
   below), sign in once. Safari offers to save the password.
2. Share → **Add to Home Screen**. It opens full-screen like an app, with its
   own icon. A home-screen app keeps its own sign-in, separate from Safari's,
   so sign in once more there. After that, nobody is asked again for over a
   year as long as they open it now and then.

### Notifications

Each device turns them on for itself: **tap the conversation's title →
Notifications → Turn On Notifications**. Permission is asked only then,
never on opening the page.

- **iPhone / iPad (iOS 16.4+):** only from the Home Screen app. In Safari
  the Details sheet says so; add Family to the Home Screen (above), open it
  from there, then turn notifications on.
- **Android (Chrome):** works in the browser or installed (Chrome offers
  "Install app" / "Add to Home screen"). Needs Google Play services — see
  China, below.
- **Mac / Windows / Linux:** Chrome, Edge, Firefox and Safari all work in
  an ordinary tab.

**Send Test Notification** (same sheet) proves the whole path to that
one device.

What a notification says is per device. By default only **“New message”**
— nothing about who or what, since lock screens are seen by others. **Show
Name and Message** adds the sender and first line. Either way the content
is encrypted for that browser alone; Apple, Google or Mozilla carry it but
can't read it.

Nobody is notified for their own messages, or while they have the
conversation on screen (the page tells the server it's visible every 25 s;
the claim lapses after 40 s, so a phone that slept without saying so is
notified again). The app icon's badge is the unread count, cleared once
read on any device.

A device's subscription belongs to its sign-in: signing out, **Sign out
everywhere**, a new password or a disabled account stop its notifications
too. Subscriptions the push service reports gone (404/410) are deleted at
once; one failing for other reasons is deleted after 20 failures in a row.
The server's key is `private/family/vapid.json`, made on first start and
copied by backups — replacing it would silently unsubscribe every device.

## Accounts

Members page (`/family/admin`, admins only; everyone else gets a 404), or the
terminal:

```sh
pnpm family list                       # who, last seen, how many devices
pnpm family add <user> --name=<name> [--lang=zh] [--admin]
pnpm family passwd <user>              # also signs them out everywhere
pnpm family rename <user> <display name>
pnpm family disable <user>             # signed out, can't sign in; messages stay
pnpm family enable <user>
pnpm family revoke <user>              # signed out everywhere (a lost phone)
```

Two options to `add`:

- `--suggest-change` — a starter password (any length, even the username).
  After signing in with it they're offered **Choose a Password** once;
  **Not Now** keeps the starter. Anyone can change theirs later from the
  ⋯ menu (Change Password), which signs out their other devices.
- `--same-password-as=<chat>` — the password this username already has in
  another chat, copied as its hash: how the owner has one password for
  every chat (`pnpm disc add randy --name=Randy --admin --same-password-as=family`).
  It's a copy: changing it in one chat later doesn't change the other.

**Read receipts.** Under your newest message, as in iMessage: "Delivered",
then "Read by Mom", "Read by Mom and Derrick", or "Read" once everyone has.
It follows each person's read position (`users.last_read_rev`), which moves
when they're at the bottom of the open conversation, and changes live (a
`read` event). Long-press one of your own messages → **Info**, as in
WhatsApp: who read it and when (`message_reads`, stamped as their position
passes it), and who hasn't yet. Only the author can see a message's Info.
Messages read before receipts existed show as read, without a time.

**Search** (⋯ menu → Search, `/<chat>/search?q=`) finds messages in the chat
you're signed in to — its own database, so never another chat's — newest
first, up to 50, deleted messages never. A plain form and links (works
without JavaScript); a result opens the conversation scrolled to it.

Deleting an account (Members page only, type the username to confirm) also
deletes everything that person sent. Disable instead to keep the history.

Anyone can delete their own messages (long-press or right-click → Delete);
an admin can delete anyone's. A deleted message, and its photo file, are gone
from the server and from every open screen.

## Backups

```sh
pnpm family backup                     # → private/family-backups/<time>/
pnpm family backup /mnt/somewhere/     # or anywhere
```

Safe while the server runs (`VACUUM INTO`, a consistent snapshot) and copies
the photos and the notification key. **It is a local copy on the same disk** — it protects against a
mistake, not against the disk. Until the NAS exists (see the backups note),
copy `private/family-backups/` somewhere else by hand now and then.

Restore:

```sh
sudo systemctl stop photography-serve
pnpm family restore private/family-backups/<time>
sudo systemctl start photography-serve
```

Restore refuses while the server is running, checks the backup's integrity
first, and moves the current chat aside (`private/family-replaced-<time>/`)
rather than deleting it. It also gives the database a new **epoch**: a
browser still holding revs from before the restore starts over from the
restored conversation instead of waiting for (or skipping) revs that
belong to the old one.

**Off this machine.** Backups are deliberately deferred until the NAS
exists. When it does: run `pnpm family backup` from a daily timer into a
dated directory, sync `private/family-backups/` to the NAS (rsync or
restic), keep 14 dailies and 12 monthlies, and once a month restore the
newest into a scratch directory and open it
(`sqlite3 <dir>/chat.db 'PRAGMA integrity_check'`, then count messages)
— a backup never restored is a hope, not a backup. A backup's `chat.db`
and `images/` are only consistent with each other as one directory: copy
it whole.

Photos uploaded but never sent (the page closed between uploading and
sending) are deleted after a day, hourly.

## Diagnostics

The Members page shows, per person: their devices and when each was last
used, open live connections (device, country — Cloudflare's `CF-IPCountry`,
so "CN" means it really is arriving from China — and the last rev delivered
to it), plus recent events since the server started: sign-ins (and failures,
with the username tried, never a password), reconnects and how much was
replayed, duplicate sends absorbed, rate limits, rejected uploads. Message
content is never logged anywhere.

## Security

- Every route resolves the session first; there is no URL to a message, a
  photo, or the event stream that works without one (tests:
  `routes.test.ts`, and the deploy's smoke test against production).
- The author of a message is always the signed-in account; nothing in a
  request can name someone else.
- Sign-in: five failures in 15 minutes lock that address, and separately that
  username, for the rest of the window. An unknown username takes as long as
  a wrong password.
- A request whose `Origin` is another site is refused, on top of the
  SameSite cookie.
- Strict Content-Security-Policy on every page (`default-src 'none'`, scripts
  from this origin only); message text is only ever inserted as text.
- Photos: the type is read from the bytes (JPEG, PNG, GIF, WebP only), at most
  15 MB, stored under a random name, served with `sandbox` CSP and never
  cached by Cloudflare. The phone re-encodes photos before upload, which
  removes their location metadata.
- Every response is `private, no-store` and `noindex`. Plain HTTP is
  redirected to HTTPS before anything else is read (`arrivedOverHttp`).
- Notifications are only ever posted to Apple's, Google's, Mozilla's and
  Microsoft's push services (`isPushEndpoint`): a crafted "subscription"
  can't make this server send requests anywhere else, its own loopback
  services included. A page can mark only its own stream as visible.

**What it is not:** end-to-end encrypted. Traffic is HTTPS to Cloudflare and
encrypted again through the tunnel to this machine, but Cloudflare terminates
TLS (as for the whole site), and messages are stored unencrypted in
`chat.db` on this machine's disk. Anyone with this machine, or a backup, can
read them.

## Reaching it from mainland China

What's known, and what to watch:

- **Cloudflare, not China's network.** randyliang.net is served by
  Cloudflare's global network; its in-China network needs an Enterprise plan
  and an ICP licence. Visitors in China are routed to POPs outside the
  mainland (often the US West Coast or Hong Kong). It is normally reachable,
  but expect 200–600 ms round trips and some packet loss, worst in the
  Beijing evening (20:00–23:00). The chat is built for that: small pages, one
  connection, automatic reconnects, retries, no duplicates.
- **Nothing from blocked hosts.** No Google fonts, scripts, sign-in, CAPTCHA,
  Firebase or analytics; every byte comes from randyliang.net (the CSP
  enforces it). Sign-in needs no email or SMS.
- **WeChat's built-in browser** often warns about, or blocks, links to
  domains without an ICP filing. Open the link in Safari ("在浏览器打开"), and
  use the home-screen icon from then on.
- **Long-lived connections** get reset by middleboxes; the 20 s heartbeat and
  replay-from-rev are what make that harmless. If someone's screen ever lags,
  pulling down or switching away and back reconnects at once.
- **Tunnel stalls on this end.** On 2026-10-28 the Cloudflare tunnel (QUIC)
  showed random 1–15 s stalls even from the US; switching cloudflared to
  `protocol: http2` is the proposed fix (pending). Fix that first, or it will
  look like a China problem.

How to test, cheaply:

1. **Probes from inside China**: itdog.cn (网站测速, HTTP mode) and boce.com
   test the URL from dozens of cities across China Telecom, Unicom and Mobile
   at once. Test `https://randyliang.net/family/` (the sign-in page is public)
   in the morning and again in the evening.
2. **The real thing**: have your mother sign in, then look at the Members
   page: her live connection should show "from CN", and "delivered up to #"
   should keep pace with the conversation. Ask her to try on Wi-Fi and on
   mobile data.
3. **Blocking checks**: greatfire.org's analyzer shows whether the domain or
   Cloudflare's IPs are being interfered with.

If it turns out unreliable: the usual fix is a small VPS with good China
routing (Hong Kong or Japan, "CN2 GIA") as a reverse proxy in front of this
server, not a different chat design.

**Notifications from China.** iPhones in mainland China receive web push
normally (Apple's push service works there). Android phones sold in China
usually have no Google Play services, so Chrome's push has nowhere to
deliver: the sheet's **Turn On** fails with a clear message, and the chat
still works, just without notifications. Notifications are sent from this
server to Apple/Google, so nothing extra has to be reachable from China.

## Not built (yet)

- Taking back a notification already shown for a message that is then unsent (a push must show something on iPhone, so it can't silently close one).
