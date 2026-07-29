# CLAUDE.md

Operating guide for Claude Code sessions in this repository. Read this before
making changes; it captures decisions and constraints that would otherwise
have to be re-derived every session. See `docs/decisions.md` for the reasoning
behind each one, `docs/dependencies.md` for why each dependency exists, and
`CHANGELOG.md` for how the project got here.

## What this project is

A personal, long-term photography archive and photojournal — not a
conventional portfolio, not a social-media-style gallery. The experience
should feel closer to reading a well-designed photography book than operating
a web app: trips/stories are what a visitor browses, photographs are shown
large and unhurried, and the site disappears in favor of the pictures. No
engagement mechanics, no feeds, no chrome that isn't earned.

Two independent halves, connected only by a committed JSON manifest:

- **`tools/pipeline/`** — a plain Node/TypeScript program (no bundler, no
  Astro, no Vite) that turns original photographs into web derivatives and
  writes the manifest. Runs fully offline and deterministically, except for
  the optional R2 publish step and the optional `pnpm describe` step.
- **`site/`** — an Astro app that renders HTML from the manifests. It never
  reads, resizes, or serves a photograph directly; it only requests derivative
  URLs the pipeline already produced.

## Architecture and data flow

```
originals/<trip-slug>/[<roll>/]*.{jpg,png,tif,webp}   (git-ignored, immutable)
        │  pnpm ingest
        ▼
generated/albums/<trip-slug>.json    (committed manifest — the contract)
generated/derivatives/p/<hash>/...   (git-ignored, rebuildable cache)
        │  pnpm publish:local  or  pnpm run publish
        ▼
site/public/p/...  (local dev/build)   or   R2 bucket (production)
        │  astro build / astro dev
        ▼
site/dist/ or http://localhost:4321
```

- `pnpm ingest` is a pure function of `originals/` + `pipeline.config.ts`: run
  it twice with nothing changed and `git status` is clean. It never touches
  the network.
- Publishing is a **real copy**, not a symlink. `site/public/p/` and
  `generated/derivatives/` are both git-ignored; the `Storage` interface
  (`tools/pipeline/src/storage/`) has a local-disk implementation and an R2
  implementation, and local dev must go through the same copy step production
  does. A symlink here was tried and removed earlier in this project's history
  — it silently broke production builds by leaking a git-ignored path into
  `dist/`. Do not reintroduce one.
- A photo's identity in the manifest is `sourceId` (SHA-256 of the original
  file's bytes, not pixels) and its `file` path (relative to the album
  directory, roll included). Renaming or moving a file under `originals/` is a
  rename from the pipeline's point of view: the old `photos.yaml` entry is
  dropped and a new one is scaffolded empty. **Captions do not survive a file
  move.** Caption/write before restructuring `originals/`, or expect to
  re-describe.
- The manifest schema is versioned (`SCHEMA_VERSION` in
  `tools/pipeline/src/manifest.ts`, currently **2**). A schema bump is
  intentionally a hard break: old manifests are rejected outright and
  `pnpm ingest` regenerates everything from `originals/` — there is no
  migration path by design. Expect a full re-encode after any schema bump.

## Archive hierarchy and the film-roll model

`originals/<trip-slug>/` no longer has to be a flat folder of files. Ingest
recursively scans for **rolls**: any directory that directly contains at least
one supported image file, at any depth. Nothing is hardcoded about depth or
naming (no city lists, no fixed folder levels) — a flat album (files directly
in the trip directory) is just a roll with id `.`; `originals/paris-2025/0827/`
or `originals/x/europe/paris/0827/` are found the same way.

- A photo's manifest `file` is its path relative to the album directory
  (`0827/001.tif`, or `001.tif` at the root) — this is the uniqueness
  guarantee once an album can hold more than one roll.
- Every photo records a `roll` field. The manifest also carries a top-level
  `rolls: { id, photoCount }[]`, and `albums/<slug>/rolls.yaml` lets a
  photographer add roll-level notes (film stock, etc.), synced the same
  loss-free way `photos.yaml` is.
