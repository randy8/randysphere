# CLAUDE.md

Operating guide for Claude Code sessions in this repository. Read this before
making changes; it captures decisions and constraints that would otherwise
have to be re-derived every session. See `docs/decisions.md` for the reasoning
behind each one, `docs/dependencies.md` for why each dependency exists, and
`CHANGELOG.md` for how the project got here.

## What this project is

A personal, long-term archive, not a conventional portfolio or a
social-media-style gallery. `/` is a homepage that introduces **collections**
(`site/src/collections.ts`) — photography is the first and flagship one,
recipes is the second, and more (running, films, writing) are added the same
way: a new entry plus its own `src/pages/<slug>/`. The homepage introduces
collections; it never shows individual photographs or other content directly.

A collection brings **only the machinery its own content needs**. Photography
has a pipeline, a manifest, and object storage because photographs are large
binaries; recipes are hand-written YAML read straight off disk, with no
pipeline, no manifest, and no images. That asymmetry is the design, not a
gap to be closed — resist hoisting one collection's shape onto another.

**Photography** (`site/src/photography/`, routed at `/photography/`) is
where everything below about "the archive," "a tag," "a view" applies — those
are photography-collection concepts, not site-wide ones. It should feel
closer to reading a well-designed photography book than operating a web app:
photographs are shown large and unhurried, and the site disappears in favor
of the pictures. No engagement mechanics, no feeds, no chrome that isn't
earned.

The visual model to design against, site-wide, is an independent magazine, a
museum archive, or a photobook publisher — not a portfolio. Prioritize
navigation, sequencing, and the content itself over large marketing-style
headlines or self-introduction. Every element on a page should justify its
presence by helping someone browse; if it doesn't, it's decoration and it's
out.

Within photography, the collection is **one canonical archive with
query-driven views**, not a collection of trip pages. A visitor browses
tagged views — a trip like `paris-2025`, eventually a place or a subject —
but "trip" is not a structural concept: it is a tag, exactly like any other.
See "Archive model" below before assuming anything is trip-owned.

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
        │  site/src/photography/archive.ts merges every manifest into one Archive
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

## Archive model (photography collection) — read this before assuming anything is trip-owned

The site has no concept of an "album" that owns a manifest and a route. It
reads one canonical `Archive` (`site/src/photography/archive.ts`) — every photograph
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

Three things query the archive **without** being tags. None of them is an
exception to the model above — each is still a query, just not one keyed on
`tags`:

- **Film stock** is roll-level archival fact, read from `rolls.yaml`, not
  photographer-authored per photo. `byFilmStock`/`viewForFilmStock` power
  `/photography/film/<stock>/`. `allFilmStocks()` excludes rolls with no
  stock noted rather than showing an empty one.
- **Selected Work** (`featured` / `featuredOrder` in `photos.yaml` →
  `selectedWork()`) is a hand-picked, hand-ordered sequence across the whole
  archive. Deliberately not a tag: a tag says what a photograph _is_ and
  carries no ordering, while this is a claim about presentation that needs
  one. Ordered photos sort first; unordered ones fall back to `(roll, frame)`.
- **Cover** (`cover:` in `albums/<slug>/album.md` → `coverPhoto()`) names one
  photo per batch, falling back to the chronological first.

**Presentation order never disturbs archival order.** `frame`,
`byRollAndFrame`, and every tag view still sort chronologically; `cover` and
`featuredOrder` are read on top of that by the two callers that want a
sequence. A photograph being featured changes nothing about where it appears
in its own tag's view. Both live in the hand-edited site-layer files, same
boundary as `alt`/`caption`/`tags` — no manifest field, no `SCHEMA_VERSION`
bump. See `docs/decisions.md`, 2026-08-03, "Selected Work is editorial."

## Directory map

