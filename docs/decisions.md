# Decisions

An append-only log of choices that a reader would otherwise have to reverse
engineer. Entries are dated and never edited; if a decision is reversed, a new
entry supersedes it and says so.

This is not the architecture document. `architecture.md` describes how the
system works today; this file explains why it ended up that way, including the
options that were rejected.

---

## 2026-07-28 — No build step for the pipeline

**Decision.** `tools/` is executed by Node directly from its TypeScript source.
There is no `dist/`, no bundler, and no transpiler dependency. `tsc` runs with
`noEmit` purely as a type checker.

**Why.** Node's type stripping became stable in v24.3.0 and no longer emits an
experimental warning. It removes type annotations and runs what is left, which
is exactly what a CLI needs. Adopting it deletes an entire category of things
that go wrong: stale build output, source maps that disagree with reality, a
`dist/` that is committed by accident, and a bundler configuration nobody
remembers writing. Stack traces point at real line numbers because inline types
are replaced with whitespace rather than removed.

**Cost.** Only erasable syntax is allowed — no `enum`, no parameter properties,
no namespaces. This is not a real constraint; all three are things worth
avoiding anyway. `erasableSyntaxOnly` in `tsconfig.base.json` turns a violation
into a type error instead of a runtime crash.

**Rejected alternatives.** `tsx` or `ts-node` (a dependency to do what the
runtime already does); compiling with `tsc` to `dist/` (no new dependency, but
reintroduces every stale-artifact problem for no benefit).

**Revisit if.** Node changes the feature's stability, or the pipeline develops a
genuine need for non-erasable syntax — which would more likely mean the code is
wrong than that the constraint is.

---

## 2026-07-28 — TypeScript 6, not 7

**Decision.** The whole workspace stays on TypeScript 6 for now.

**Why.** TypeScript 7 went stable on 8 July 2026 with an 8–12× speedup, but it
ships without a stable programmatic API. Astro's language tooling and
`astro check` depend on that API, so the site cannot use it yet. Splitting the
workspace — 7 for `tools/`, 6 for `site/` — would put two compilers with two
configurations and two behaviours in one repository to save a few seconds on a
type check that is already fast.

**Revisit if.** TypeScript 7.1 ships the new programmatic API (expected around
October 2026) and Astro's language tools adopt it. Then upgrade everything at
once, which is a single lockfile change.

---

## 2026-07-28 — The pipeline↔site boundary is type-only

**Decision.** `site/` may import _types_ from `tools/pipeline` and must not
import any value from it. Runtime validation of the manifest is written
explicitly in the site rather than sharing a schema object across the boundary.

**Why.** Two reasons that point the same way. Architecturally, a type-only
dependency cannot drift into shared runtime behaviour, which is what keeps the
pipeline genuinely independent. Practically, `import type` is erased before
anything executes, which sidesteps a real hazard: Node refuses to strip types
from files under `node_modules`, and a workspace package is a symlink into
`node_modules`. A shared value import would work under Vite and break the
moment it was externalised to Node.

**Cost.** The manifest's shape is asserted in two places — the pipeline's schema
and the site's loader. That duplication is deliberate and small, and it is the
duplication that makes the boundary real.

**Revisit if.** The two validators drift in practice rather than in theory.

---

## 2026-07-28 — ESLint enforces the architecture, not the formatting

**Decision.** No stylistic rules. The most important rule in the configuration
is `no-restricted-imports` scoped to `tools/**`, which fails the build if the
pipeline imports Astro, Vite, or Tailwind.

**Why.** "The pipeline does not depend on the website framework" is the load
bearing claim of this whole design, and claims that are not enforced stop being
true. It is one config block and it costs nothing to keep.

---

## 2026-07-28 — The manifest carries no timestamp

**Decision.** Generated files record a schema version and content, and nothing
about when they were written.

**Why.** A `generatedAt` field would make every ingest produce a diff even when
nothing changed, which destroys the property that makes the manifest worth
committing: it is a pure function of `originals/` and `pipeline.config.ts`. Run
ingest twice and `git status` is clean. When something did change, the diff is
exactly what changed. Git already records when.

---

## 2026-07-28 — Publish lists the target instead of keeping a ledger

**Decision.** Every publish lists the destination prefix and diffs against the
manifest. There is no local record of what was uploaded last time.

**Why.** A ledger is a cache of remote state, and it is wrong the moment
anybody deletes an object from the Cloudflare dashboard — after which the
pipeline reports success forever while the site serves broken images. Listing
is authoritative. Thirty requests for thirty thousand objects is a fine price
for never having to reason about staleness.

`generated/published.json` survives, but only as the committed gate that lets
CI refuse to deploy a site whose manifests are ahead of what was published. It
is written last, after every key is confirmed, so a failed run leaves the
previous record intact rather than claiming derivatives exist that do not.

**Revisit if.** A collection grows large enough that listing is slow. The fix
is an early-out when nothing changed locally, not a ledger.

---

## 2026-07-28 — The source digest covers file bytes, not pixels

**Decision.** `sourceId` is the SHA-256 of the original file's bytes.

**Why.** The alternative — hashing normalised pixels — is more semantically
appealing, because re-exporting with different metadata would then not churn
any URLs. It is also unusable: identifying a photograph by its pixels means
decoding all of them on every run, just to discover that nothing changed. That
directly breaks the requirement that a repeat ingest does no unnecessary work.

Orientation is still normalised before encoding; it is simply not part of the
identity. The consequence is documented rather than hidden: a metadata-only
re-export produces a new identity and a new set of URLs, and ingest reports how
many photographs that affected so a large publish is never a surprise.

---

## 2026-07-28 — Dependencies are quarantined into thin modules