- **Trips are the public browsing unit; rolls are not first-class routes
  yet.** Rolls are first-class *data* — the manifest already exposes
  everything a `/projects/<slug>/<roll>/` route would need — but nothing
  renders one today. Adding that route later is a presentation decision, not
  a data migration. Don't add roll pages speculatively.

## Directory map

```
site/                       Astro application
  src/pages/                index + /projects/<slug>/
  src/components/           Photo.astro, Browse.astro (continuous-scroll
                             reading view — not a modal lightbox)
  src/scripts/browse.ts     client-side browse-mode logic, progressive
                             enhancement over plain <a> links
  src/lib/manifest.ts       the site's OWN manifest reader/validator —
                             deliberately not shared with the pipeline
                             (see docs/decisions.md, "type-only boundary")
tools/pipeline/
  src/sources.ts            listAlbumSlugs, listRolls, flattenRolls
  src/ingest.ts              encode + write manifests + sync albums/*
  src/manifest.ts            schema, validation, SCHEMA_VERSION
  src/album-files.ts         photos.yaml / rolls.yaml sync, setPhotoDescription
  src/describe/              optional AI-description stage (see below)
  src/storage/                local + R2 publish targets behind one interface
originals/<slug>/[<roll>/]  master files — git-ignored, immutable, never
                             uploaded, not a backup
albums/<slug>/               album.md, photos.yaml, rolls.yaml — human-edited
generated/
  albums/*.json              manifests — committed, the pipeline↔site contract
  derivatives/                encoded output — git-ignored, rebuildable
  descriptions.json           pnpm describe's cache — git-ignored, rebuildable
docs/                        decisions.md, dependencies.md, verification.md
CHANGELOG.md                  milestone-only development journal (see below)
```

## Commands

```sh
pnpm dev / dev:host          # Astro dev server, :4321
pnpm build / preview          # static build / serve it
pnpm ingest [--album <slug>] # encode derivatives, rewrite manifests — offline
pnpm publish:local            # copy derivatives into site/public/
pnpm sync                     # ingest + publish:local, one command
pnpm run publish              # upload to R2 (needs .env; `pnpm publish` alone
                               # hits pnpm's own built-in command, not this one)
pnpm describe [--album <slug>] [--regenerate] [--model <id>]
                               # optional: draft alt text/captions via Claude
                               # (needs ANTHROPIC_API_KEY in .env)
pnpm doctor                    # report drift, changes nothing
pnpm typecheck / test / lint / format
pnpm verify                    # format:check && lint && typecheck && test && build
```

`pnpm lint` currently reports pre-existing failures unrelated to any of this
session's work (confirmed via `git stash` against a clean `main`) — a
`no-floating-promises` rule flags `node:test`'s `test()` calls across most
`*.test.ts` files, plus a `pipeline.config.ts` project-service parsing error.
Not caused by this session; not yet fixed. `docs/verification.md` predates
this and says lint had never actually been run with real dependencies
installed before — this may be the first real run surfacing it.

## Constraints and invariants — do not break these

1. **`pnpm ingest` must stay fully offline and deterministic.** No network
   call, no dependency on an API key, ever, for any reason. This is why
   `pnpm describe` is a wholly separate command wired to nothing `ingest`
   calls.
2. **Manual descriptions are never overwritten without an explicit force.**
   `pnpm describe` only ever fills in an *empty* `alt`; `--regenerate` only
   touches entries that still match what was last cached as machine-generated
   — a hand-edited entry is always left alone regardless of flags.
3. **`tools/pipeline` must not import Astro, Vite, or Tailwind.** Enforced by
   an ESLint `no-restricted-imports` rule, not just convention.
4. **The site never touches a photograph's bytes.** It only builds URLs from
   manifest data (`site/src/lib/image.ts`).
5. **No symlinks between `generated/derivatives/` and `site/public/p/`.** Real
   copies only, through the `Storage` interface.
6. **Originals are immutable and never committed.** `originals/` is
   git-ignored; nothing in the pipeline writes to it.
7. **The site works with JavaScript disabled.** Browse/reading mode is a
   progressive enhancement over plain `<a>` links to full-size images — not a
   requirement to use the gallery at all.
8. **A photo's identity is `sourceId` (content hash), not pixels or a name.**
   Re-exporting with different metadata is a new identity on purpose (see
   `docs/decisions.md`).
