# Deployment

How `randyliang.net` actually stays online, and the two commands that cover
almost everything you'll need: shipping a change, and recovering after this
box is rebuilt. See `docs/decisions.md`, 2026-08-17, for why it's shaped
this way.

## How a request reaches the site

```
browser
  → randyliang.net / www.randyliang.net
  → Cloudflare Tunnel                      (cloudflared-tunnel.service, user randy)
  → http://localhost:4322                  (photography-serve.service, user randy)
  → tools/serve reads site/dist/           (the live release, built by `pnpm deploy`)
                    and /p/... from generated/derivatives/ (written by `pnpm ingest`)
```

Port 4322 is the only production origin: the tunnel's ingress
(`~/.cloudflared/config.yml`) sends both hostnames there and everything
else to a 404. Port 4321 (`astro dev`) and 4500 (`pnpm run edit`) are
development tools in a login session; nothing public reaches them.

Both services are `systemd` system units, `enable`d (they start on boot,
no login needed) and `Restart=always` with a start limit (10 starts in 5
minutes, then systemd stops trying rather than looping). The tunnel
`Wants=` the server rather than `Requires=` it, so restarting the server
leaves the tunnel connected. `photography-watchdog.timer` checks health
every minute (below). The unit files and the tunnel's `config.yml` live in
`deploy/` as the source of truth; the live copies are in
`/etc/systemd/system/` and `~/.cloudflared/`.

## Commands

| Command                                                    | What it does                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm status`                                              | Services, restarts, origin health, public check, live and previous release, disk, memory, the last day's errors. Start here in an outage. |
| `pnpm deploy`                                              | Ship what's in the working tree (below).                                                                                                  |
| `pnpm rollback`                                            | Swap the live release with the previous one; run again to swap back.                                                                      |
| `curl -s localhost:4322/healthz`                           | Is the origin able to serve? JSON naming what's missing if not.                                                                           |
| `journalctl -u photography-serve -u cloudflared-tunnel -f` | Live logs.                                                                                                                                |
| `journalctl -u photography-watchdog --since today`         | What the watchdog saw and did.                                                                                                            |
| `sudo systemctl restart photography-serve`                 | Restart the website (about a second; the tunnel stays up).                                                                                |
| `sudo systemctl restart cloudflared-tunnel`                | Restart the tunnel (a few seconds of Cloudflare errors while it reconnects).                                                              |

## Shipping a change: `pnpm deploy`

`deploy/deploy.sh`, in order, stopping at the first failure with nothing
changed in production:

1. **originals/ is mounted** — at least as many batch directories as
   manifests, because `pnpm ingest` deletes a batch's manifest and captions
   when its originals are missing.
2. **Dependencies** match the lockfile (`pnpm install --frozen-lockfile`).
3. **`pnpm verify`** — format, lint, types, every test, a trial build.
4. **`pnpm sync`** — new photographs and films.
5. **Build the next release into `site/dist.next/`**, beside the live one,
   with `build-info.json` recording the commit (`-dirty` if the tree had
   uncommitted changes), the time, and a hash of the server's code.
6. **Candidate check** — a second server on `:4398` serves the new release;
   `/healthz` must pass, `/exposures/` must be the Exposures page and serve a
   real photograph, `/pictures/` must list films.
7. **Switch** — two renames: `dist` → `dist.prev`, `dist.next` → `dist`.
   The server reads `site/dist` from disk on every request, so a content
   change needs **no restart and has no downtime**. Only when the server's
   own code changed is `photography-serve` restarted (about a second; a
   request in that gap gets a 502 from cloudflared — the tunnel stays up).
8. **Production check** — the same checks against `:4322`. If they fail,
   `pnpm rollback` runs automatically and the deploy exits non-zero.
9. **Public check** — `https://randyliang.net/exposures/`. A failure here is
   reported but doesn't roll back: the origin was just proven healthy, so
   it's the tunnel or Cloudflare.

The restart needs no password: `/etc/sudoers.d/photography-deploy` allows
exactly that one command for `randy`, nothing else:

```
randy ALL=(root) NOPASSWD: /usr/bin/systemctl restart photography-serve
```

Set up on a new machine with
`echo '<that line>' | sudo tee /etc/sudoers.d/photography-deploy && sudo chmod 440 /etc/sudoers.d/photography-deploy && sudo visudo -cf /etc/sudoers.d/photography-deploy`;
remove with `sudo rm /etc/sudoers.d/photography-deploy`.

## Rolling back: `pnpm rollback`

Swaps `site/dist` and `site/dist.prev` and re-runs the production check.
Nothing is deleted, so running it again rolls forward. It's a file swap
with no restart: zero downtime. It covers the **built site** only — the
server's code comes from the repository, so undoing a server change is
`git revert <commit>` and `pnpm deploy`. Only one previous release is kept
(about 4 MB); originals, derivatives, manifests and `.env` are never part
of a release and are never touched.

## Health and the watchdog

`/healthz` (tools/serve/src/health.ts) answers 200 only when the built
front page is readable, an album manifest parses, and a photograph that
manifest names is on disk; 503 otherwise, with which check failed.

`photography-watchdog.timer` runs `deploy/watchdog.sh` every minute, as
randy:

- **Origin**: the same checks the deploy uses. A crash is systemd's job
  (`Restart=always`); this catches a server that runs but doesn't serve.
  Three consecutive failures — never one blip — and it logs diagnostics
  (unit status, the port, memory, disk, the last 30 log lines) and
  restarts `photography-serve`. Bounded by the unit's start limit.
- **Public**: `https://randyliang.net/healthz`. Failures are logged and
  counted, never acted on — a Cloudflare or network problem is not a
  reason to restart a healthy origin.

## Installing or updating the units

Each step and how long the site is affected:

```sh
sudo cp deploy/photography-serve.service deploy/cloudflared-tunnel.service \
        deploy/photography-watchdog.service deploy/photography-watchdog.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload                       # no effect on running services
sudo systemctl restart photography-serve           # ~1s; on the old tunnel unit this also restarts the tunnel (~2-3s)
sudo systemctl restart cloudflared-tunnel          # ~2-3s while it reconnects to Cloudflare
sudo systemctl enable --now photography-watchdog.timer
```

**Verify** — `pnpm status` shows all three active; `curl -s
localhost:4322/healthz` is `"ok":true`; `systemctl show cloudflared-tunnel
-p Requires -p Wants` lists `photography-serve` under Wants only; and
`sudo systemctl restart photography-serve` leaves the tunnel's
`ActiveEnterTimestamp` unchanged.

**Undo** — the previous units are in git history:
`git show <commit>:deploy/photography-serve.service | sudo tee /etc/systemd/system/photography-serve.service`
(same for the tunnel), `sudo systemctl disable --now photography-watchdog.timer`,
`sudo systemctl daemon-reload`, then restart both services.

## Updating cloudflared

The tunnel runs with `--no-autoupdate`, so it changes only when you do:

```sh
~/.local/bin/cloudflared update        # replaces the binary; the running tunnel is unaffected
sudo systemctl restart cloudflared-tunnel
~/.local/bin/cloudflared --version
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

4. **Install and enable the services and the watchdog**:

   ```sh
   sudo cp deploy/*.service deploy/*.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now photography-serve
   sudo systemctl enable --now cloudflared-tunnel
   sudo systemctl enable --now photography-watchdog.timer
   ```

From here on, `pnpm deploy` is the only command you need for routine
updates.