**Decision.** Where a dependency is needed, the code that touches it is
separated from the logic worth testing. `exif.ts` is the EXIF parser and
nothing else; the allow-list lives in `camera-metadata.ts`. `storage/r2.ts` is
the HTTP client; the response reader lives in `storage/s3-list.ts`.

**Why.** It started as a testing convenience and turned out to be the better
design. The three behaviours that could damage or expose a collection — GPS
exclusion, key determinism, publish integrity — are now testable with nothing
installed, which means they are covered on any machine and in any CI job
regardless of whether a native binary built. It also makes each dependency
genuinely replaceable, because its surface is one file.

---

## 2026-07-29 — A photo's identity is a path, not a filename

**Decision.** `PhotoRecord.file` changed from a bare filename to a path
relative to the album directory (`0827/001.tif`, or `001.tif` for a roll at
the album root). Every photo also gained a `roll` field, and the manifest
gained a top-level `rolls` list with automatically derived metadata.

**Why.** `originals/<slug>/` stopped being reliably flat the moment a real
archive organised itself as a trip split into rolls. A bare filename is not
unique once an album can hold more than one roll; a relative path is, without
inventing a separate id scheme. Rolls being real manifest data — not just a
prefix baked into `file` — is what lets the site (or anything else) query
"every photo in this roll" later without re-deriving it from a string split.

**Cost.** This is an incompatible manifest shape, so `SCHEMA_VERSION` moved
from 1 to 2. Every existing manifest is rejected until re-ingested, which is
by design — `pnpm ingest` regenerates from `originals/` in full, so there is
no migration to write, only a full re-encode to wait out once.

**Revisit if.** A roll ever needs its own URL. That is a routing change, not a
manifest change — the data this decision added is already what such a route
would read from.

---

## 2026-07-29 — Description generation is a separate command, not an ingest step

**Decision.** `pnpm describe` is its own CLI command, wired to nothing
`pnpm ingest` calls. It depends on `@anthropic-ai/sdk` and network access;
`ingest` depends on neither, and nothing changed about that.

**Why.** "`pnpm ingest` runs fully offline" is a property this project states
outright and tests rely on. Automatic captioning needs a network call to an
LLM, which cannot be true of a step inside `ingest` without breaking that
property for everyone, including people who never want the feature. Keeping
it a separate, optional command is the whole fix: the offline guarantee stays
absolute rather than becoming "offline, except."

**Cost.** Two entry points instead of one for the full "photo in, described
photo out" path. Considered acceptable because the two paths have genuinely
different failure modes and dependencies — one should never be able to break
the other.

**Revisit if.** A second description provider is added. `describe/provider.ts`
is a one-method interface for exactly this; a new provider is an
implementation of it, not a change to `describe.ts`'s caching, manual-edit
preservation, or resumability logic.

---

## 2026-07-29 — Trips become a tag, not a structural concept; the site reads one canonical archive

**Decision.** The site no longer has a notion of "albums," each owning a
manifest and a route. It reads one canonical `Archive` (`site/src/lib/archive.ts`,
replacing `albums.ts`) — every photograph from every `generated/albums/*.json`
merged into a single flat list. A trip like `paris-2025` is now a **tag**, held
in `photos.yaml` per photo, exactly like any other tag a place or a subject
would use. A page is the result of a query over the archive (`viewForTag`), not
a record that owns a set of photographs. `/projects/<tag>/` still exists and
still resolves for `paris-2025`, but the code path is identical for any tag —
there is no special case for "trip" anywhere in the site.

Two things are explicitly **not** part of this change, both deferred rather
than built: per-tag authored metadata (title, description, cover, location) —
there is no `tags/<slug>.md`; a view's title is the tag string humanised
(`paris-2025` → "Paris 2025") and its date is derived as the earliest EXIF
capture time among its photos. And per-photo `location` — deferred entirely,
so a photo's only free-text field remains its caption. Both are real gaps, not
oversights: they are missing because nothing yet needs them, not because they
were forgotten.

**Why.** The previous design assumed one directory under `originals/` is one
trip is one manifest is one route — true for a single, cleanly-organised trip
archive, but wrong the moment two directories should show up in the same view,
or one photograph belongs in more than one. Rather than build a second
structural concept ("collections" or "multi-trip albums") alongside the
existing one, tags collapse trip, place, and subject into the same mechanism:
a photograph can carry any number of them, and a view is just a filter.
"Preserve deterministic ordering... do not duplicate photo records" falls out
for free from "filter, don't copy" — two views sharing a photograph reference
the same object, never a second record.

**What did not change.** `PhotoRecord`'s shape in the pipeline manifest is
untouched — no `tags` field there, no `SCHEMA_VERSION` bump, no re-encode.
Tags are exclusively photographer-authored data in `photos.yaml`, joined at
site-read time, the same boundary `alt`/`caption` already crossed. `frame` (a
photo's 1-based position within its roll) is not stored anywhere either — it
is derived at site-read time from the manifest's already-deterministic order
(rolls sorted by id, files sorted by name within each). `sources.ts`,
`encode.ts`, `recipe.ts`, `hash.ts`, `exif.ts`, every `storage/*` module, and
`publish.ts`/`doctor.ts` needed no changes: derivative keys were already
content-addressed and slug-agnostic, and `readAllManifests()` already treated
"the manifests" as a generic set of files, not a fixed roster of known trips.

**Migration.** Every `originals/<X>/` directory keeps its role as a physical
_scan batch_ for ingest's own bookkeeping — that is unchanged and still needed
for roll discovery — but it no longer carries public meaning on its own. To
keep every existing archive working with zero manual retagging, `pnpm ingest`
seeds each newly-created `photos.yaml` entry's `tags` with `[<batch-directory-name>]`,
and — the one-time part — backfills the same default tag onto any existing
entry that has no `tags` key at all (an entry with a `tags` key, even `[]`,
is never touched again; that key's presence means a person or a prior ingest
has already spoken for it). Running this against the real `paris-2025` archive
tagged all 150 existing entries `paris-2025` in one pass, with `git diff`
showing only the added `tags:` blocks — same alt/caption content, same file
order, same comments.

**Cost.** `albums/<slug>/album.md`'s hand-set values (for `paris-2025`:
`location: "Paris, France"`) are no longer read by the site — there is
nowhere for them to go until tag metadata is built. `scaffoldAlbumMarkdown`
still runs and still writes `album.md` per batch; nothing reads the result
today. This is dead weight worth revisiting, not something removed as part of
this change, since removing the scaffolding is a separate, smaller decision.