9. **Manifest schema changes bump `SCHEMA_VERSION` and provide no migration.**
   Old manifests are rejected, not upgraded in place.

## Design principles and terminology

- **Trip** — a top-level album directory under `originals/`; the public
  browsing unit (`/projects/<slug>/`).
- **Roll** — a leaf directory under a trip containing images directly, at any
  depth; archival metadata, not (yet) a route.
- **Manifest** — `generated/albums/<slug>.json`; the only thing the site
  reads, and the committed contract between the two halves.
- **Reading view / browse mode** — the continuous vertical-scroll, large-image
  view (`Browse.astro` + `browse.ts`), reached from the grid. Explicitly not a
  modal lightbox: no dialog role, no focus trap, state lives in the URL
  (`#photo-<sourceId>`) so back/reload/share behave like real navigation.
- Performance, simplicity, and maintainability are applied literally (see
  README "Principles") — boring and explicit beats clever.

## Testing, validation, and changelog expectations

- Every pipeline module gets `node:test` coverage colocated as `*.test.ts`;
  no test framework beyond the standard library.
- Before considering any pipeline or site change done: `pnpm typecheck`,
  `pnpm test`, `pnpm build`, and — for anything touching `originals/` handling
  — a real `pnpm ingest` dry run against an actual fixture, not just unit
  tests.
- **`CHANGELOG.md` is milestone-only.** Add an entry (timestamp, 2–5
  paragraphs: what/why/alternatives/future direction) for architectural,
  design, or product shifts — not for refactors, dependency bumps,
  formatting, or routine bug fixes. Append chronologically; never rewrite a
  past entry except to fix a factual error.
- `docs/decisions.md` is append-only, dated, and records *why*, including
  rejected alternatives — add an entry there for any non-obvious architectural
  call, separately from the changelog's product-facing framing.

## Known limitations right now

- `paris-2025` currently has **151 photographs with empty alt text**,
  including one (`0830/000008300011.tif`, the Paris Métro photo) that had a
  hand-written caption earlier in this project's history — the file-path
  identity change (bare filename → roll-relative path, from the hierarchy
  work) made every existing `photos.yaml` entry a "rename" and reset them all.
  This is expected given the invariant above, but it is real lost work to
  redo, not a bug to fix in code.
- `pnpm describe`'s Claude provider (`tools/pipeline/src/describe/claude-provider.ts`)
  is unit-tested against a fake provider only. It has never been exercised
  against the real Anthropic API in this environment (no `ANTHROPIC_API_KEY`
  configured here) — the live HTTP round-trip, real JSON-shape handling, and
  refusal handling are unverified.
- `pnpm lint` has pre-existing failures unrelated to recent work (see
  Commands section above). Not yet triaged or fixed.
- No dedicated roll-level UI exists yet (see hierarchy section) — this is
  intentional, not an oversight.

## Immediate next priorities

1. Re-run `pnpm describe` (or write by hand) alt text/captions for
   `paris-2025` — all 151 photos need one; decide per-photo whether Claude's
   draft is good enough or needs hand editing.
2. Smoke-test `pnpm describe` against the real Claude API once
   `ANTHROPIC_API_KEY` is available, and fix whatever the fake-provider tests
   couldn't catch (real response shape, rate limits, refusals).
3. Triage the pre-existing `pnpm lint` failures (not urgent, but real).
4. Decide `album.md`'s `date`/`location` for `paris-2025` — currently
   scaffolded defaults, not confirmed by the photographer.

## Explicit non-goals

- No social features: no likes, comments, sharing widgets, or analytics
  dashboards.
- No dedicated roll routes/pages until a real product reason exists for one —
  the data model is ready; the UI intentionally is not.
- No build step for `tools/pipeline` (Node's native TS type-stripping is the
  design; see `docs/decisions.md`). Do not introduce `tsx`, `ts-node`, or a
  bundler there.
- No schema migrations for the manifest — a breaking change means a version
  bump and a full re-ingest, not upgrade code.
- No dependency added without a `docs/dependencies.md` entry justifying it,
  including what was rejected and why.
