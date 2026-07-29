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
a web app: photographs are shown large and unhurried, and the site disappears
in favor of the pictures. No engagement mechanics, no feeds, no chrome that
isn't earned.

The site is **one canonical archive with query-driven views**, not a
collection of trip pages. A visitor browses tagged views — a trip like
`paris-2025`, eventually a place or a subject — but "trip" is not a
structural concept: it is a tag, exactly like any other. See "Archive model"
below before assuming anything is trip-owned.

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
originals/<batch>/[<roll>/]*.{jpg,png,tif,webp}       (git-ignored, immutable)
        │  pnpm ingest
        ▼
generated/albums/<batch>.json        (committed manifest — the contract)
generated/derivatives/p/<hash>/...   (git-ignored, rebuildable cache)
        │  pnpm publish:local  or  pnpm run publish
        ▼
site/public/p/...  (local dev/build)   or   R2 bucket (production)
        │  site/src/lib/archive.ts merges every manifest into one Archive
        │  astro build / astro dev
        ▼
site/dist/ or http://localhost:4321
```

`<batch>` is a top-level `originals/` directory — the pipeline's own unit for
where it scanned a photograph from. It has **no public meaning**: it is not a
trip, not a route, not anything a visitor sees. One manifest is still written
per batch (unchanged pipeline behaviour), but the site immediately merges
every manifest into one flat `Archive` and never treats "which manifest a
photo came from" as anything other than internal provenance (`ArchivePhoto.batch`).

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
  file's bytes, not pixels) and its `file` path (relative to the batch
  directory, roll included). **A `photos.yaml` entry's identity is content
  first, path second**: moving or renaming a file under `originals/` — into a
  different roll, or out of one entirely — is matched by `sourceId` to
  wherever its content now lives, and its caption/alt/tags survive intact
  (see `docs/decisions.md`, 2026-07-29, "A photo's identity survives a move").
  Only a genuine deletion (content gone, path gone) drops an entry. A
  metadata-only re-export at the same path is still a new identity (new
  derivatives, new URLs — see the sourceId decision below), matched by path
  instead, and still keeps its caption.
- The manifest schema is versioned (`SCHEMA_VERSION` in
  `tools/pipeline/src/manifest.ts`, currently **2**). A schema bump is
  intentionally a hard break: old manifests are rejected outright and
  `pnpm ingest` regenerates everything from `originals/` — there is no
  migration path by design. Expect a full re-encode after any schema bump.

## The film-roll model (pipeline side, unchanged by the archive model below)

`originals/<batch>/` no longer has to be a flat folder of files. Ingest
recursively scans for **rolls**: any directory that directly contains at least
one supported image file, at any depth. Nothing is hardcoded about depth or
naming (no city lists, no fixed folder levels) — a flat batch (files directly
in the batch directory) is just a roll with id `.`; `originals/paris-2025/0827/`
or `originals/x/europe/paris/0827/` are found the same way.

- A photo's manifest `file` is its path relative to the batch directory
  (`0827/001.tif`, or `001.tif` at the root) — this is the uniqueness
  guarantee once a batch can hold more than one roll.
- Every photo records a `roll` field. The manifest also carries a top-level
  `rolls: { id, photoCount }[]`, and `albums/<slug>/rolls.yaml` lets a
  photographer add roll-level notes (film stock, etc.), synced the same
  loss-free way `photos.yaml` is.
- Rolls are not first-class routes. The archive already exposes everything a
  per-roll view would need (`ArchivePhoto.roll`, `ArchivePhoto.frame`) — but
  nothing renders one today. Don't add roll pages speculatively.

## Archive model (site side) — read this before assuming anything is trip-owned

The site has no concept of an "album" that owns a manifest and a route. It
reads one canonical `Archive` (`site/src/lib/archive.ts`) — every photograph
from every batch's manifest, merged into a single flat list. A page is a
**query** over that list, never a record that owns photographs:

- **A trip is a tag**, not a structural entity. `paris-2025` is a string in a
  photo's `tags` list (`albums/<slug>/photos.yaml`), exactly like a place or a
  subject tag would be. There is no list of "known trips" anywhere — `allTags()`
  is just the union of every photo's tags.
- **A view is `viewForTag(archive, tag)`** — filter the archive by tag, sort by
  `(roll, frame)`. `/projects/<tag>/` calls this once per known tag in
  `getStaticPaths()`; the code path is identical whether the tag is a trip, a
  place, or a subject. Do not special-case "trip" anywhere in `archive.ts` or
  the pages that call it.
- **A photo can carry multiple tags** and appears, unduplicated, in every
  matching view — the same `ArchivePhoto` object, not a copy.
- **`frame`** (a photo's 1-based position within its roll) and **`tags`**
  (photographer-authored) are both site-layer-only concepts. Neither is in the
  pipeline's manifest or bumps `SCHEMA_VERSION` — `frame` is derived at
  read-time from the manifest's existing deterministic order; `tags` lives in
  `photos.yaml`, joined the same way `alt`/`caption` already are.
- **Deferred, on purpose, not missing by accident:** there is no `tags/<slug>.md`
  (a view's title is its tag humanised; its date is derived from EXIF) and no
  per-photo `location` field. Add either the first time a specific tag or
  photo genuinely needs it — see `docs/decisions.md`, 2026-07-29, "Trips
  become a tag."

## Directory map

```
site/                       Astro application
  src/pages/                index + /projects/<tag>/ (one route per tag, not per trip)
  src/components/           Photo.astro, Browse.astro (continuous-scroll
                             reading view — not a modal lightbox)
  src/scripts/browse.ts     client-side browse-mode logic, progressive
                             enhancement over plain <a> links
  src/lib/manifest.ts       the site's OWN manifest reader/validator —
                             deliberately not shared with the pipeline
                             (see docs/decisions.md, "type-only boundary")
  src/lib/archive.ts        loadArchive, query/byTag/allTags/viewForTag —
                             merges every batch manifest into one Archive;
                             "trip" is a tag here, not a type