```
site/                       Astro application
  src/pages/index.astro     site-wide homepage — introduces collections,
                             shows no photographs or other content directly
  src/collections.ts        the collection registry the homepage reads;
                             adding a collection is one entry here plus its
                             own src/pages/<slug>/ and (if needed) src/<slug>/
  src/config.ts             site-wide identity only (title, author) — a
                             collection's own settings live in its own
                             config.ts, e.g. src/photography/config.ts
  src/layouts/Base.astro    shared shell (masthead, footer, typography) —
                             collection-agnostic on purpose; never learns
                             about a specific collection
  src/styles/base.css       shared design tokens/typography, all collections
  src/pages/photography/    index + /photography/<tag>/ (one route per tag,
                             not per trip), plus selected/, archive/,
                             about/, and film/<stock>/
  src/pages/recipes/        index + /recipes/<slug>/, reading recipes/*.yaml
  src/pages/films/          index only, reading films/five-star-ratings.csv
  src/photography/          everything specific to the photography
                             collection — not shared, not reusable by a
                             future collection with a different content shape
    Photo.astro, Browse.astro   continuous-scroll reading view — not a
                             modal lightbox
    PhotographyNav.astro     Home/Selected Work/Archive/About — photography's
                             own nav, NOT in Base.astro, which stays
                             collection-agnostic
    browse.ts                client-side browse-mode logic, progressive
                             enhancement over plain <a> links
    manifest.ts               the site's OWN manifest reader/validator —
                             deliberately not shared with the pipeline
                             (see docs/decisions.md, "type-only boundary")
    archive.ts                loadArchive, query/byTag/allTags/viewForTag,
                             plus byFilmStock/selectedWork/coverPhoto —
                             merges every batch manifest into one Archive;
                             "trip" is a tag here, not a type
    config.ts                  photography-only settings (imageBaseUrl, its
                             own title/description)
  src/recipes/              the recipes collection's own layer — no pipeline,
                             no manifest, no images by design
    recipes.ts               reads recipes/*.yaml straight off disk; every
                             field optional, a half-written recipe renders
    markup.ts                 the one inline form recipes use (**bold**),
                             not a Markdown parser
    scale.ts                  scaleQuantity/formatNice — scales a bolded
                             ingredient quantity string and reformats it to
                             a common cooking fraction, never touched by
                             instruction text (see docs/decisions.md)
    serving-scale.ts           progressive enhancement wiring the ½×/1×/2×
                             buttons to scale.ts; caches each element's
                             pre-scale text so repeated switches never
                             compound rounding error
    checklist.ts               real checkboxes for ingredients/instructions
                             — per-section progress + localStorage
                             persistence, keyed per recipe slug
    recipes.css               styles scoped to this collection
  src/films/                 the films collection's own layer — no pipeline,
                             no site-hosted images (posters are hotlinked
                             from TMDB), one committed CSV, not one file per
                             film (see docs/decisions.md)
    films.ts                   loadFilms/filmsByYearRated + a hand-rolled
                             RFC 4180 CSV reader (parseCsv) — Letterboxd
                             titles contain commas, so a real parser earns
                             its keep over split(',')
    config.ts                   posterBaseUrl, TMDB attribution text
    films.css                   styles scoped to this collection
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
tools/films/                 its own workspace, not part of tools/pipeline —
                             makes real network calls (`pnpm films:posters`,
                             needs TMDB_READ_ACCESS_TOKEN), which
                             tools/pipeline must never do (see
                             docs/decisions.md)
  fetch-posters.ts            reads films/five-star-ratings.csv, looks each
                             title+year up against TMDB, writes
                             films/tmdb.json — resumable, --regenerate,
                             --only "Title (Year)"; a correction in
                             tmdb-corrections.yaml always wins
originals/<batch>/[<roll>/]  master files — git-ignored, immutable, never
                             uploaded, not a backup; a batch has no public
                             meaning, see "Archive model" above
albums/<slug>/               album.md (scaffolded; only its `cover:` field is
                             read by the site — see coverPhoto()),
                             photos.yaml (alt, caption, tags, featured,
                             featuredOrder), rolls.yaml (filmStock, notes)
                             — human-edited
recipes/<slug>.yaml          the recipes collection's entire content layer —
                             hand-written, committed, read straight off disk
films/five-star-ratings.csv  the films collection's entire content layer —
                             Letterboxd's own "export your data" ratings.csv,
                             trimmed to 5-star rows and committed as-is
films/tmdb.json              committed cache written by `pnpm films:posters`
                             — poster path, overview, runtime, director per
                             film; site reads it, never fetches
films/tmdb-corrections.yaml  hand-maintained: a confirmed TMDB id that
                             overrides the search heuristic for one title
films/poster-overrides.yaml  hand-maintained: a focal point/zoom crop for
                             one specific poster that reads poorly uncropped
tools/serve/                 its own workspace — serves site/dist/ (built by
                             `pnpm build`) plus one password-gated route,
                             /private, for a hand-appended personal
                             notebook. The only workspace that runs as a
                             long-lived server rather than a one-shot CLI
                             (see docs/decisions.md)
  src/server.ts                routing: /private, /private/login,
                             /private/logout, /private/photos/<file>, then
                             static files from site/dist/ for everything
                             else
  src/session.ts                HMAC-signed, stateless session tokens — no
                             session store, no database
  src/cookies.ts                 Set-Cookie for the session: HttpOnly,
                             Secure (unconditional), SameSite=Lax,
                             Path=/private
  src/notes.ts, src/pages.ts     reads private/notes.yaml, renders the gate
                             and the notes archive as plain server-side HTML
private/                     never read by the Astro build, never inside
                             site/dist/ — the only thing that can serve it
                             is tools/serve, and only past the password
                             gate
  notes.yaml                    the private notebook's entire content layer
                             — hand-appended, one entry per line item (date,
                             text, optional joy flag, optional photo)
  photos/                        images referenced by notes.yaml's optional
                             `photo` field — no pipeline, no derivatives,
                             served as-is
generated/
  albums/*.json              per-batch manifests — committed, the
                             pipeline↔site contract; the site merges all of
                             them into one Archive, never reads one alone
  derivatives/                encoded output — git-ignored, rebuildable
  descriptions.json           pnpm describe's cache — git-ignored, rebuildable
docs/                        decisions.md, dependencies.md, verification.md,
                             deployment.md (how randyliang.net stays up)
deploy/                      committed systemd units for production
                             (photography-serve.service,
                             cloudflared-tunnel.service) and the tunnel's
                             config.yml — source of truth for the box that
                             hosts randyliang.net; see docs/deployment.md
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
pnpm films:posters [--regenerate] [--only "Title (Year)"]
                               # optional: fetch poster art/plot/runtime for
                               # films/ from TMDB (needs TMDB_READ_ACCESS_TOKEN
                               # in .env) — never called by pnpm ingest
pnpm doctor                    # report drift, changes nothing
pnpm run edit [--port <n>]    # local web UI for batch tagging/captioning
                               # (loopback-only, default port 4500; bare
                               # `pnpm edit` hits pnpm's own reserved
                               # command name and refuses to run — same
                               # trap as `pnpm publish` above)
pnpm serve [--port <n>]        # serve site/dist/ (run `pnpm build` first)
                               # plus /private — needs PRIVATE_SITE_PASSWORD
                               # and PRIVATE_SESSION_SECRET in .env; binds
                               # every interface, so put it behind
                               # `tailscale serve https` — the Secure
                               # session cookie will not be sent over plain
                               # HTTP
pnpm typecheck / test / lint / format
pnpm verify                    # format:check && lint && typecheck && test && build
```

