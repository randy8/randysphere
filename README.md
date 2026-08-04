# Photography

A static photography portfolio. Two independent halves:

- **`site/`** — an Astro application that renders HTML and nothing else. It never
  reads, resizes, or serves a photograph.
- **`tools/pipeline/`** — a plain Node program that turns your original files
  into web derivatives, uploads them to object storage, and writes a manifest.
  It knows nothing about Astro and will still work if the site is replaced.

The only thing connecting them is a JSON manifest under `generated/`. Image
bytes and site bytes travel separate paths and meet in the browser.

---

## Quick Start (macOS)

Everything below is copy-and-paste. Most of the time is the first AVIF encode.

### 1. Prerequisites

```sh
# Homebrew, if you do not already have it.
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node 24. fnm reads .node-version and picks the right one automatically.
brew install fnm
echo 'eval "$(fnm env --use-on-cd)"' >> ~/.zshrc && exec zsh

cd path/to/photography
fnm install && fnm use          # installs the version in .node-version

# pnpm, via Corepack, at the version pinned in package.json.
corepack enable

node --version                  # expect v24.14.1
pnpm --version                  # expect 11.x
```

### 2. Install

```sh
pnpm install
```

If it refuses because of the Node version, that is `engine-strict` working
correctly — go back and run `fnm use`.

### 3. Add photographs

Originals live in `originals/<album-slug>/`. That directory is git-ignored and
nothing in this repository ever uploads it.

Pick a URL-shaped slug (lower-case, hyphens) and copy photographs into it:

```sh
mkdir -p originals/kamakura-in-rain
cp ~/Pictures/export/*.jpg originals/kamakura-in-rain/
```

A batch may also hold rolls — any subdirectory containing images directly, at
any depth — in which case each is scanned separately:

```sh
mkdir -p originals/kamakura-in-rain/0827
cp ~/Pictures/export/roll-1/*.tif originals/kamakura-in-rain/0827/
```

The repository ships with no sample photographs: everything under
`originals/` is git-ignored, so a fresh clone has an empty archive until you
add one.

> **Do this before running `pnpm ingest` on a fresh clone.** Ingest treats any
> committed manifest whose batch is missing from `originals/` as an orphan and
> deletes it, along with that batch's entire `albums/<slug>/` directory —
> captions, tags, and all. On a clone with an empty `originals/`, that is
> _every_ batch, on the first run, with no confirmation. `--album <slug>`
> does not narrow it: the orphan sweep always considers every slug. Either
> populate `originals/` first, or expect to `git restore` afterwards.

Files sort by name and that becomes the album's default sequence, so number
them if the order matters. JPEG, PNG, TIFF and WebP are read; HEIC is not.

### 4. Ingest, then publish locally

```sh
pnpm ingest              # encode derivatives, write generated/albums/*.json
pnpm publish:local       # copy them into site/public/ so the dev server sees them
```

`ingest` is safe to re-run: the second run encodes nothing.

If you added your own album, ingest will have created `albums/<slug>/album.md`
and `albums/<slug>/photos.yaml`. Open the second one and write the alt text —
ingest reports how many are still empty.

### 5. Run it

```sh
pnpm dev
```

Open **<http://localhost:4321/>**. The homepage lists albums; click one for the
gallery.

For the production build instead:

```sh
pnpm build && pnpm preview       # also http://localhost:4321/
```

### 6. Look at it from your phone, over Tailscale

The dev server stays bound to localhost; Tailscale proxies to it over your
tailnet with a real HTTPS certificate. Nothing is exposed to the internet.

```sh
brew install --cask tailscale
open -a Tailscale                # sign in, then:
tailscale up
```

Then, with `pnpm dev` running in one terminal:

```sh
tailscale serve --bg 4321        # proxy the tailnet to localhost:4321
tailscale serve status           # prints the https://<machine>.<tailnet>.ts.net URL
```

Open that URL on any device signed into the same tailnet. To stop:

