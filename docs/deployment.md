# Deployment

How `randyliang.net` actually stays online, and the two commands that cover
almost everything you'll need: shipping a change, and recovering after this
box is rebuilt. See `docs/decisions.md`, 2026-08-17, for why it's shaped
this way.

## How a request reaches the site

```
browser
  → randyliang.net / www.randyliang.net
  → Cloudflare Tunnel                      (cloudflared-tunnel.service)
  → http://localhost:4322                  (photography-serve.service, i.e. `pnpm serve`)
  → tools/serve reads site/dist/           (built by `pnpm build`)
```

Both services are `systemd` units, `enable`d (so they start on boot) with
`Restart=on-failure` (so a crash comes back on its own). `cloudflared-tunnel`
also declares `Requires=photography-serve`, so the tunnel only comes up once
the site is actually listening, and stops first on shutdown. No manual step
is needed after a reboot — this is the "revisit if" condition from the
2026-08-08 decision entry, now satisfied.

The unit files and the tunnel's `config.yml` are committed under `deploy/`
as the source of truth. If you ever hand-edit the live copy in
`/etc/systemd/system/` or `~/.cloudflared/`, copy the change back into
`deploy/` (or vice versa) so they don't drift apart.

## Day to day: shipping a change

```sh
pnpm deploy
```

This is `pnpm sync && pnpm build && sudo systemctl restart photography-serve`
— it re-encodes/publishes any new photographs (a no-op if nothing changed
under `originals/`), rebuilds the static site, and restarts the server so it
picks up the new `site/dist/`. `sudo` will prompt for your password unless
you've set up passwordless `systemctl restart` for this one unit.

It's just those three commands chained — nothing stops you from running
them individually, e.g. to `pnpm build` and eyeball `site/dist/` before
restarting the live process.

**Before running it**, this project's own standard still applies: `pnpm
verify` (or at least `pnpm typecheck && pnpm test`) on whatever you're about
to ship. `pnpm deploy` does not run the test suite for you — it assumes
you already did, the same way `git push` doesn't run CI for you locally.

## Checking on it

```sh
systemctl status photography-serve cloudflared-tunnel   # both should be "active (running)"
journalctl -u photography-serve -f                      # tail the site's own logs
journalctl -u cloudflared-tunnel -f                      # tail the tunnel's logs
```

## Recovering on a fresh box

If this machine is ever rebuilt from scratch, this is everything production
needs beyond a normal `pnpm install`:

1. **Install `cloudflared`** and log it into your Cloudflare account, then
   either restore the existing tunnel's credentials file or create a new
   tunnel and update `deploy/cloudflared-config.yml`'s `tunnel:`/
   `credentials-file:` to match:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create photography          # only if the old tunnel/credentials are gone
   cp deploy/cloudflared-config.yml ~/.cloudflared/config.yml
   # then edit ~/.cloudflared/config.yml if the tunnel ID changed
   ```

   The credentials JSON (`~/.cloudflared/<tunnel-id>.json`) is a secret —
   it's never committed, and is the one piece `deploy/` can't hand you back.
   Keep a copy of it somewhere durable (a password manager, encrypted
   backup) outside this repo.

2. **Write `.env`** at the repo root (copy `.env.example` and fill it in) —
   `PRIVATE_SITE_PASSWORD` and `PRIVATE_SESSION_SECRET` are required for
   `pnpm serve` to start at all; generate the secret with
   `openssl rand -hex 32`. The R2/TMDB/Anthropic keys are only needed if
   you also run `pnpm run publish`, `pnpm films:posters`, or `pnpm describe`
   on this box.

3. **Build once by hand**, since the systemd unit only serves an existing
   build, it doesn't create one:

   ```sh
   pnpm install
   pnpm sync && pnpm build
   ```

4. **Install and enable both services**:

   ```sh
   sudo cp deploy/photography-serve.service deploy/cloudflared-tunnel.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now photography-serve
   sudo systemctl enable --now cloudflared-tunnel
   ```

From here on, `pnpm deploy` is the only command you need for routine
updates.