`pnpm lint` is clean. It previously reported pre-existing failures — a
`no-floating-promises` rule flagging `node:test`'s `test()` calls across most
`*.test.ts` files, plus a `pipeline.config.ts` project-service parsing
error — first surfaced when lint was actually run with real dependencies
installed (`docs/verification.md` predates that run). Both were config
issues, not code bugs: `eslint.config.js` now turns
`no-floating-promises` off for `**/*.test.ts` (the idiomatic node:test
pattern is a bare top-level `test()` call; `node --test` drives completion
and failure reporting, not the return value), and `pipeline.config.ts` is
listed under `projectService.allowDefaultProject` (it's in
`tools/pipeline/tsconfig.json`'s `include`, but the project service's
directory-based discovery never looks there since the file lives outside
every tsconfig's own directory). A handful of genuine
`no-unnecessary-type-assertion` / `require-await` errors in
`album-files.ts` and `concurrency.test.ts` were fixed directly.

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
   manifest data (`site/src/photography/image.ts`).
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
11. **`private/` is never read by the Astro build.** Nothing under
    `site/src/` may import from `private/`; the only code allowed to read
    `private/notes.yaml` or `private/photos/` is `tools/serve`, and only
    after `verifySessionToken` succeeds. This is what makes "request the
    data file directly" not a bypass — the file was never shipped to
    `site/dist/` in the first place, regardless of the password check.

## Design principles and terminology

- **Tag** — free-form, photographer-authored, per-photo (`photos.yaml`). The
  only thing that makes a photo show up in a view. A trip (`paris-2025`) is
  one tag among many; there is no separate "trip" type anywhere in the site.
- **Archive** — the full, canonical, flat list of every photograph across
  every batch, merged at site-read time (`site/src/photography/archive.ts`).
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
- **Collection** — a top-level content area with its own pages, its own data
  layer, and its own config (`site/src/collections.ts`). Photography is the
  first; recipes is the second and deliberately shares none of photography's
  machinery. The homepage introduces collections and shows no content itself.
- **Selected Work** — the hand-picked, hand-ordered sequence across the whole
  archive (`featured`/`featuredOrder` → `selectedWork()`). Editorial, not a
  tag. See "Archive model."
- **Presentation order vs archival order** — `cover` and `featuredOrder` are
  chosen; `frame`/`byRollAndFrame` are chronological. The first never
  rewrites the second.
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

- **All 289 photographs, across all eight batches, still have empty alt text
  and no authored tag.** This is the single largest gap in the project and
  both of the top two priorities below. The batches are `0271`, `0425`,
  `0462`, `0827`, `0828`, `0829`, `0830`, and `llfl01`; every photo carries
  exactly one tag, auto-seeded from its batch directory name, so the site
  renders eight disconnected views named after directories.

  The Paris origin of four of them: `originals/paris-2025/` (one batch, four
  rolls) was restructured on 2026-07-29 into `0827`/`0828`/`0829`/`0830`. The
  sourceId "identity survives a move" matching (`docs/decisions.md`,
  2026-07-29) is scoped **per batch slug** — it matches a batch's new scan
  against that same slug's previous manifest, not against every other batch —
  so splitting one batch into four gave each a blank history and ingest
  seeded fresh batch-name tags instead of preserving `tags: [paris-2025]`.
  Retagging (item 1) is the fix; cross-batch identity matching remains a real
  gap in code (item 4). The one hand-written caption
  (`0830/000008300011.tif`, the Paris Métro photo) was lost earlier still,
  during the bare-filename → roll-relative-path change, and remains lost.

- `pnpm ingest` now deletes a batch's manifest and `albums/<slug>/` (captions,
  tags, everything) the moment `originals/<slug>/` no longer exists
  (`docs/decisions.md`, 2026-07-30, `removeOrphanAlbums`) — no confirmation,
  every run. This is what keeps a rename in `originals/` (like the
  `littlelightfilmlab-01` → `llfl01` one that happened live this session)
  from leaving a stale duplicate manifest behind, but it means renaming or
  temporarily unmounting a batch directory is destructive to anything
  hand-written in its `albums/<slug>/` if `pnpm ingest` runs while it's
  "gone." No grace period exists yet — see `docs/decisions.md`'s "Revisit
  if" for that entry. Two sharp edges worth knowing: `--album <slug>` does
  **not** scope the orphan sweep (it always runs against every slug in
  `originals/`), and a fresh clone — where `originals/` is git-ignored and
  therefore empty while all eight manifests are committed — is exactly the
  state that triggers it for every batch at once.
