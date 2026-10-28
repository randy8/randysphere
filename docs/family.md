# Family chat

A private conversation for the family at **https://randyliang.net/family/**:
one group, each person with their own account, messages and photos kept on
this machine. Not a messaging platform: no public sign-up, no other rooms, no
third-party services.

Code: `tools/serve/src/family/`. Data: `private/family/` (git-ignored):
`chat.db` (SQLite) and `images/`. Nothing in the Astro build knows it exists.

## How it works

| Part      | Choice                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server    | Part of `tools/serve` (the existing production server), mounted at `/family/` before anything else is routed. No separate app.                                                                                                                                      |
| Storage   | Node's built-in SQLite (`node:sqlite`), WAL, `synchronous = FULL`: a message is on disk before its sender is told "Delivered". Migrations are `user_version`-numbered in `db.ts`, append-only.                                                                      |
| Live      | Server-Sent Events (`/family/api/events`). Every insert and deletion gets the next `rev`; a reconnecting browser sends the last rev it saw and gets exactly what it missed. 20 s heartbeats keep Cloudflare (100 s idle limit) and phone networks from dropping it. |
| Sending   | Each message carries a client-generated id, unique per author: a retry after a lost response returns the original instead of a duplicate. Unsent text survives a reload (localStorage outbox) and is retried with backoff until it goes through.                    |
| Accounts  | Username + password, hashed with Argon2id (`node:crypto`, 64 MiB, 3 passes). Sessions are random tokens, stored only as SHA-256 hashes, so they can be revoked; the cookie is `HttpOnly; Secure; SameSite=Lax`, 400 days, renewed as it's used.                     |
| Interface | Server-rendered page + one script (`static/chat.js`), no framework. Works without JavaScript too: the latest 50 messages and a form that posts.                                                                                                                     |

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
the photos. **It is a local copy on the same disk** — it protects against a
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
rather than deleting it.

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
- Every response is `private, no-store` and `noindex`.

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

## Not built (yet)

- Push notifications. iOS supports web push for home-screen apps, but it
  needs a notification permission flow and a key pair; worth doing only if
  people miss messages.
- Read receipts beyond your own "Delivered"; reactions; editing; search.