**Revisit if.** A tag genuinely needs authored presentation data (a written
description, a chosen cover, a real date) — add `tags/<tag>.md`, scaffolded
the same way `album.md` was, the first time a specific tag needs one. Do not
add it speculatively for every tag. Revisit the per-photo `location` deferral
the same way: add it to `photos.yaml`'s schema the first time a photograph
actually needs one written down.

---

## 2026-07-29 — A local metadata editor, living inside `tools/pipeline`

**Decision.** Added `pnpm edit`: a loopback-only (`127.0.0.1`) HTTP server
(`tools/pipeline/src/editor/`) serving a small, unbundled HTML/CSS/JS
frontend for batch-tagging and captioning hundreds of photos at once, backed
by a JSON API that reads the merged archive (every `generated/albums/*.json`
joined with its `albums/<slug>/photos.yaml`) and writes edits straight back
through a new `applyPhotoEdits` function in `album-files.ts`. It lives inside
the `tools/pipeline` package itself — not as a new sibling `tools/editor`
package — and adds zero new dependencies: bare `node:http` for the server,
plain JS for the frontend.

**Why it lives inside `tools/pipeline`, not beside it.** The "pipeline↔site
boundary is type-only" entry above established that a workspace package can
only `import type` from `tools/pipeline`, never runtime values, because a
workspace dependency is a symlink into `node_modules`, and Node's native TS
type-stripping (this project's whole reason for having no build step) refuses
to strip types from anything under `node_modules`. The editor needs runtime
pipeline code — `album-files.ts`'s YAML read/write, the manifest reader — not
just types, so a new `tools/editor` package would hit exactly the wall that
decision described. Living inside `tools/pipeline/src/editor/` sidesteps it
entirely: every import is an ordinary relative path within the same package.

**Why no new dependency.** The API surface is five routes plus three static
files; bare `node:http` (routing, `node:stream/consumers`'s `json()` for
bodies, a hand-rolled static file handler) covers all of it without a web
framework. The frontend is deliberately plain DOM/`fetch` code, not a
component framework — there is no bundler anywhere in this project to feed
one into, and introducing the first one for an internal tool this small
would be a much bigger cost than the code it saves. `docs/dependencies.md`
gains no new entry because nothing was added.

**A new staleness guard, layered on the existing round-trip guard.**
`applyPhotoEdits` keeps `syncPhotosFile`'s existing round-trip safety check
(refuse to write if re-serializing the untouched document wouldn't reproduce
it byte-for-byte) and adds an orthogonal one: the caller passes a
`sha256Hex` of the `photos.yaml` content it last saw, which is re-hashed at
write time; a mismatch throws rather than silently overwriting whatever
changed it (`pnpm ingest` running concurrently, or a hand-edit). This is new
specifically because the editor is the first long-lived, stateful consumer
of `photos.yaml` — a browser tab can sit open holding stale state for
minutes, unlike the one-shot CLI commands (`ingest`, `describe`) that
motivated the round-trip check alone and that never overlap with themselves.
A mismatch surfaces to the UI as a 409 the user is told to reload for.

**What did not change.** No `photos.yaml` field is new — `alt`, `caption`,
and `tags` already existed (see the tags entry above); the editor is a
faster way to write the same fields `pnpm ingest`/`pnpm describe` already
read and write, not a new one. No manifest/`SCHEMA_VERSION` change — the
editor never touches `generated/albums/*.json`.

**Deferred, not built.** No `rolls.yaml` editing (per-photo tags/alt/caption
only). No numbered quick-tag hotkey slots (1–9 bound to a tag, Photo
Mechanic's defining feature) — autocomplete-driven tagging ships first; add
these once that's validated in real use. No automated test for the frontend
JS — no browser test runner exists in this repo, and `docs/dependencies.md`
has already rejected `vitest`/`jest` for reasons that would apply equally to
a DOM-testing dependency like `jsdom`; the pure logic that most benefits from
a test (tag-list merging, the batch bar's all/some tri-state computation) is
kept in small standalone functions instead, reviewable by eye. Deleting a tag
archive-wide has no in-app undo — renaming a tag and ordinary batch tag
edits do, through an in-memory inverse-edit stack — because the delete
route doesn't report which files it touched; `git` is the recovery path for
that one action specifically, and the UI says so.

**Revisit if.** The frontend's pure logic grows past what's comfortably
reviewable by eye — that's when a browser-less test target (not a full
`jsdom` suite) becomes worth reconsidering. Revisit quick-tag hotkey slots
once ordinary batch tagging has seen real use and specific repeated tags
would benefit from a single keystroke.

---

## 2026-07-29 — A photo's identity survives a move, not just its path

**Decision.** `albums/<slug>/photos.yaml` entries and `ingest`'s own
previous-manifest lookup both now correlate a photo by `sourceId` first,
falling back to `file` (path) — never `sourceId` alone. Moving or renaming a
file under `originals/`, into a different roll or out of one entirely, no
longer drops its `photos.yaml` entry: `syncPhotosFile`
(`tools/pipeline/src/album-files.ts`) matches the old entry to wherever its
content now lives and updates `file` in place, reporting it as `moved`
rather than one `removed` and one blank `added`. `ingest.ts`'s
`readPreviousRecords`/`resolvePriorRecord` apply the same fallback to the
JSON manifest's own previous-record lookup, so a moved-but-unchanged photo
also gets the cheap "reused" derivative path instead of being needlessly
re-normalised.

**Why.** This refines, rather than reverses, both entries above. "The
source digest covers file bytes, not pixels" already made `sourceId` stable
across a move for free — nothing needed to change there, it just was never
consulted for this. "A photo's identity is a path, not a filename" is still
true of the JSON manifest's own uniqueness guarantee (two different rolls
can't share a bare filename) — this decision only changes how
`photos.yaml`, a _separate_ file with its own join key, correlates an entry
to a photo. Path stays the tiebreaker exactly where content can't
disambiguate: a same-path re-export (docs/decisions.md, 2026-07-28) still
gets a new `sourceId` and new derivatives on purpose, but must still keep
its caption — matching purely by content would have regressed that into a
false "removed + added," which is why the fallback order is path-first for
resolving the JSON manifest's prior record and content-first for
`photos.yaml`'s entry, in each case checked in whichever order preserves
what already worked before adding what didn't.

**What did not change.** No `SCHEMA_VERSION` bump — `PhotoRecord.sourceId`
already existed in the JSON manifest; only `photos.yaml`'s own shape (never
version-gated) gained a field. No change to `tools/pipeline/src/editor/*` —
the editor reads the current manifest and current `photos.yaml` fresh on
every request and writes back by the `(album, file)` it just read; as long
as `syncPhotosFile` keeps `file` correct for wherever content currently
lives, the editor needed no changes at all.

**Cost.** A one-time backfill against the real `paris-2025` archive: running
`pnpm ingest` once (with nothing moved) gave all 150 existing entries a
`sourceId` field, reported as `sourceIdBackfilled`, with `moved`/`added`/
`removed` all empty and every existing caption, tag, and comment untouched —
confirmed against the real file, not just the fixture tests. A `sourceId`
shared by more than one current photo (byte-identical duplicate content)
can't disambiguate a move, so it's excluded from content matching entirely
and falls back to path, same as a legacy entry with no `sourceId` yet.

**Deferred, not fixed.** `albums/<slug>/rolls.yaml` (`syncRollsFile`) has the
identical path-matching problem one level up — renaming or merging roll
directories still loses `filmStock`/`notes`. Left alone for now: a roll has
no single hashable identity to correlate by (it's a grouping of many files,
not one), and rolls.yaml has far fewer entries to redo by hand than 150
photos' worth of tags would be.

**Revisit if.** `rolls.yaml`'s analogous loss becomes a real cost — at that
point a plausible fix is correlating a roll by the _set_ of its photos'
`sourceId`s (a roll surviving a rename if enough of its photos' content is
still present), not a single hash, which is a meaningfully different and
larger design than this one.

## 2026-07-30 — `pnpm ingest` deletes a batch's manifest and `albums/<slug>/` once its `originals/` directory is gone

**Decision.** `ingest.ts` already computed which `generated/albums/*.json`
files had no matching `originals/<slug>/` any more (`orphanManifests`), but
only printed a suggestion to delete them by hand. It now actually deletes
both the manifest and `albums/<slug>/` (captions, tags, roll notes — all of
it) for every such slug, every run, with no flag to opt out. The logic moved
into its own exported function, `removeOrphanAlbums(paths, currentSlugs)`,
so it's unit-testable against plain fixture directories instead of needing
a full image-encoding `ingest()` run.

**Why.** Discovered live, not speculatively: renaming a batch directory in
`originals/` (e.g. `littlelightfilmlab-01` → `llfl01`, done outside git,
mid-session) leaves the old slug's manifest and `albums/` directory
orphaned — `sourceId` matching already re-associates the photos' captions
and tags under the new slug (docs/decisions.md, 2026-07-29, "A photo's
identity survives a move"), so the old manifest is pure dead weight
duplicating content that lives on under the new slug. The batch-split
episode in CLAUDE.md's known limitations (`paris-2025` → `0827`–`0830`) hit
the same gap from the other direction. A warning nobody reads doesn't
prevent `generated/albums/paris-2025.json`-style clutter; deleting it does.

**What did not change.** `generated/derivatives/` is untouched — it's
content-addressed by `sourceId`, not batch, so a photo's derivatives stay
valid and reused regardless of which batch (if any) currently references
them. `pnpm doctor`'s equivalent check is unchanged in kind (still read-only,
per its one job) but its message now says to run `pnpm ingest` rather than
"delete it if the album is gone," since ingest does that now.

**Cost.** None observed: the one real orphan this surfaced
(`littlelightfilmlab-01`) was confirmed to be a pure rename of `llfl01` —
identical `sourceId`s throughout — before this shipped, not assumed.

**Revisit if.** A batch directory is ever removed from `originals/`
temporarily on purpose (an unmounted external drive, say) rather than
permanently — right now a single `pnpm ingest` run in that state silently
destroys the manifest and hand-written captions/tags for a batch that was
never actually retired. No confirmation step exists today because nothing
like this has happened yet; if it does, the fix is probably a grace period
or an explicit `--prune` flag rather than deleting unconditionally.

---

## 2026-08-03 — The site becomes multi-collection; photography is the first one, not the whole site

**Decision.** `/` is no longer the photography archive. It is a homepage whose
only job is to introduce **collections**, read from a registry
(`site/src/collections.ts`). Photography moved wholesale to `/photography/`,
and everything specific to it moved out of the shared `src/components/`,
`src/lib/`, and `src/scripts/` into `src/photography/`. A second collection,
recipes, exists at `/recipes/` to prove the seam is real. Adding a third is
one entry in the registry plus its own `src/pages/<slug>/` and (if it needs
one) `src/<slug>/` — never an edit to the homepage, to `Base.astro`, or to
another collection's code.

The split is by _content shape_, not by reusability. `src/photography/`
holds things that only make sense for photographs — the archive reader, the
manifest validator, the browse view, image URL building. `src/layouts/`,
`src/styles/`, and `src/config.ts` hold what is genuinely site-wide: the
shell, the design tokens, the author's name. `Base.astro` deliberately never
learns that photography exists; the photography-specific navigation lives in
`src/photography/PhotographyNav.astro` and is rendered by photography's own
pages.

**Why.** The archive model entry (2026-07-29) collapsed trip, place, and
subject into one mechanism because inventing a second structural concept
alongside the first was the wrong shape. This is the same argument one level
up. Photographs are not the only thing worth keeping a long-term, well-made
archive of, and the alternative to a collection registry was either a second
site or a homepage that grows an `if` per content type. A registry makes the
homepage's content a function of its data: its table of contents is built by
calling each collection's own `stats()` against that collection's own data,
so a count on the homepage cannot go stale the way a hand-typed number does.

**What did not change.** Nothing in `tools/pipeline/`, no manifest schema
change, and no change to the archive model itself — a trip is still a tag,
a view is still a query, and `viewForTag` is untouched. The old
`/projects/<tag>/` route became `/photography/<tag>/`; there is no redirect,
because nothing links to the old URLs yet.

**Rejected.** A shared `src/lib/` for "things more than one collection might
want." Photography's manifest reader and a recipe reader have nothing in
common but the word "read" — hoisting them together would produce an
abstraction with one honest implementation and one contorted one. Each
collection reads its own data its own way, and duplication between them is
the cheaper mistake.

**Revisit if.** A third and fourth collection genuinely share machinery (a
common front-matter reader, say). Two collections is not enough evidence to
abstract from; four might be.

---

## 2026-08-03 — Selected Work is editorial, not a tag; presentation order is independent from archival order

**Decision.** Two things a photographer chooses by hand now exist alongside
the archive's own chronological order, and neither is a tag:

- **`featured` / `featuredOrder`** in `photos.yaml` drive `selectedWork()` —
  a hand-picked, hand-sequenced run of photographs across the whole archive,
  rendered at `/photography/selected/`. `featured` is a boolean, and
  `featuredOrder` an optional number; ordered photos sort first by that
  number, unordered ones fall back to the archive's own `(roll, frame)`.
- **`cover`** in `albums/<slug>/album.md`'s frontmatter names one photo per
  batch. `coverPhoto()` prefers it and otherwise falls back to the
  chronological first.

**Why not a tag.** A tag is a claim about what a photograph _is_ — a place, a
subject, a trip — and every photograph carrying it belongs in that view,
unordered relative to each other beyond roll and frame. "This is one of my
best, and it goes third" is a claim about _presentation_, and it has an
ordering a tag has no way to express. Modelling it as a tag (`selected`)
would have meant either accepting whatever order the archive happened to
produce, or inventing a per-tag ordering mechanism that only one tag ever
uses — which is a worse version of just saying so per photo.

**Archival order is not touched by either.** `frame`, `byRollAndFrame`, and
every tag view still sort chronologically, exactly as before. `cover` and
`featuredOrder` are read _on top of_ that order by the two callers that want
a presentation sequence, never folded into it. A photograph being a cover or
being featured changes nothing about where it appears in its own tag's view.

**Where it's written.** Both live in the site-layer files a human already
edits by hand (`photos.yaml`, `album.md`), not in the pipeline manifest —
same boundary as `alt`, `caption`, and `tags`, and for the same reason. No
`SCHEMA_VERSION` bump, no re-encode, and `pnpm ingest` preserves them the
way it preserves every other hand-authored field. `pnpm edit` can set both,
which is why `album-files.ts` grew `readAlbumCover`/`updateAlbumCover` —
deliberately a second implementation of the site's own cover reader rather
than a shared one, consistent with the type-only boundary between the two
halves.

**Deferred.** Nothing enforces that `featuredOrder` values are unique or
contiguous — duplicates fall back to `(roll, frame)` and gaps are fine. A
validator can come the first time a real sequence gets confusing; today
there are four featured photographs.

---

## 2026-08-03 — Recipes are hand-written YAML with no pipeline at all

**Decision.** The recipes collection reads one YAML file per recipe from a
repo-root `recipes/` directory, straight off disk at build time
(`site/src/recipes/recipes.ts`). There is no ingest step, no generated
manifest, no cache, and no images — the photography pipeline's entire
apparatus is absent here, on purpose.

**Why.** That apparatus exists to solve problems recipes don't have:
photographs are large binaries that need deriving, content-addressing,
publishing to object storage, and a committed contract between an offline
encoder and the site. A recipe is a few hundred bytes of text a human types.
Running it through a pipeline would add a build step, a manifest to keep in
sync, and a schema version to bump, in exchange for nothing. The asymmetry
is the point: a collection brings only the machinery its content actually
needs, which is what makes adding one cheap.

**Shape.** Each file reads like documentation rather than a blog post — a
metadata row (times, servings, difficulty), ingredients, instructions in the
author's own words, notes, and a `version`/`created`/`updated` footer that
treats a recipe as a living document. Ingredients may carry `**bold**` for
quantities; `markup.ts` handles exactly that one inline form and nothing
else, rather than pulling in a Markdown parser to render bold text.

**Every field is optional at read time.** `readRecipe` defaults each missing
key rather than throwing, because a half-written recipe should render as far
as it goes instead of failing a build. This is the opposite of the manifest
reader's strictness next door — and correct for the same reason it's correct
there: a manifest is a machine-written contract where a missing field means
a bug, and a recipe is a hand-written note where it means "not typed yet."

**Revisit if.** Recipes get photographs. That is the point where the two
collections would genuinely share something (derivative encoding), and the
honest move then is to let the pipeline take a second content type, not to
give recipes their own parallel one.

---

## 2026-08-03 — Fidelity-first encoding: a long-edge cap, and a retune that re-encoded everything

**Decision.** `recipeVersion` went to 2, which invalidated and re-encoded
every derivative in the archive. Three changes together:

- **A size tier is a cap on the long edge, not on the width.** `encodeVariant`
  previously constrained a scaled resize by width only, so a _portrait_
  photograph's long edge — its height — was never capped by a tier at all: a
  "1200" variant of a portrait scan came out 1200 wide and far taller than
  1200, many times the intended pixel count and file size. `planVariants` now
  builds a square box and relies on sharp's `fit: 'inside'`, which caps
  whichever edge is longer and never pads the other, so the aspect ratio is
  exactly preserved for both orientations. `usableWidths` compares against
  the source's long edge for the same reason — comparing against a portrait's
  width meant excluding tiers it easily supports and offering its _short_
  edge as the native ceiling.
- **Quality went up, decisively.** AVIF 55 → 82, WebP 76 → 90, JPEG 80 → 90.
  The old numbers were chosen as a bandwidth trade; this is a fidelity-first
  archive of film scans, where grain and subtle gradients are the content and
  smoothing them away is a real loss.
- **Widths gained 3200 and 3840,** because the browse view renders a
  photograph at `sizes="100vw"` and the previous 2400 ceiling was visibly
  short of a large or Retina display. The legacy JPEG's upper width follows
  to 3840, since it's what a non-AVIF/WebP browser opens fullscreen.

**Why a version bump was unavoidable.** A derivative's key digests its
`EncodeSpec` — the tier _number_, not how the resize was computed. Fixing the
long-edge bug changed the output bytes without changing any field in the
spec, so nothing would have re-keyed on its own. `recipeVersion` is the
documented escape hatch for exactly this case and it was the only correct
lever.

**Effort stayed at 4.** AVIF effort 6 was tried first and measured, not
assumed: over three hours on this collection's few hundred photographs
without finishing. Effort trades encode time for a few percent of file size
at the _same_ quality — it does not affect fidelity — so it buys nothing a
viewer could ever see. The existing comment already called effort 9 a bad
trade; 6 turned out to be one too.

**Cost.** A full re-encode and a full re-publish: every URL in every manifest
changed. This is the designed behaviour of content-addressed derivatives, not
a regression — no schema version bump, no migration, and `originals/`
untouched. `inspectDerivative` was added to `encode.ts` for the one case that
now needs it: a derivative already on disk with no previous manifest record
to copy dimensions from, where the plan's box is not a prediction of the real
output size and has to be read off the file instead.

---

## 2026-08-03 — A third collection, films, and why it isn't scraped

**Decision.** `/films/` is a third collection: a five-star viewing log built
from Letterboxd's own "export your data" feature. `films/five-star-ratings.csv`
is that export's `ratings.csv`, trimmed to 5-star rows and committed
unmodified — not transcribed, not restructured into YAML, one file for the
whole collection rather than one per film. `site/src/films/films.ts` reads it
straight off disk at build time: no pipeline, no fetching, no cache, the same
shape recipes already established for "a collection brings only the
machinery its content actually needs."

**Why one CSV, not one file per film.** Recipes are five hand-written
documents; a person can hold all of them in their head, and one YAML file per
recipe matches how someone edits them. 773 films is a different kind of
content entirely — an export, not prose — and one-file-per-film would mean
773 nearly-identical stub files with no one ever hand-editing an individual
one. A single committed CSV that a spreadsheet or script can still open
directly is the honest shape for data at this size, the same reasoning that
already justifies one manifest per photography batch instead of one file per
photograph.

**Why a hand-rolled CSV reader.** Letterboxd film titles routinely contain
commas ("Synecdoche, New York", "Paris, Texas") and quotes, so a naive
`split(',')` would silently corrupt the file — this needed a real RFC 4180
reader, not string splitting. `parseCsv` in `films.ts` is around 30 lines; a
dependency for one committed file didn't clear the bar in
`docs/dependencies.md`.

**Why posters don't come from Letterboxd.** Letterboxd's own `robots.txt`
disallows AI crawlers by name across the entire site, and a direct fetch of
a ratings page independently returned 403. Both are the site telling
automated tools not to extract its content, and that doesn't change based on
which URL is requested or which tool does the requesting — a
browser-automation workaround would just be the same scrape wearing a
different tool, so it was refused the same way a direct scrape was.

**Posters come from TMDB instead, via a separate opt-in enrichment step.**
`tools/films/fetch-posters.ts` (`pnpm films:posters`) is its own workspace,
not a script inside `tools/pipeline` — it needs `TMDB_READ_ACCESS_TOKEN` in
`.env` and makes real network calls, which `pnpm ingest` must never do
(constraint 1). It reads `films/five-star-ratings.csv`, looks each
title+year up against TMDB's search API, and writes `films/tmdb.json`, a
committed cache the site reads at build time — `site/src/films/films.ts`
itself still makes no network call, the same boundary `pnpm describe` draws
for photography. All 773 films matched; 772 of them have a poster. This
mirrors `pnpm describe`'s relationship to the pipeline closely enough that
it was tempting to fold it into `tools/pipeline`, but `tools/pipeline` has
its own hard "no Astro/Vite/Tailwind" boundary and no reason to know films
exist — a fourth, tiny workspace was more honest than stretching an existing
one's purpose.

**Search is a heuristic, so a correction file exists.** TMDB's search
ranks results by relevance, not by year, so `fetchById`/`searchFilm` prefers
whichever result's release year matches Letterboxd's exactly — imperfect,
because a festival-year credit on Letterboxd vs. TMDB's wider-release date
can lose to an unrelated same-year film. `films/tmdb-corrections.yaml` is
the hand-maintained escape hatch: a confirmed TMDB id that always overrides
the heuristic, re-run with `--only "Title (Year)"` so fixing one entry
doesn't mean re-fetching all 773. The one real case so far, Bertrand
Bonello's "La Bête," is recorded there with why.

**Cropping is opt-in per poster, not automatic.** The default poster
treatment is `object-fit: contain` — the whole image, no cropping — because
that's correct for the overwhelming majority of TMDB's posters.
`films/poster-overrides.yaml` lets a specific poster that reads poorly at
that default (a lot of dead margin around a small central image) switch to a
cover crop centred on a hand-chosen focal point and zoom. This is the same
shape as `photos.yaml`: content is authored/cached automatically, a human
corrects the rare exception by hand in a small committed file, not by
teaching the fetch step more heuristics.

**Attribution is required, not optional.** TMDB's terms require crediting
them wherever their data is shown; the films page renders the attribution
line only when at least one film actually has a poster (`hasPosters`), so
the sentence doesn't appear on a page that ends up rendering none.

**Revisit if.** A film in `tmdb-corrections.yaml` gets a better match, or a
`TMDB_READ_ACCESS_TOKEN` rotation is needed — nothing about the collection's
shape changes either way, since `Film`'s enriched fields were designed
optional from the start (`loadFilms` already tolerates `tmdb.json` being
entirely absent).

---

## 2026-08-04 — Recipe serving-size scaling and checklists are client-side-only, and scaling stops at the ingredients list

**Decision.** `site/src/recipes/scale.ts`, `serving-scale.ts`, and
`checklist.ts` add a ½×/1×/2× quantity scaler and real checkbox
ingredients/instructions to the recipe page, both as progressive
enhancement scripts imported from `[slug].astro` — nothing here touches
`recipes/*.yaml`, `recipes.ts`, or how a recipe is authored. Both are pure
site-layer state, same boundary as `browse.ts` for photography.

**Scaling reaches `<strong>` quantities in the ingredients list only, never
instruction text.** `renderQuiet` already marks a measurement embedded in an
instruction step (a cook time, a splash of pasta water) with a deliberately
quiet `.measurement` style, precisely because it isn't a quantity to shop
for and often doesn't scale linearly with servings in the first place —
scaling it automatically would misinform, not help. `scaleQuantity` only
ever touches nodes inside `.recipe-doc-list`, which the ingredients markup
already bolds for exactly this reason.

**Every scale factor is computed from the original text, not the currently
displayed one.** `serving-scale.ts` caches each element's pre-scale text in
`data-original` the first time it's touched. Scaling from the live DOM value
instead would compound rounding error across repeated switches (½ of an
already-rounded ½ of 2 is not the same as ½ of the original 1×).
`formatNice` always snaps the result to a common cooking fraction (⅛ ¼ ⅓ ½ ⅔
¾) or a whole number rather than a raw decimal — a scaled recipe still has
to be read off a measuring cup, not a spreadsheet.

**The checklist's progress counter has no honest empty state, so it's
omitted rather than shown as zero.** Nothing is checked on a fresh load; a
server-rendered "0/11 · 0%" would be technically true and useless on every
first view, so `[data-recipe-progress]` starts blank and only gets text once
at least one box is checked. Checked state is real, useful, and entirely
ephemeral — it lives in `localStorage`, keyed per recipe slug and per
section (`recipe-checklist:<slug>:<section>`) so ingredients and
instructions track independently — and was never a candidate for
`recipes/*.yaml`, which is authored content, not viewer state.

**Checkboxes are real `<input>` elements, not a custom widget.** The
strikethrough/muted treatment on a checked item is pure CSS (`:checked ~
span`); a visitor with JavaScript disabled still gets working checkboxes
with the same visual feedback, just without cross-visit memory or the
percentage counter — the same "still correct without the script" bar
constraint 7 sets for browse mode.

**Revisit if.** A recipe ever needs per-serving quantities authored
directly (rather than derived by scaling written-for-N-servings text) — the
current model assumes every `photos.yaml`-style quantity in
`recipes/*.yaml` is written for the recipe's own `servings` value and scales
from there.

---

## 2026-08-08 — A private, password-gated notebook (`/private`), served by a new long-lived process outside Astro entirely

**Decision.** `/private` is a hand-appended personal notebook — short dated
entries, optionally tagged `joy`, optionally carrying a photo — that needs
real password protection: not an obscure URL, not a client-side check, not
`robots.txt`. Every other route in this project is either a fully static
page (`site/dist/`, built once and never touched again) or an offline CLI
that exits when it's done. Neither shape can check a password on every
request, so this needed something genuinely new: `tools/serve`, a small
long-lived Node HTTP server (`pnpm serve`) that serves `site/dist/`
unchanged for every public path and adds exactly one gated area on top.

**Why a new workspace instead of an Astro adapter.** The alternative was
giving Astro itself a server adapter (`@astrojs/node`) and marking one route
`prerender: false`. That would have made the _build_ aware of privacy —
every other page would need an explicit `prerender: true` to stay static,
turning "this page must never require a server" from true-by-default into
something enforced by remembering to add a line to every file. Keeping
`site/` 100% static and putting the gate in front of it in a separate
process means the 26 public pages are exactly as static as they were
yesterday, verifiably: nothing in `site/src/` can read `private/` even by
accident, because nothing in `site/src/` runs at request time at all.

**Why sessions are a signed cookie, not a session store.** This is a
single-user area. A database (or even a small on-disk session table) to
track "is this device logged in" would be real infrastructure for a
question that a signed timestamp already answers: `tools/serve/src/session.ts`
issues `<expiry>.<hmac>` and verifies it by recomputing the HMAC — no
lookup, nothing to garbage-collect, nothing that survives a server restart
as state (the cookie itself is the only state, sitting in the browser).
Losing `PRIVATE_SESSION_SECRET` or rotating it logs everyone out at once,
which for one person is a feature, not an incident.

**Why the password check hashes both sides before comparing.**
`crypto.timingSafeEqual` requires two buffers of equal length and throws
otherwise — a raw password string can't guarantee that against another raw
string of arbitrary length. `passwordMatches` HMACs both the candidate and
the real password with the session secret first, so the comparison is
always two fixed-length digests, avoiding both the length-mismatch throw
and a timing side-channel on password length.

**Why the notes data can't be fetched by guessing the URL.** The literal
requirement was: authentication has to be real, not "the page isn't linked
from anywhere." `private/notes.yaml` and `private/photos/` sit outside
`site/` entirely and are never read by the Astro build — `site/dist/` has
no route, hashed or otherwise, that resolves to that data, so there is
nothing to guess. `tools/serve`'s static-file branch only ever reads from
`site/dist/`; `/private`'s own data path is a separate branch in the same
router that checks `verifySessionToken` before touching the filesystem at
all (`server.test.ts` asserts this directly: requesting
`/private/notes.yaml` returns a plain 404 from the static branch, and
`/private/photos/<file>` returns 401 before the file is even looked up).

**Why `Secure` is unconditional.** The cookie is `HttpOnly; Secure;
SameSite=Lax` with no env-var escape hatch to disable `Secure` for local
HTTP testing. A cookie that would still be sent over plain HTTP is exactly
the mistake worth not leaving a knob for. The operational consequence: this
only works served over HTTPS, which for this project means running it
behind `tailscale serve https` (Tailscale's automatic per-node TLS)
rather than reaching `pnpm serve`'s port directly.

**Why this server binds every interface, unlike `pnpm edit`'s.** Constraint
10 requires the editor's server to stay on `127.0.0.1` because it has _no_
authentication — anyone who could reach it could write to `photos.yaml`.
`tools/serve` exists for the opposite reason: its whole purpose is to be
reachable from other devices (the point of putting a password on it at
all), and it gates access with a real verified session instead of relying
on "nobody else is on localhost."

**What was deliberately left out.** No rate-limiting or lockout on
`/private/login` — acceptable for one known user, not a pattern to reuse if
this ever became multi-user. No process supervisor (systemd/pm2/etc.) — the
process has to actually be running for `/private` to exist, and today
that's a foreground `pnpm serve` a person starts by hand.

**Revisit if.** This ever needs more than one person to log in (at which
point a signed-cookie-with-one-shared-password stops being the right
model), or `/private` needs to survive the host machine restarting
unattended (at which point it needs real process supervision, not a
foreground command).

---

## 2026-08-09 — Per-photo `location`, and surfacing camera/lens EXIF the pipeline already captured

**Decision.** `ArchivePhoto` gains a `location: string | null` field, read
from a new optional `location:` key in `photos.yaml` — same boundary as
`caption`, same site-layer-only treatment (no manifest field, no
`SCHEMA_VERSION` bump). The 2026-07-29 entry ("Trips become a tag") deferred
this exact field, explicitly pending "the first time a photograph actually
needs one written down"; that entry was correct when written and is left
unedited (decisions here are append-only), but the photographer has now
asked for it directly, which is precisely the condition that entry named.

Separately, `site/src/photography/manifest.ts`'s `Camera` type
(`make`/`model`/`lens`/`focalLength`/`aperture`/`shutterSpeed`/`iso`/`takenAt`)
has held real EXIF data per photo since the manifest schema's own
introduction, but nothing in the site ever rendered any of it beyond
`takenAt` (used only to derive a roll's date). A new pure function,
`camera.ts`'s `formatCameraLine`, joins whatever subset of camera fields
plus `location` a photograph actually has into one quiet line
("Leica M6 · 50mm · f/2.8 · 1/250 · ISO 400 · Rue de Bretagne, Paris"),
omitting any missing piece cleanly rather than leaving a stray separator.

**Where it renders, and where it deliberately doesn't.** `Browse.astro`
only — the one shared per-photo detail view behind every photography route
(tag pages, Selected Work, film-stock pages), so adding it once covers all
of them. Not `Photo.astro`, which stays metadata-free by existing
convention (both its callers already render captions/film-stock themselves
at the call site). Not the archive index, which shows one cover thumbnail
per _view_, not per photograph — rendering one photo's EXIF there would
misattribute it to the whole view, the same reasoning that already keeps
the intro panel's film-stock line conditional on `view.roll !== null`.

**No new CSS.** `.browse-item-meta` already existed for per-photo film
stock in multi-roll views and is exactly the right quiet, centered,
small-caps treatment for a second stacked line — only its comment changed
to document the second use.