- `pnpm describe`'s Claude provider (`tools/pipeline/src/describe/claude-provider.ts`)
  is unit-tested against a fake provider only. It has never been exercised
  against the real Anthropic API in this environment (no `ANTHROPIC_API_KEY`
  configured here) — the live HTTP round-trip, real JSON-shape handling, and
  refusal handling are unverified.
- No dedicated roll _route_ exists (see film-roll section) — intentional. Film
  stock, which is roll-level data, does now have one at
  `/photography/film/<stock>/`; only `llfl01`'s roll has a `filmStock` noted
  so far, so most of the archive is absent from those views.
- Selected Work currently holds **four** photographs, chosen as a smoke test
  of `featured`/`featuredOrder` rather than as a real edit. It needs a real
  pass once the archive is tagged and described.
- `album.md` is scaffolded per batch and only its `cover:` field is read (all
  eight batches have one set). `title`, `date`, `location`, and `description`
  are still written and still displayed nowhere. The former
  `paris-2025/album.md`'s hand-set `location: "Paris, France"` did not
  survive the batch split above — real lost data, not just unused surface.
- The multi-tag, cross-batch case (a photo tagged into two different views) is
  covered by unit tests but still not exercised against real photographs,
  because no photograph yet carries a second tag.
- The recipes collection has no images, no pipeline, and no validation beyond
  "every field is optional" (`site/src/recipes/recipes.ts`). A malformed YAML
  file will throw at build time; a half-written one renders as far as it
  goes, on purpose.