tools/pipeline/
  src/sources.ts            listAlbumSlugs, listRolls, flattenRolls
  src/ingest.ts              encode + write manifests + sync albums/*
  src/manifest.ts            schema, validation, SCHEMA_VERSION
  src/album-files.ts         photos.yaml (incl. per-photo tags) / rolls.yaml
                             sync, setPhotoDescription, applyPhotoEdits
  src/describe/              optional AI-description stage (see below)
  src/editor/                 pnpm edit's server + API + static frontend —
                             loopback-only, batch tags/alt/caption straight
                             into photos.yaml (see docs/decisions.md)
  src/storage/                local + R2 publish targets behind one interface
originals/<batch>/[<roll>/]  master files — git-ignored, immutable, never
                             uploaded, not a backup; a batch has no public
                             meaning, see "Archive model" above
albums/<slug>/               album.md (scaffolded, currently unread by the
                             site), photos.yaml (alt, caption, tags),
                             rolls.yaml — human-edited
generated/
  albums/*.json              per-batch manifests — committed, the
                             pipeline↔site contract; the site merges all of
                             them into one Archive, never reads one alone
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
pnpm edit [--port <n>]         # local web UI for batch tagging/captioning
                               # (loopback-only, default port 4500)
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
   `pnpm describe` only ever fills in an _empty_ `alt`; `--regenerate` only
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
10. **`pnpm edit`'s server binds `127.0.0.1` only, never `0.0.0.0`.** It
    writes to `photos.yaml` on every batch edit with no authentication of its
    own; that is only acceptable because it is never reachable from outside
    the machine it runs on.

## Design principles and terminology

- **Tag** — free-form, photographer-authored, per-photo (`photos.yaml`). The
  only thing that makes a photo show up in a view. A trip (`paris-2025`) is
  one tag among many; there is no separate "trip" type anywhere in the site.
- **Archive** — the full, canonical, flat list of every photograph across
  every batch, merged at site-read time (`site/src/lib/archive.ts`).
- **View** — the result of querying the archive (`viewForTag`): an ordered
  list of photos plus a derived title/date. Not stored; recomputed from the
  archive every time.
- **Batch** — a top-level directory under `originals/`; a physical scan unit
  for the pipeline only, with no public meaning. Was previously called a
  "trip" or "album" when it was structural — it no longer is.
- **Roll** — a leaf directory under a batch containing images directly, at any
  depth; archival metadata (`ArchivePhoto.roll`/`.frame`), not a route.
- **Manifest** — `generated/albums/<batch>.json`; one per batch, the
  committed contract between the two halves. The site never reads just one —
  it merges all of them into the Archive.
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
- `docs/decisions.md` is append-only, dated, and records _why_, including
  rejected alternatives — add an entry there for any non-obvious architectural
  call, separately from the changelog's product-facing framing.

## Known limitations right now

- The Paris trip's 150 photographs still have **empty alt text**, and as of
  this session are no longer one tagged view. `originals/paris-2025/` (one
  batch, four rolls) was restructured into four top-level batches —
  `originals/0827/`, `0828/`, `0829/`, `0830/` — each now its own `albums/*`
  and manifest. The sourceId "identity survives a move" matching
  (`docs/decisions.md`, 2026-07-29) is scoped **per batch slug**: it matches a
  batch's new scan against that same slug's previous manifest, not against
  every other batch. Splitting one batch into four gave each a blank
  history, so instead of preserving `tags: [paris-2025]`, ingest seeded fresh
  entries tagged with each new batch's own directory name (`0827`, `0828`,
  etc). The site currently renders these as four disconnected trip views
  instead of one `paris-2025` view. Retagging all 150 entries back to a
  shared trip tag (item 4 below) is the fix; cross-batch identity matching
  is a real gap this surfaced, not yet addressed in code. The one
  hand-written caption (`0830/000008300011.tif`, the Paris Métro photo) was
  already lost earlier in this project's history, during the bare-filename →
  roll-relative-path change from the hierarchy work, and remains lost.
- `pnpm describe`'s Claude provider (`tools/pipeline/src/describe/claude-provider.ts`)
  is unit-tested against a fake provider only. It has never been exercised
  against the real Anthropic API in this environment (no `ANTHROPIC_API_KEY`
  configured here) — the live HTTP round-trip, real JSON-shape handling, and
  refusal handling are unverified.
- `pnpm lint` has pre-existing failures unrelated to recent work (see
  Commands section above). Not yet triaged or fixed.
- No dedicated roll-level UI exists yet (see film-roll section) — this is
  intentional, not an oversight.
- `album.md` is scaffolded per batch but no longer read by the site (see
  "Archive model"). The former `paris-2025/album.md`'s hand-set
  `location: "Paris, France"` did not survive the batch split above — each
  of `0827`–`0830`'s `album.md` was scaffolded fresh with an empty
  `location`. Nothing currently displays this field regardless, but it is
  real lost data, not just unused surface area.
- Four tags exist in the real archive right now (`0827`, `0828`, `0829`,
  `0830` — see the batch-split bullet above), all auto-seeded, none
  authored. The multi-tag, cross-batch case (a photo tagged into two
  different views) is covered by unit tests but not yet exercised against
  real photographs.
- `pnpm edit`'s frontend (`tools/pipeline/src/editor/static/app.js`) has no
  automated test — no browser test runner exists in this repo. The pure
  logic (tag-list merging, the batch bar's tri-state computation) is kept in
  small standalone functions, reviewable by eye, but nothing exercises the
  DOM/selection/keyboard code itself. See `docs/decisions.md`, 2026-07-29.
- Deleting a tag archive-wide from the editor's tag-maintenance view has no
  in-app undo (renaming one, and ordinary batch tag edits, do); `git` is the
  recovery path for that one action. Numbered quick-tag hotkey slots
  (Photo Mechanic-style) are deferred, not built.

## Immediate next priorities

1. Use `pnpm edit` to retag all 150 photos across `0827`, `0828`, `0829`,
   `0830` with a shared trip tag (e.g. `paris-2025`) so the site shows one
   trip view again instead of four disconnected batch-id views — see the
   batch-split limitation above. This is also the first real multi-tag
   exercise against actual photographs (a place or subject tag added
   alongside the trip tag), confirming the resulting view renders correctly.
2. Re-run `pnpm describe` (or write by hand) alt text/captions for all 150
   photos; decide per-photo whether Claude's draft is good enough or needs
   hand editing.
3. Smoke-test `pnpm describe` against the real Claude API once
   `ANTHROPIC_API_KEY` is available, and fix whatever the fake-provider tests
   couldn't catch (real response shape, rate limits, refusals).
4. Triage the pre-existing `pnpm lint` failures (not urgent, but real).
5. Decide whether cross-batch sourceId matching (surfaced by the batch-split
   limitation above) is worth building, or whether restructuring
   `originals/` across batch boundaries is simply expected to require a
   manual retag going forward.

## Explicit non-goals

- No social features: no likes, comments, sharing widgets, or analytics
  dashboards.
- No dedicated roll routes/pages until a real product reason exists for one —
  the data model is ready; the UI intentionally is not.
- No `tags/<slug>.md` (authored per-tag title/description/cover/location)
  until a specific tag genuinely needs one. A view's title/date are derived,
  not authored, until then — see `docs/decisions.md`, 2026-07-29.
- No per-photo `location` field until a specific photograph needs one.
- No structural "trip" type, ever, by design — trips are tags. Do not
  reintroduce a manifest-per-route or an `Album` type that owns photographs.
- No build step for `tools/pipeline` (Node's native TS type-stripping is the
  design; see `docs/decisions.md`). Do not introduce `tsx`, `ts-node`, or a
  bundler there.
- No schema migrations for the manifest — a breaking change means a version
  bump and a full re-ingest, not upgrade code.
- No dependency added without a `docs/dependencies.md` entry justifying it,
  including what was rejected and why.