```sh
tailscale serve reset
```

`astro.config.mjs` already allows the `.ts.net` suffix in Vite's `allowedHosts`.
Without it every request over the tailnet returns "Blocked request".

### Checking it worked

```sh
pnpm doctor              # should report only that nothing is published to R2 yet

# The rotated sample must be described as portrait: height greater than width.
grep -A4 '"file": "003.jpg"' generated/albums/sample-album.json

# The GPS-bearing sample must have leaked nothing.
grep -ri 'GPS\|Latitude\|Longitude' generated/albums/ ; echo "exit $? — 1 means clean"

# Only content-addressed derivatives are public; no original filenames.
find site/public/p -type f | head
```

---

## Commands

```sh
pnpm dev               # dev server on :4321
pnpm dev:host          # same, bound to 0.0.0.0
pnpm build             # static site into site/dist/
pnpm preview           # serve the built site
pnpm ingest            # encode derivatives, rewrite manifests
pnpm publish:local     # publish into site/public/ instead of a bucket
pnpm sync              # ingest + publish:local, one command
pnpm run publish       # publish to Cloudflare R2 (needs .env)
pnpm describe          # draft alt text/captions for photos missing one (needs .env)
pnpm doctor            # report drift, change nothing
pnpm typecheck         # tsc, both packages
pnpm test              # node:test
pnpm lint              # ESLint
pnpm format            # Prettier
pnpm verify            # all of the above, in the order CI runs them
```

`publish` is a built-in pnpm command, so the image publisher is
`pnpm run publish`. `pnpm publish:images` is the unambiguous alias.

---

## Layout

```
site/                  Astro application
tools/pipeline/        Image pipeline. No Astro, no Vite, no Tailwind.
originals/             Your master files. Git-ignored, never uploaded.
                       One directory per album; rolls are any subdirectory
                       (at any depth) that holds images directly — a flat
                       album with files straight inside still works too.
generated/
  albums/*.json        Manifests. Committed: this is the contract.
  derivatives/         Encoded output. Git-ignored, rebuildable.
  descriptions.json    Cache for `pnpm describe`. Git-ignored, rebuildable.
albums/                Album text, per-roll notes, and per-photo captions.
recipes/               The recipes collection: one hand-written YAML file
                       per recipe, read straight off disk. No pipeline.
docs/                  Architecture, decisions, dependencies, verification.
```

## Principles

Applied literally rather than aspirationally:

1. **Performance.** The site should disappear and leave the photographs.
2. **Simplicity.** Boring, proven, obvious. Readability over cleverness.
3. **Maintainability.** Every file has a reason to exist and every dependency
   has a written justification in [`docs/dependencies.md`](docs/dependencies.md).
4. **No unnecessary JavaScript.** The gallery works with scripting disabled.

Consequences worth knowing:

- There is **no build step** for the pipeline. Node runs the TypeScript source
  directly; `tsc` is only a type checker. See [`docs/decisions.md`](docs/decisions.md).
- Your originals are **never committed and never uploaded**. Only derivatives
  leave your machine.
- GPS coordinates cannot reach the site by accident. Camera metadata is copied
  by allow-list, so location appears only if you type it into an album yourself.

## Before you publish this as your own

1. `LICENSE` — the copyright holder.
2. `site/src/config.ts` — title, description, your name, image base URL.
3. `site/astro.config.mjs` — the `site` URL.
4. `pipeline.config.ts` — the R2 bucket name.
5. `.env` — copy from `.env.example`; needed only to publish to R2.
6. `albums/` and `originals/` — your work, replacing the sample album.

## Licensing

The **source code** is MIT licensed; see [`LICENSE`](LICENSE). The four files in
`samples/` are covered by it too.

**Real photographs are not.** Anything you add under `originals/`, `albums/`, or
`generated/` belongs to whoever made it and carries no licence from this
repository. If you fork this to build your own portfolio, bring your own
pictures.