- `pnpm edit`'s frontend (`tools/pipeline/src/editor/static/app.js`) has no
  automated test — no browser test runner exists in this repo. The pure
  logic (tag-list merging, the batch bar's tri-state computation) is kept in
  small standalone functions, reviewable by eye, but nothing exercises the
  DOM/selection/keyboard code itself. See `docs/decisions.md`, 2026-07-29.
- Deleting a tag archive-wide from the editor's tag-maintenance view has no
  in-app undo (renaming one, and ordinary batch tag edits, do); `git` is the
  recovery path for that one action. Numbered quick-tag hotkey slots
  (Photo Mechanic-style) are deferred, not built.
- The films collection (`/films/`) now has poster art, plot summaries,
  runtime, and director for all 773 rated films (772 with a poster) via
  `pnpm films:posters` and TMDB (see `docs/decisions.md`, 2026-08-04,
  "why it isn't scraped"). `films/tmdb.json` is a committed cache the site
  reads at build time with no network access of its own; re-running the
  script only re-fetches films it hasn't seen, or a specific
  `--only "Title (Year)"`, or everything with `--regenerate`. `films/` still
  has no sync command for the ratings themselves: refreshing them means
  re-running Letterboxd's export by hand and replacing
  `films/five-star-ratings.csv`, the same way a recipe is edited by hand
  today. TMDB's search heuristic mismatches a title occasionally — one
  confirmed case is recorded in `films/tmdb-corrections.yaml` — and only one
  poster (`films/poster-overrides.yaml`) has needed a hand-cropped focal
  point so far.
- **`tools/serve` is the one part of this project that is not a static
  site or an offline CLI** — it's a long-lived Node process (`pnpm serve`)
  that must actually be running for `/private` to exist at all. In
  production it now runs under `systemd` (`photography-serve.service`,
  `enable`d and `Restart=on-failure`, paired with `cloudflared-tunnel.service`
  for the actual `randyliang.net` traffic) — both units are committed under
  `deploy/`, and the full picture is in `docs/deployment.md`
  (`pnpm deploy` is the one command for shipping a change). See
  `docs/decisions.md`, 2026-08-17. There is still no login rate-limiting on
  `/private` — acceptable for a single known user, not a
  pattern to reuse for a multi-user surface.

## Immediate next priorities

1. Use `pnpm run edit` to give all 289 photographs across all eight batches real
   tags, replacing the auto-seeded batch-name ones. The four Paris batches
   (`0827`–`0830`) want a shared trip tag (e.g. `paris-2025`) so the site
   shows one trip view instead of four; `0271`, `0425`, `0462`, and `llfl01`
   each need a tag that reflects what they actually are — confirm before
   tagging, don't guess from the directory name. This is also the first real
   multi-tag exercise against actual photographs (a place or subject tag
   alongside the trip tag), confirming the resulting view renders correctly.
2. Re-run `pnpm describe` (or write by hand) alt text/captions for all 289
   photos across all eight batches; decide per-photo whether Claude's draft
   is good enough or needs hand editing.
3. Smoke-test `pnpm describe` against the real Claude API once
   `ANTHROPIC_API_KEY` is available, and fix whatever the fake-provider tests
   couldn't catch (real response shape, rate limits, refusals).
4. Decide whether cross-batch sourceId matching (surfaced by the batch-split
   limitation above) is worth building, or whether restructuring
   `originals/` across batch boundaries is simply expected to require a
   manual retag going forward.
5. Note `filmStock` in each batch's `rolls.yaml` — only `llfl01`'s roll has
   one, so `/photography/film/<stock>/` currently covers 37 of 289
   photographs. The data is roll-level and hand-authored; nothing derives it
   from EXIF.
6. Make a real Selected Work pass (currently four photographs) once the
   archive is tagged and described.

## Explicit non-goals

- No social features: no likes, comments, sharing widgets, or analytics
  dashboards.
- No dedicated roll routes/pages until a real product reason exists for one —
  the data model is ready; the UI intentionally is not.
- No `tags/<slug>.md` (authored per-tag title/description/cover/location)
  until a specific tag genuinely needs one. A view's title/date are derived,
  not authored, until then — see `docs/decisions.md`, 2026-07-29.
- No per-photo `location` field until a specific photograph needs one.
- No pipeline, manifest, or ingest step for recipes — they are hand-written
  YAML, read directly. Revisit only if recipes get photographs, and then by
  teaching the existing pipeline a second content type, not by building a
  parallel one (see `docs/decisions.md`, 2026-08-03).
- No shared `src/lib/` for "things more than one collection might want." Each
  collection reads its own data its own way; duplication between two
  collections is cheaper than a wrong abstraction.
- No structural "trip" type, ever, by design — trips are tags. Do not
  reintroduce a manifest-per-route or an `Album` type that owns photographs.
- No build step for `tools/pipeline` (Node's native TS type-stripping is the
  design; see `docs/decisions.md`). Do not introduce `tsx`, `ts-node`, or a
  bundler there.
- No schema migrations for the manifest — a breaking change means a version
  bump and a full re-ingest, not upgrade code.
- No dependency added without a `docs/dependencies.md` entry justifying it,
  including what was rejected and why.
