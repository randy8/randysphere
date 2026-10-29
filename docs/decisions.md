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

---

## 2026-08-17 — Real process supervision for `tools/serve`, and committing the unit files

**Decision.** `photography-serve.service` and `cloudflared-tunnel.service`
are now `systemd` units — `enable`d (survive a reboot with no manual step)
and `Restart=on-failure` (come back on their own after a crash) — replacing
the foreground `pnpm serve` a person had to start by hand. This is exactly
the "revisit if" condition the 2026-08-08 entry named: `/private` needed to
survive the host machine restarting unattended, and it now does.
`cloudflared-tunnel` additionally declares `Requires=photography-serve`, so
the tunnel comes up only after the site is actually listening, and stops
first on shutdown — ordering that costs nothing and rules out a whole class
of "tunnel is up, origin isn't" failures.

Both unit files, plus the tunnel's `config.yml`, are now committed under
`deploy/` rather than existing only as hand-edited files on one machine.
None of the three contains a secret — the tunnel's actual credential is a
separate JSON file (`~/.cloudflared/<tunnel-id>.json`) that stays
uncommitted by design, referenced by path only. Committing the units turns
"how is this box actually configured" from tribal knowledge into something
`git log` can answer, and makes rebuilding the box from scratch a documented
procedure (`docs/deployment.md`) instead of a from-memory exercise.

**The one new command.** `pnpm deploy` — `pnpm sync && pnpm build && sudo
systemctl restart photography-serve` — is the single command that covers
publishing any change (code, recipe, photograph) live. It deliberately does
not run the test suite itself, the same way `git push` doesn't run CI
locally: `pnpm verify` is still a separate, expected step before deploying,
not folded in, so a routine deploy stays fast.

**Rejected.** A CI/CD pipeline (GitHub Actions building and pushing to the
box) was considered and rejected as more moving parts than a single-person
project with infrequent deploys needs — SSH secrets to manage, a runner to
trust, a failure mode (a broken deploy from CI) that's harder to debug
by hand than a failed local `pnpm deploy`. Revisit only if deploys become
frequent enough, or collaborative enough, that "run one command on the box
itself" stops being the fast path.

**Revisit if.** A second person ever needs to deploy (at which point SSH
access to this one box stops being a reasonable model), or uptime
requirements grow past what `Restart=on-failure` plus a same-day manual fix
covers.

---

## 2026-08-18 — In-album navigation is circular; leaving for the next album is a separate, deliberate action

**Decision.** `browse.ts`'s `advance()` wraps: forward past the last photo
in a view returns to the first, backward past the first returns to the
last. Both the arrow keys and the click zones on each photo (left half
back, right half forward) call this same function — neither can carry a
visitor out of the current tag's view.

**What was tried and reverted.** The first version of this instead had the
keyboard's forward key jump straight to the next album (reading a
`data-next-href` off the browse root) once it ran out of photos in the
current one — the same destination the outro panel offers, just reachable
without scrolling. In practice this makes holding down or repeatedly
pressing the forward key — a natural way to skim a sequence quickly —
capable of leaving the page entirely with no visual warning beyond
whatever photo was on screen when the key landed on the last one. A real
footgun, and one that cuts against the site's own "read start to end,
unhurried" framing (see CLAUDE.md) by turning the fastest input into the
one most likely to misfire.

**Why circular, not just "stop."** A hard stop (repeatedly do nothing past
the last photo) was the safe alternative but reads as broken rather than
intentional — nothing tells a visitor they've reached an edge. Wrapping
communicates the edge was reached (the photo visibly changes) while
keeping them inside the current album — and it matches the actual product
intent behind this feature: a visitor should spend a little longer with
each photograph, not get swept toward the exit by a key they were already
holding down.

**Why the chapter-closer panel is exempt.** It isn't reachable by holding a
key — only by scrolling to it, tabbing to it, or clicking it, all
inherently deliberate actions — so it stays the one sanctioned way out. Its
href is a plain `/photography/<tag>/` link needing nothing from
`browse.ts`'s navigation state, which is why removing `data-next-href`
(dead once the keyboard stopped reading it) didn't touch it.

**Why "next" is `allTags()`'s own alphabetical order.** `/photography/archive/`
already lists every tag view in that order — reusing it means "next" always
matches what a visitor would find by going back to the archive and picking
the following entry, rather than a second, invisible ordering (e.g.
chronological by EXIF date) that would disagree with the one order the site
already shows.

**Revisit if.** A future request specifically wants keyboard-driven
album-to-album paging (e.g., a dedicated "next album" key distinct from the
in-album forward key) — that could reuse the removed `data-next-href`
approach without reintroducing the footgun, since a distinct key doesn't
share the accidental-repeat problem forward/`j` does.

---

## 2026-08-18 — Grid is now the no-JS fallback only; Browse reads left to right, not top to bottom

**Decision.** The Grid/Scroll toggle (`.view-toggle`, `#grid`/`#browse` URL
states, `data-default-view`) is removed from every photography page that
had one. With JavaScript on, a visitor always lands directly in Browse
mode — there is no grid to opt into any more. The grid markup itself is
untouched and still server-rendered on every page; it is simply always
hidden the instant `is-browsing` is added, which each page's early inline
script now does unconditionally instead of reading `location.hash` to
decide. Separately, Browse mode's own layout changed axis: `.browse-stack`
went from `flex-direction: column` (photos stacked, page scrolling down
through them) to `flex-direction: row` with `scroll-snap-type: x mandatory`
— each photo (and the opening/closing panels) is exactly one viewport wide
and tall, and moving through an album is now a left-to-right sequence, not
a vertical scroll.

**Why the grid stays in the DOM at all.** Constraint 7 (`CLAUDE.md`) is
unconditional: the site must work with JavaScript disabled. Browse mode's
interactivity — arrow keys, click-to-advance, the intersection-observed
position tracking — has no no-JS equivalent, so the grid's plain `<a>`
links to full-size JPEGs remain the only way to view a photograph at all
without a script running. This is the same relationship the grid always
had to Browse mode; what changed is that a JS-enabled visitor now never
sees it, where before it was one state of a toggle they could return to.

**Why Selected Work lost its grid-first default too.** It was the one page
that opened on the grid by design — "the point of a curated set is to be
surveyed at a glance, not read start to end" (the same reasoning is still
correct on its own terms). Removing the toggle site-wide meant no page
could keep a grid-default behavior without reintroducing the thing being
removed, so Selected Work now opens into Browse like every other page; the
shuffle script that used to randomize both the grid and the browse stack's
order now only shuffles the stack, since the grid is never seen by anyone
who'd notice.

**Why photo sizing became one rule instead of landscape/portrait split.**
The old vertical layout let a landscape photo fill the available width
(bounded only by the page's own max-width) and only capped a portrait
photo's height, because the page itself had no fixed height to respect.
A horizontal, one-screen-per-photo layout has a fixed box on both axes —
exactly one viewport, minus whatever the caption underneath takes — so
every photo, regardless of orientation, now has to fit inside that box
without overflowing either dimension. `width: auto; height: auto;
max-width: 100%; max-height: 100%;` (contain, not cover) replaced the old
width-driven-landscape / height-capped-portrait split entirely, on a photo
wrapper (`.browse-item-frame`) that flex-grows to fill whatever vertical
space the caption doesn't take.

**What this made dead, and was removed rather than left.** The grid
density control (`GridDensityControl.astro`, `data-grid-density`,
`photography-grid-density` in `localStorage`) governed the grid's column
count — a size preference for something a JS-enabled visitor would never
see again once the grid stopped being reachable. Rather than leave an
unreachable control in the DOM (real markup, a real inline script, real
CSS, controlling nothing anyone could see), it was deleted outright: the
component file, its wiring in `browse.ts`, and its CSS. The grid itself
reverted to the single fixed 2/3/4 column layout it had before that
feature existed, and each page's `sizes` hint on its (now no-JS-only) grid
images went back to the tighter values calibrated to that one layout.

**Revisit if.** A future request wants the grid back as a real, reachable
view (not just a no-JS fallback) — at that point the toggle, its URL
state, and `defaultView` would need to come back in some form, and this
decision's premise (a JS-enabled visitor never sees the grid) no longer
holds.

---

## 2026-08-19 — The full-size srcset tier tops out at 2560, not a higher Retina ceiling

**Decision.** `pipeline.config.ts`'s `widths` caps at 2560, matching an
explicit brief for the grid's smaller tiers (640/960/1280/1920) plus one
full-size tier. The previous config topped out at 3840 — sized, by its own
comment, for a 2x-DPR 1920 CSS-px-wide desktop viewport. 2560 is not that;
it is generous for a typical Retina laptop but not a literal 2x cap for
every real desktop window size.

**Why 2560 anyway.** The brief was specific and said "roughly" and
"around" throughout, reading as a considered ceiling rather than an
approximation of something larger — and it is already well past what most
image-heavy sites serve as their largest tier. Guessing past an explicit
number toward a more theoretically-complete one would have second-guessed
a clear instruction for a marginal gain most visitors' displays cannot
resolve anyway (few browser windows are both 1920 CSS px wide _and_ 2x
DPR at once — that combination needs a large external Retina monitor, not
just any Retina laptop).

**The actual tradeoff, named plainly.** On a 2x-DPR display with a browser
window wider than ~1280 CSS px, the full-size browse view (`sizes="100vw"`)
now serves a file that is sharp but not pixel-for-pixel native — the
browser's downscale-then-upscale-to-fit at that combination is real,
just below where most people notice it at normal viewing distance.

**Revisit if.** Someone viewing on a large external Retina/5K display
reports the full-size view reading as soft — at that point a sixth tier
(e.g. 3200 or 3840) is a config-only change, no architecture to redo.

---

## 2026-08-20 — Saved's grid and viewer are one page, and shared links live in the query string

**Decision.** `/photography/saved/` renders its contact-sheet grid and a
full `Browse` instance on the _same_ page, toggled by the existing
`body.is-browsing` class — not a separate route the grid navigates to.
Exiting the viewer removes that class rather than navigating anywhere.
Separately, `/photography/share/`'s photograph list is encoded in
`?s=...` (a query string), not the URL hash.

**Why one page for grid and viewer.** The spec asked for the viewer to
"return to the same album and approximately the same grid/scroll
position" on exit — which sounds like it needs real state restoration
(remember scroll position, re-render the grid, restore it) across a
navigation. It doesn't, if the grid is never actually left: every other
photography page already renders both a no-JS grid and a full `Browse`
stack in one page, toggled by `is-browsing` (added once, early, never
removed). Saved just lets that same toggle run in both directions. The
grid sits in normal document flow the entire time, `display:none` while
browsing under `body.is-browsing { overflow: hidden }` — the window's own
scroll position is simply never touched while hidden, so it's still
exactly where it was the moment the class comes back off. No scroll
position was ever saved or restored; none needed to be.

**Why a query string for the share link, not the hash.** `browse.ts`'s
`#photo-<id>` already owns the URL hash on every Browse page, `/share/`
included — `replaceHash()` calls `history.replaceState(null, '',
'#photo-xyz')`, and per the URL spec a fragment-only reference like that
resolves against the _current_ URL, replacing only the fragment and
leaving the path and query string untouched. Putting the shared id list in
`?s=` instead means it survives every photo-to-photo hash change inside
the viewer for free, with zero changes to `browse.ts` — the two mechanisms
never have to know about each other. Static file serving (both Astro dev
and `tools/serve`) already ignores the query string when resolving which
file to serve, so this costs nothing on the routing side either.

**The `decodeIds` duplication.** `tools/serve`'s planned per-link
Open-Graph preview (decoding `?s=` server-side to point `og:image` at the
first shared photograph) needs the same decoder `site/src/photography/
share-code.ts` already has. It's copied, not imported — `tools/serve`
depends on neither `site` nor `tools/pipeline` by design (see its
`package.json` description, and `server.ts`'s existing `isSafeRelativePath`,
copied from the pipeline editor for the identical reason). A ~15-line,
dependency-free, DOM-free function is cheaper to duplicate once than to
justify a new cross-workspace dependency for.

**Revisit if.** A future "Albums" feature needs a _named_ collection to
survive across more than one page (e.g. a dedicated URL per local album,
not just Saved) — at that point grid-and-viewer-as-one-page may need to
become grid-and-viewer-as-two-pages with real state handed between them,
and the free scroll-preservation trick here would need to become a real
`sessionStorage`-backed one instead.

---

## 2026-08-24 — `/` redirects to photography; the collections homepage moves to `/collections/`

**Decision.** `/` is now a build-time redirect (`astro.config.mjs`'s
`redirects`) straight to `/photography/selected/` — the same URL
`collections.ts`'s photography entry already points at. The page that used
to live at `/` (introduce every collection, no content of its own) moved
unchanged to `src/pages/collections/index.astro`, reachable at
`/collections/`, and is now linked from the site-wide footer ("All
collections") so recipes/music/films stay reachable by more than a direct
URL or a search engine. `sitemap.xml.ts` advertises `/collections/`
instead of `/`, since `/` itself is no longer a real page a crawler should
index.

**Why.** This directly reverses the 2026-08-03 decision below ("The site
becomes multi-collection; photography is the first one, not the whole
site"), on explicit request: every visit was stopping at a table of
contents before reaching the photographs, for a site whose whole reason for
existing is the photography. The multi-collection registry itself is
untouched — `collections.ts`, the homepage template, `stats()`,
`urls()` — only where "/" points is different.

**What did not change.** `Base.astro` still never learns that photography
exists; the redirect target is a literal string in `astro.config.mjs` (site
build config, not `Base.astro`), matching the same literal already
hand-kept in `collections.ts`'s photography entry — the same duplication
the 2026-08-03 entry already accepted for that entry, not a new pattern.
The masthead wordmark still links to plain `/` rather than hardcoding a
collection's URL into the shared layout.

**Rejected.** Deleting the collections homepage outright rather than moving
it to `/collections/`. Recipes, music, and films are still real
collections a visitor should be able to browse from the site itself, not
just guess the URL for — orphaning them from every page's chrome traded one
kind of directness (photography, faster) for another kind of loss
(everything else, undiscoverable).

**Revisit if.** A second collection becomes popular enough to want its own
`/`-adjacent shortcut, or the "All collections" footer link turns out to be
too quiet for anyone to find in practice (worth a usage check once there's
real traffic).

---

## 2026-08-24 — Browse mode's frame height is capped below 40rem, so a landscape photo doesn't strand its caption

**Decision.** `.browse-item-frame` (`site/src/styles/base.css`) gets a
`max-height: 66dvh` below the 40rem breakpoint, on top of its existing
`flex: 1 1 auto`. Nothing else about the browse-mode layout changed.

**Why.** The frame flex-grows to fill whatever vertical space the caption
stack below it doesn't use, which is exactly right on a wide desktop
viewport (a landscape photo is usually the one being height-bound there,
so growing the frame grows the photo). On a phone-width, portrait-oriented
viewport it backfires: a landscape photo is width-bound instead (its
rendered height is fixed by its aspect ratio well before the frame's
available height matters), so the frame still grows to fill nearly the
whole screen — around it, not the photo — and the caption/film-stock/save
button, sized to their own content rather than flexed, end up stranded
right at the bottom edge, a long dead gap away from the photograph they
describe. Verified with Playwright screenshots at a 390×844 viewport
against a real landscape photo (3130×2075) and a real portrait one
(2075×3130) from this archive: uncapped, the frame reached ~780px on that
landscape photo with a ~240px gap between photo and caption; capped at
66dvh (~557px), the gap between the frame's own bottom edge and the save
button closes to ~16px, while the portrait photo — already width-bound at
~513px, comfortably under the cap — is unaffected pixel-for-pixel.

**Why 66dvh and not something tighter.** `.photo img`'s `max-height: 100%`
resolves against the frame's own _used_ height, which is well-defined only
because the flex algorithm gives a flex-grown-then-clamped item a definite
resolved size (a real, spec-backed provision — the same one this rule
already relied on before this change, just without the clamp). Sizing the
frame to hug the image tightly instead (`flex: 0 1 auto`) was tried and
rejected: `browse.ts` disables native touch scrolling
(`touchmove` → `preventDefault()`) and drives all forward/back navigation
through the `[data-nav]` click zones inside this same frame, which are the
_only_ way to advance photos by touch. Shrinking the frame to the image's
own rendered size would shrink those tap zones by the same amount — for a
short landscape photo, down to a thin strip in the middle of the screen —
trading a visual gap for a much smaller touch target. 66dvh keeps the tap
zone large (most of the screen) while still comfortably clearing the
tallest a standard 2:3 portrait gets width-bound to at typical phone
widths, so only landscape photos — the ones actually stranding their
caption — are affected.

**Revisit if.** A future archive photo has a more extreme aspect ratio than
standard 35mm 2:3 (a stitched panorama, say) and gets clipped by the 66dvh
cap on a narrow viewport — at that point the cap needs to become
aspect-ratio-aware (the manifest already has each photo's own width/height
to compute from) rather than one flat constant.

---

## 2026-08-24 — Browse's init() is deferred a microtask, so Saved/Share prune the stack before it reads one

**Decision.** `browse.ts`'s self-run at the bottom of the file
(`document.readyState === 'loading' ? ... : init()`) now defers the actual
`init()` call through `queueMicrotask`, instead of calling it inline.

**Why.** `/photography/saved/` and `/photography/share/` both render the
_entire_ archive into the Browse stack server-side, then run their own
script (`saved-view.ts` / `share-view.ts`) to prune the DOM down to just
the saved or shared subset before a visitor sees it — the same trick
described in the 2026-08-20 entry above. Both of those scripts
`import { openPhoto } from './browse.ts'`, so they can hand a clicked grid
tile to Browse once pruning is done. Per the ES module spec, evaluating an
`import` means running the imported module's own top-level code to
completion _first_ — so `browse.ts`'s top-level `init()` call (which reads
`stack.querySelectorAll('[data-photo-id]')` once and closes over the
result as `items`/`ids` for the rest of the module's lifetime: `advance()`,
the IntersectionObserver's scroll-tracking, preloading, all of it) ran
_before_ `saved-view.ts`/`share-view.ts`'s own pruning code, regardless of
which `<script>` tag looked first in the rendered HTML. The DOM still
looked correctly pruned moments later (share-view.ts genuinely does remove
the extra elements), but `items`/`ids` had already captured the full,
unpruned archive-order list by then — detached elements are still valid JS
references. Tapping a shared album's "next" zone, or scrolling far enough
for the IntersectionObserver to fire, could walk straight out of a
two-photo shared selection into whatever photo happened to be
archive-adjacent to it. Confirmed with Playwright against a real built
`site/dist/` (not just `astro dev`, to rule out a dev-only artifact):
before this change, "next" from a 2-photo `?s=` link landed on an unrelated
third photo from the same batch; after, it looped correctly between
exactly the two shared photos.

**Why a microtask, not restructuring `init()` into an explicit export.**
`queueMicrotask` always runs after the synchronous script that queued it
finishes — which, for a script importing `browse.ts`, includes the rest of
_that importing script's own body_ (the pruning), since import evaluation
and the importer's top-level code both run within the same synchronous job
before any microtask checkpoint. That fixes the ordering at its root for
every current and future page, with a one-line change, regardless of
`<script>` tag order. The alternative — exporting `init` and having each of
the five pages that use Browse call it explicitly, in the right order for
their own page — is more explicit but requires every current and future
Browse page to get that ordering right by hand; the microtask fix makes
"pruning before Browse reads the DOM" true unconditionally instead of a
convention someone has to remember.

**Revisit if.** A future page needs to prune the stack _asynchronously_
(an `await` before the DOM mutation finishes) — a microtask isn't enough
there, and `init()` would need to become an explicit, awaited export
instead.

---

## 2026-08-24 — Pinch-to-zoom in Browse mode, touch-only, pinch instead of double-tap

**Decision.** `site/src/photography/zoom.ts` adds pinch-to-zoom and pan to
the current photo in Browse mode (`MAX_SCALE = 4`), wired up from inside
`Browse.astro` itself (one `<script>` at the end of the component, calling
`initZoom(document.querySelector('[data-browse]'))`) rather than from each
of the five pages that render `<Browse>` — every page that uses the
component gets it for free, the same way `PhotographyNav.astro`'s own
inline script needs no per-page wiring either. One delegated listener set
on `[data-browse-stack]`, not one per photo (a Selected Work stack alone is
325 frames) — per-frame gesture state lives in a `WeakMap`, created lazily
on the first touch a given frame actually sees.

**Why pinch, and deliberately not double-tap.** The nav-zone strips a plain
tap already advances through (`.browse-item-nav`, see its own comment in
`base.css`) read a single tap as "advance," instantly, with no threshold —
the 2026-07-29 reading-view entry and browse.ts's own wheel/touchmove
comment both already rejected adding any gesture threshold to that
interaction as reading "unpredictable." Double-tap-to-zoom needs exactly
that: holding every ordinary tap back a couple hundred milliseconds to see
whether a second one arrives before committing to "advance," since the nav
zones physically overlap most of the photo (letterboxed photos don't reach
the frame's own edges, which is why those zones are sized against the
frame and not the rendered image — see that same base.css comment). Pinch
has no such conflict: it always takes two simultaneous touches, which a
single-tap advance never does, so it can be added with zero latency cost
to the existing gesture. Once a photo is zoomed in, a plain single tap is
repurposed to reset back to fit instead — there's no "next photo" to reveal
from inside a zoomed-in crop the way there is on an unzoomed one, so
nothing is actually taken away from the existing gesture, only extended to
a state that didn't exist before.

**The math.** Two things had to be right for this to feel like a real
photo viewer rather than a toy: the point under two pinching fingers has to
stay visually fixed as scale changes (`zoomAt`, rescaling around a focal
point in frame-local coordinates rather than the frame's own centre — the
standard "zoom under the cursor" formula, here driven by the pinch
midpoint every touchmove rather than a single fixed focal point per
gesture, so the anchor tracks live if the midpoint drifts mid-pinch), and
a pan can never drag the photo's edge past the frame's own edge, which
would show blank paper around a supposedly-full-bleed photo (`clamp`,
bounding the translate to `(renderedSize × scale − frameSize) / 2` per
axis, derived from the image's own untransformed `offsetWidth`/
`offsetHeight` rather than `getBoundingClientRect()` mid-transform, which
would have baked the current transform into the very measurement being
used to constrain it).

**Suppressing the resulting click.** A touch sequence that pinches or
drags would otherwise still end in the browser synthesizing a `click` —
which the nav zones underneath would read as "advance," right after a
pinch or a zoomed tap-to-reset that had nothing to do with navigating.
Each gesture-handling touch sequence is flagged (`state.zoomHandled`, set
the moment a second finger joins or the sequence starts already zoomed in)
and, only when that flag is set, `touchend` adds a one-time, capture-phase
`click` listener on the frame that stops the synthetic click from ever
reaching `stack`'s own bubble-phase click handler in browse.ts. An
ordinary tap on an unzoomed photo never sets the flag, so it's completely
untouched — confirmed with Playwright against a real production build:
`page.tap()` on a nav zone still advances exactly as before, on every page
that renders Browse.

**Resetting on navigation.** A photo staying zoomed in after a visitor has
moved on to the next one would be wrong regardless of how they left it —
tapping the opposite nav zone (which resets naturally, see above), the
keyboard (arrow keys, which don't touch zoom.ts at all), or Saved's
contact-sheet grid. Rather than hook every one of those exits individually,
`initZoom` runs its own `IntersectionObserver` over every `.browse-item` in
the stack and resets whichever frame's intersection ratio drops below 0.5
— this has to be a second observer rather than reusing browse.ts's own
(which only promotes a new "current" photo past the same threshold
`browse.ts` calls `CURRENT_MARK`, exactly the point this needs to already
have reset well ahead of).

**`touch-action: none` on `.browse-item-frame`.** Without it the browser's
own native pinch-zoom-the-whole-page gesture and this script's own handling
fight over the same touchmove events. `overflow: hidden` on the same rule
keeps a panned-in photo visually clipped to its own frame rather than
spilling into the caption below it.

**Rejected.** Mouse-driven zoom (scroll-wheel or click-drag) for desktop.
Nothing was asked for beyond mobile, and a mouse has no pinch gesture to
reuse this same conflict-free reasoning for — a scroll-wheel zoom would
need to fight the wheel listener browse.ts already uses for advancing, the
same conflict double-tap would have created on touch.

**Revisit if.** Desktop zoom is wanted later — scroll-wheel zoom while a
modifier key is held (Cmd/Ctrl, matching the OS-level pinch-zoom gesture's
own keyboard equivalent) would sidestep the existing wheel-to-advance
conflict without needing a threshold.

---

## 2026-08-24 — The site title opens a collections menu, replacing a separate corner mark

**Decision.** The bottom-left "Collections" corner mark added earlier the
same day (see the `/` redirect entry above) is gone. In its place, the
site title in Browse mode's top-left corner — `browse-home`, previously a
plain link to `/` — is now a `<button>` that opens a small fixed menu
right underneath it (`.browse-menu-list`), listing every collection from
the same `collections.ts` registry the collections homepage itself reads.
`collections-menu.ts` owns the open/close state: click the title to
toggle, click anywhere else (a photo, the caption, the paper margin) or
press Escape to close.

**Why.** Two separate marks were live at once for a few minutes of this
same session — a static "Collections" label at the bottom, and the site
title at the top still pointing at `/` (which, since the redirect above,
just reloads the page it's already on). Explicit user feedback: fold this
into the site title itself, "under my name." That reading makes sense on
its own terms too, not just as a preference — the site title is the one
piece of chrome already present on every Browse page and already legible
against any photo (the same `mix-blend-mode` treatment `.browse-home`
always had), so turning it into the menu's own trigger means one mark
doing one clear job, not two marks competing for the same corner's worth
of attention.

**Why a real panel, not another translucent corner mark — for the trigger
too, not just the list.** The existing corner marks (`browse-home`,
`browse-saved-link`) are single short words, legible via
`mix-blend-mode: difference` against whatever photo happens to be behind
them, white source colour, no background chip at all. The first pass here
kept that treatment for the trigger and only gave the panel a real
background — but direct user feedback caught what that missed: sitting
right above an opaque panel, the trigger's blend-mode white read as washed
out rather than deliberate, and the two pieces looked like an unrelated
mark plus a card underneath it, not one object. Both now share the same
frosted-paper chip — `color-mix(in srgb, var(--paper) 82%/92%, transparent)`
plus `backdrop-filter: blur(0.625rem)`, a hairline `var(--rule)` border,
`var(--ink)` text going to `var(--accent)` on hover/focus — the same
"a real panel over content, legible via tint and blur rather than
inversion" register the films page's own `.film-controls` already
established for a fixed panel that has to stay legible over whatever's
behind it (see the `min-width: 10rem` / `border-radius: 0.25rem` values
there, and its own `@supports not (backdrop-filter)` fallback, mirrored
here for both pieces). Confirmed legible with a screenshot against a real
dark, busy photo filling the frame edge-to-edge, not just the paper
margin most photos leave up there.

**Scope.** Only where `browse-home` renders as the site title — Selected
Work, tag pages, film-stock pages. `/photography/saved/` and
`/photography/share/` keep their existing `exitToGrid` button
("Saved"/"Back") in that corner unchanged; `collections-menu.ts` is a
no-op there (it just doesn't find `[data-collections-toggle]` in the DOM).

**Rejected.** Keeping the separate bottom-left mark alongside the new menu
— redundant once the site title itself does the same job, and two ways to
reach the same destination from the same page is exactly the kind of
chrome-for-chrome's-sake this project's design principles reject.

**Revisit if.** Saved or Share ever want the same menu — at that point
`exitToGrid`'s button and the collections-menu trigger need to coexist in
one corner, which today's implementation doesn't attempt (the trigger and
the exitToGrid button are the same DOM slot, mutually exclusive by
`Browse.astro`'s own `exitToGrid` prop branch).

---

## 2026-08-27 — The collections menu becomes a standing nameplate, not a dropdown; `collections-menu.ts` is deleted

**Decision.** This reverses the click-to-open panel from the 2026-08-24
entry above ("The site title opens a collections menu"). The site title in
Browse mode's top-left corner is now a plain, always-visible list — a
one-line title (`site.title`) over a thin rule, with every collection
listed underneath it, photography itself shown as inert text rather than a
link, everything else a plain `<a>`. There is no toggle, no open/closed
state, and no click-outside/Escape handling to own, so `collections-menu.ts`
is deleted outright rather than kept around unused.

**Why.** Explicit user request: a dropdown a visitor has to notice and
click before the other collections become visible was replaced with
something that's just always there. Once nothing opens or closes, the menu
needs no `<button>`, no `aria-expanded`, and no JavaScript at all — a
straight walk down `collections.ts`'s registry works with JS disabled the
same way every other link in Browse mode already does, satisfying
constraint 7 without the progressive-enhancement layer the dropdown
version needed.

**Why the frosted-paper chip from the 2026-08-24 entry was dropped along
with the dropdown.** That treatment was chosen specifically to make a
panel that appears for a moment on click read as one deliberate object
rather than a stray label. A fixture that's on screen for the entire visit
is a different problem: an opaque card sitting in the corner of every
photograph for the whole time someone reads the archive is exactly the
"chrome that isn't earned" this project's design principles reject.
`.browse-menu` now uses the same `mix-blend-mode: difference`, no-
background treatment as the plain corner marks (`browse-home`,
`browse-saved-link`) instead — legible over any photo without ever
painting over one, small-caps serif type reading like a museum wall label
(title, rule, list) rather than a floating word plus a card underneath it.

**Scope.** Unchanged from the entry above — only where `browse-home` used
to render as the site title (Selected Work, tag pages, film-stock pages).
`/photography/saved/` and `/photography/share/` keep their own
`exitToGrid` button in that corner, untouched.

**Revisit if.** The collections list grows past four or five entries —
a permanently visible list that long would start crowding the corner in a
way four short entries don't; at that point collapsing behind a click
again, or moving the list to the footer/nav instead, is worth another look.

---

## 2026-08-27 — `/` redirects for real in production, instead of serving Astro's meta-refresh flash page

**Decision.** `tools/serve/src/server.ts` now intercepts `pathname === '/'`
before falling through to static file serving, and answers with a real
`301` to `/photography/selected/` — the same target `astro.config.mjs`'s
`redirects` entry already names. `dist/index.html` (Astro's own generated
`<meta http-equiv="refresh">` page) is no longer read for a normal request
to `/` in production at all.

**Why.** A static build has no server at request time, so Astro's
`redirects` config can only ever produce a real page for `/` — one with its
own `<title>Redirecting to: /photography/selected/</title>` and a visible
`<a>` fallback link — that redirects itself via meta refresh once the
browser has already painted it. `tools/serve` is a real server, not a
generic static host, so it doesn't need that page for `/` at all: issuing
the redirect at the HTTP layer means a visitor's browser never paints
anything for `/` before landing on `/photography/selected/`, closing the
brief flash of the redirect page's own title/text that the meta-refresh
version was visibly showing first.

**What did not change.** `astro.config.mjs`'s `redirects` entry stays —
`astro dev` still needs it (a real redirect there too, since the dev
server itself is a server), and `dist/index.html` remains a correct
fallback for any static host that serves `site/dist/` directly instead of
through `tools/serve`. The two now duplicate the same
`'/photography/selected/'` literal in two files for two different runtimes,
the same kind of duplication the 2026-08-24 `/`-redirect entry already
accepted between `astro.config.mjs` and `collections.ts`.

**Revisit if.** A third runtime ever needs to know this redirect target
(a Cloudflare Worker in front of the tunnel, say) — at that point a single
source of truth (an env var, or a small shared JSON file) might be worth
it; today, two literals in two files each already tied to a comment
pointing at the other, is still cheaper than the indirection.

---

## 2026-08-28 — Base.astro's masthead grows a collections nav; the browse-menu fade during scroll is dropped

**Decision.** Three follow-ups from direct user feedback while using the
site, all scoped to navigation chrome.

First: `Base.astro`'s masthead — previously just the `wordmark` link to
`/` — now renders the _exact same nameplate_ Browse.astro floats over a
photo in browse mode: `<p class="browse-menu-title">{site.title}</p>`
followed by a `<ul class="browse-menu-list">` of every collection from
`collections.ts` (the current one an inert `browse-menu-current` span,
everything else a plain link), wrapped in a new `.masthead-nameplate`
div rather than `.browse-menu` itself. Reusing those classes verbatim —
not a parallel `masthead-collections` set, tried first and reverted the
same day — was itself a direct fix: an initial pass gave the masthead its
own separate horizontal, middot-separated nav, and direct user feedback
("the left side navigation should look the same on every page") caught
that it didn't actually match Browse's vertical title/rule/list nameplate
in shape, even once both sat in the same top-left corner. Sharing the
classes makes that drift structurally impossible going forward: any future
change to the nameplate's typography or spacing happens once, in
`.browse-menu-title`/`.browse-menu-list`/`.browse-menu-current`, and both
call sites pick it up. The old plain `wordmark` link to `/` is gone
entirely — Browse's own nameplate title was never a link either, just
inert text, and `.browse-menu-list` already lists Photography as a link
when it isn't the current page. This is the same registry `/collections/`
and the footer already read; the footer's own "All collections" link is
gone, since the masthead now does that job for every page this layout
renders. `Base.astro` stays collection-agnostic in the sense that matters
(no photography-specific logic; `pathname.startsWith('/${slug}/')` is
generic across every entry) — see "Why" below for why this doesn't
contradict that principle.

Second: `.masthead` is `position: sticky; top: 0;` instead of sitting in
normal flow only at the very top of the page. It still reserves its own
height in the document (no manual clearance padding needed, unlike a
`position: fixed` overlay would require) but now pins to the top of the
viewport once a page scrolls past it, with an explicit `background:
var(--paper)` so scrolled content doesn't show through. `z-index: 30`
keeps it above ordinary page content.

Third: `.browse-menu` (the fixed collections nameplate Browse.astro shows
over a photo, see the 2026-08-27 entry above) no longer fades out while the
stack is scrolling. `body.is-scrolling-browse` still fades `.browse-home`
and `.browse-saved-link` (unchanged), but `.browse-menu` was dropped from
that rule.

**Why the masthead change.** A visitor clicking a collection link from
photography's browse-mode nameplate landed on `/recipes/` (or `/films/`,
`/music/`) with no equivalent way back except the ambiguous wordmark
(links to `/`, which redirects to photography with no indication that's
where it goes) or scrolling all the way to a single footer link. The
nameplate's whole value — every collection, one click away, always visible
— evaporated the moment you left photography. Since `Base.astro` renders on
every non-browsing page (recipes, films, music, `/collections/`, and
photography pages before `is-browsing` hides the masthead), putting the
same list there closes that gap for every page at once instead of teaching
each collection's own pages about it individually.

**Why sticky, not the same `position: fixed` floating corner panel
`.browse-menu` uses.** Direct user feedback asked for the nav to "remain
consistent for all pages" — reachable no matter how far you've scrolled,
the same as browse mode's own nameplate, which never leaves the screen.
The two page types the nav appears on aren't equivalent enough to reuse
the identical technique, though: `.browse-menu` has no background at all
and relies on `mix-blend-mode: difference` for legibility, which works
because it only ever sits over a photograph (or the paper margin around
one) — the exact colours under it never carry meaning of their own. A
fixed, backgroundless overlay over an ordinary content page would sit on
top of real paragraph text, occluding whatever's underneath it rather than
just blending with it, the same problem `.film-controls` (see
`films.css`) already solved by going translucent instead of blend-mode for
its own fixed corner panel over a long scrolling grid. Sticky sidesteps
the whole problem: it reserves its own space in the flow (nothing to ever
cover), then pins itself once scrolled to, with a solid `var(--paper)`
background doing the same job `.film-controls`'s frosted one does, just
opaque since nothing needs to show through a header the way a poster does
through a corner panel.

**Why this isn't the same thing the 2026-08-27 entry rejected.** That entry
kept `Base.astro`'s masthead and footer completely hidden during browse
mode (full-bleed, chrome-free reading), which is unrelated to what the
masthead itself contains when it _is_ shown. Reading the same
collection-agnostic registry the footer link and `/collections/` already
depended on is not "learning about a specific collection" in the sense
`Base.astro`'s design principle means — no collection's slug, route shape,
or content is hardcoded; a fifth collection added to `collections.ts`
appears here for free, the same as it already does in the footer and
`/collections/` today.

**Why the browse-menu fade was dropped.** The 2026-08-27 entry's own fade
rule was there to avoid a `mix-blend-mode` seam artifact when the nameplate
straddles the gap between two horizontally-snapping slides mid-scroll.
Direct user feedback: the fade-out-then-back-in on every single
photo-to-photo advance read as flicker, not a subtle mid-scroll fix — worse
than the seam it was preventing. Scoped narrowly to `.browse-menu`, not
`.browse-home`/`.browse-saved-link`, since only the nameplate was called
out.

**Rejected.** Suppressing `masthead-collections` on `/collections/` itself
to avoid restating the page's own content — rejected for the same reason
`archive/index.astro` already shows both the masthead nav and
`PhotographyNav` at once: one wide-scope nav plus one narrow-scope nav (or
page body) at different altitudes isn't the kind of redundancy this
project's design principles reject; two links to the _same_ destination in
the _same_ corner (like the old dropdown-plus-corner-mark case) is.

**Revisit if.** The `.browse-menu` seam artifact this fade used to prevent
turns out to be visible often enough in practice to matter more than the
flicker it traded away — at that point a less jarring fix (a shorter fade,
or constraining the nameplate's fixed position so it can't ever land in a
slide gap) is worth another look before reinstating the blanket fade.

---

## 2026-08-28 — Browse mode's corner marks stop jumping sideways when you navigate into or out of it

**Decision.** `.browse-home`, `.browse-menu`, and `.browse-saved-link` no
longer sit at a flat `left: 1.5rem` / `right: 1.5rem`. They now use a new
`--wrap-inset` custom property: `max(1.5rem, calc((100vw - 76rem) / 2 +
1.5rem))`.

**Why.** Direct user feedback: clicking "Photography" from another
collection visibly moved the collections nameplate to the left. The cause
was two different coordinate systems for what was supposed to be one
fixed, unmoving mark. `.masthead-nameplate` (the previous entry) sits
inside `.wrap`, which is `max-width: 76rem; margin: 0 auto` — centered,
not flush against the viewport edge, on any viewport wider than 76rem plus
its own padding. Its content (and therefore the nameplate) starts at
`1.5rem` past `.wrap`'s own left edge, which itself is `(100vw - 76rem) /
2` in from the real viewport edge on a wide screen. `.browse-menu`, by
contrast, is `position: fixed; left: 1.5rem`, measured from the true
viewport edge with no knowledge of `.wrap` at all. On an ordinary
1440px-wide browser window those two values differ by roughly 90px; on a
1920px display, over 300px — small enough to miss while eyeballing a
narrow dev-tools viewport, obvious the moment someone actually clicked
between a normal page and browse mode on a real monitor. `--wrap-inset`
computes the exact same effective inset `.wrap`'s own layout already
produces (the `max()` reproduces `.wrap` filling the full viewport with
just its own padding once the viewport drops below 76rem, matching what
already happens on narrow/mobile viewports without any change needed
there), so a browse-mode corner mark now always lands exactly where the
masthead nameplate's content already sits, at any viewport width.

**Why fix Browse's corner marks rather than the masthead.** The masthead's
own positioning (in-flow inside `.wrap`, letting `.wrap`'s existing
centering do the work) can't easily be abandoned without reopening the
"a fixed overlay can't sit on top of real paragraph text" problem the
2026-08-28 sticky-masthead entry above was written to avoid — `.wrap`'s
centering is exactly what already keeps every page's content, this
nameplate included, inside one consistent reading column. Browse mode's
own marks have no such constraint (they float over full-bleed photos, not
paragraph text), so teaching them `.wrap`'s inset instead is the smaller,
more local change — one custom property, three call sites — rather than
restructuring how every other page lays out its content.

**Revisit if.** `.wrap`'s own `max-width`/padding values change — `
--wrap-inset` would need updating to match, since it's a deliberate,
commented duplicate of that arithmetic rather than something computed from
the same source (CSS has no way to read another rule's declared
`max-width` back out as a value).

---

## 2026-08-28 — Both nameplates go horizontal, reversing the 2026-08-27/28 vertical shape

**Decision.** `.browse-menu-title`/`.browse-menu-list`/`.browse-menu-current`
— the shared markup `.masthead-nameplate` (the sticky top bar on every
ordinary page) and `.browse-menu` (the fixed corner mark Browse mode
floats over a photo) both wrap — now lay title and list out horizontally
instead of stacking the list vertically underneath the title. The
masthead reads as a plain magazine masthead: site name on the left,
`collections.ts`'s list on the right, `justify-content: space-between`
across the full bar. `.browse-menu` gets the same shape in miniature: name
then collections in one row (wrapping onto a second row on a narrow
phone, since it's a fixed-position box with no background and needs to
stay inside the viewport rather than run off the edge). Colour treatment
still differs by context exactly as before — the masthead uses ordinary
ink/muted/accent with an underline-grows-on-hover, `.browse-menu` keeps
`mix-blend-mode: difference` and its own opacity-fade hover — only the
shared layout (flex row, gap, no per-item block row, no rule under the
title) moved to the shared base rules.

**Why.** Direct user feedback, in two parts. First: the masthead
specifically read as cramped and app-like stacked vertically in a
sticky bar that spans the whole page width — a horizontal bar reads
closer to the "independent magazine / creative director" register this
project's design principles ask for. Second, once the masthead went
horizontal, a follow-up request asked that Browse mode's corner mark
match it rather than staying the odd one out, on the explicit condition
that doing so cost the photograph nothing. It doesn't: a single line (or
two, wrapped, on a phone) is _shorter_ than the five-line vertical stack
(title, rule, four collection rows) it replaces, so the corner mark now
covers less of the photo than before, not more — the mix-blend-mode/
no-background treatment that keeps it from ever painting an opaque panel
over a picture is unchanged.

**Why this reverses 2026-08-27/28 rather than layering on top of them.**
Those two entries record an explicit prior instruction — "the left side
navigation should look the same on every page" — which is exactly what
this change still honours: both nameplates still share one set of base
classes, so a future typography or spacing tweak still happens once. What
changed is which shape the shared classes draw, not the principle that
they must be shared. Anyone re-reading 2026-08-27/28 alone would expect a
vertical list; this entry is the record that a later, direct request
moved the target shape to horizontal for both.

**Revisit if.** The collections list grows long enough that a horizontal
row wraps onto three or more lines even on a normal desktop width — at
that point the masthead may want to go back to a stacked or overflow-menu
shape, and `.browse-menu` would need to follow it down again for the same
reason it followed it up here.

---

## 2026-09-02 — One masthead, on screen everywhere, browse mode included

**Decision.** `.masthead` (Base.astro's sticky top bar) is no longer
hidden by `body.is-browsing`. It stays visible and — since `.browse` is a
fixed full-viewport overlay painted on top of everything else — now sits
above it in z-index (45 vs. `.browse`'s 40) so it keeps rendering as a
real, opaque, in-place header instead of being covered. `.browse` itself
no longer starts at the very top of the viewport (`inset: 0`); it now
starts a fixed distance below the masthead (`--masthead-h` +
`--browse-top`, both new root custom properties) so a photograph opens
with real margin under the header rather than its top edge sitting under
an opaque bar, or — the version tried first and rejected — a translucent
one it partially bled through. `Browse.astro`'s own floating nameplate
(`.browse-menu`, the mix-blend-mode "Randy Liang / collections" corner
mark it used to draw over a photo whenever the page had no `exitToGrid`
button) is removed entirely: `.masthead` now does that job everywhere, so
there is exactly one nameplate implementation left, not two kept in sync
by shared CSS classes. `.browse-home`/`.browse-saved-link`'s own top
offset moved from a flat `2rem` (calibrated to match where the hidden
masthead's nameplate used to sit) to `--browse-top` plus a matching inset,
since the thing they used to align with is now a real, visible header
rather than an absence.

**Why.** Direct user request: "the navbar is still broken... this at the
top on all pages in an identical fashion, that's it" — followed by a
photo of the intended masthead content. Browse mode's separate floating
nameplate was a second implementation of the same nav that could (and, per
the user, did) drift from the plain masthead every other page shows in
look and behaviour — a translucent, blend-mode-legible-over-any-photo
treatment is simply not the same navbar as an opaque one with a real
background and an underline hover, no matter how many CSS classes the two
share. One always-on-screen header removes the possibility of that drift
by construction. The user separately asked for "a more aesthetic margin"
under the photo, which is what `--browse-top`'s extra inset (beyond just
clearing the header) is for, and this is also what made `.browse-item`/
`.browse-intro`/`.browse-outro`'s hardcoded `height: 100vh`/`100dvh` (see
their own comment) need to change to `height: 100%` — they used to rely on
`.browse` itself being exactly the viewport height, which stopped being
true the moment `.browse` started below the header instead of at the very
top of it.

**Revisit if.** The rough below-masthead clearance this introduced for
`.browse-home`/`.browse-saved-link` (and `--masthead-h`'s own two-tier,
not-pixel-measured value) turns out wrong at some viewport width not
checked here — both are deliberately approximate, not JS-measured against
the header's real rendered height, on the understanding (also from the
user) that a further pass would polish the full-bleed browse layout once
the navbar itself was fixed.

---

## 2026-09-02 — The grid is back, as an explicit secondary view, not just a no-JS fallback

**Decision.** Every page that pairs a `.grid` with a `<Browse>` component
(tag pages, Selected Work, film-stock pages — not `/saved/`/`/share/`,
which already had their own version of this) now passes
`exitToGrid="Grid"` to `<Browse>`, and loads a new
`site/src/photography/grid-toggle.ts` alongside `browse.ts`. Reading
(Browse) is still what a JS-enabled visitor lands on by default — nothing
about the initial `document.body.classList.add('is-browsing')` inline
script on any of these pages changed. What's new is a way back and forth:
the "Grid" corner mark (the same `.browse-home` button `/saved/`/`/share/`
already use, just relabelled) clears `is-browsing` to reveal the grid that
was already rendering underneath it (as the no-JS fallback, now doing
double duty), and `grid-toggle.ts` intercepts a click on any grid tile to
call `browse.ts`'s existing `openPhoto(id)` instead of following its
plain `<a>` to the raw JPEG, re-entering Browse at that exact photograph.
Both halves of this were already fully built for `/saved/`/`/share/` (see
`saved-view.ts`/`share-view.ts`) — `grid-toggle.ts` is the same shape
without the subset-pruning step those two pages also need, not a new
mechanism.

**Why.** Direct user request — "we need to reintroduce the grid view... it
should be a secondary option" — after the masthead fix above made it
worth asking what the grid's own status was. It had quietly become
JS-invisible markup: real, tested, correct HTML that a browser only ever
painted with JavaScript disabled, per the "Browse mode is the only reading
experience now" comment `browse.ts` still carries. The user wants it back
as a real, reachable view, but explicitly secondary to reading — hence
reusing the exact affordance (`exitToGrid`, `.browse-home`) `/saved/`/
`/share/` already established, rather than making the grid a first
default state or adding a second, competing toggle mechanism.

**Revisit if.** A page wants to remember which view a visitor left it in
across a reload (`sessionStorage`, most likely) — today every fresh load
always starts in Browse, same as before this change; the toggle only
persists within a single page view, not across navigation.

---

## 2026-09-02 — Recipes and Music centre their content column instead of sitting flush left

**Decision.** `.recipe-scope` (recipes.css) and `.music-scope` (music.css)
— the outer wrapper both the index and (for recipes) the detail page
render everything into — now carry their own `max-width` (`--measure` for
recipes, `30rem` for music, matching `.music-list`'s own pre-existing cap,
which lost its now-redundant duplicate of that value) and
`margin-inline: auto`. Previously only the inner lists/prose
(`.recipe-index`, `.recipe-doc`, `.music-list`) capped their own width,
flush against `.wrap`'s left padding with nothing centring them — on any
viewport wider than roughly `2 × --measure`, that left a page that was
mostly empty space down its entire right half.

**Why.** Direct user request, made after the masthead fix above: "fix the
alignment for the other pages — consider the UX of switching pages and
the eye having to move to the left from the photography centred." The
concrete problem is exactly what it sounds like — Selected Work and every
tag view is a centred, full-bleed photograph, the strongest possible
"eyes on the middle of the screen" composition; landing on Recipes or
Music immediately after put the visitor's next fixation point (the page's
own title and content) hard against the left edge of a mostly-empty page,
the largest and most jarring position swap the layout could produce. This
is a deliberate trade, not a strict improvement in isolation: the
masthead above no longer shares a left edge with the H1 underneath it on
these two collections, since the header stays flush left everywhere
(`.wrap`'s own padding) while the content column now centres itself
within `.wrap` instead. Two fixed points — header always flush left,
article always centred — read as more intentional, and cost the eye less
across a page change, than one that's technically flush left everywhere
but leaves half the page empty on these two collections specifically.
Films and the collections/photography-archive pages weren't touched:
both already fill `.wrap` symmetrically with a multi-column grid, so they
had no flush-left/empty-space problem to begin with.

**Revisit if.** A collection's content column and the masthead above it
genuinely need to share a left edge again (a design pass decides the
trade above reads as broken rather than intentional) — the fix then is
either widening that column back toward `.wrap`'s own edge, or giving the
masthead itself a matching centred treatment, not reverting the centring
alone.

---

## 2026-10-06 — The Grid/Saved corner marks are opaque chips, not mix-blend-mode text

**Decision.** `.browse-home` and `.browse-saved-link` (base.css) no longer
render as bare text in `mix-blend-mode: difference` at `opacity: 0.5`. Both
are now a small opaque chip — the same frosted-paper treatment
`films.css`'s `.film-controls` panel already uses (`color-mix` paper tint,
`backdrop-filter: blur`, a hairline `--rule` border, a soft shadow), with
ordinary `--ink` text that goes `--accent` on hover/focus instead of fading
toward full opacity. The `@supports not (backdrop-filter)` fallback
`.film-controls` already needed is copied over for the same reason: a
browser without blur support still gets a readable, more-opaque solid
tint instead of a translucent chip with nothing softening the edge.

**Why.** Direct user request: landing on `/photography/selected/` (or any
tag/film-stock page), the first thing visible was the word "Grid" sitting
translucently on top of the hero photograph — "I shouldn't see 'Grid'
overlayed on top of the photo." The corner mark itself (reachability back
to the grid, per 2026-09-02's "The grid is back...") wasn't in question —
confirmed directly, the fix was to the mark's _presentation_: mix-blend-mode
text with no background reads as debris sitting on the image rather than a
control, especially as the very first thing a visitor sees before they've
had a chance to learn what it is. An opaque chip is legible against its own
background instead of depending on blending with whatever's in the photo
underneath, so it reads unambiguously as a button no matter which photo
it's sitting over. `.browse-saved-link` got the identical treatment in the
same pass — it's the same corner-mark pattern in the opposite corner (the
code already called them "same treatment" before this change), and leaving
one restyled while the other kept the old ghost-text look would have been
exactly the kind of two-implementations-that-can-drift the 2026-09-02
masthead decision was trying to eliminate elsewhere.

**Revisit if.** The chip's fixed position ever needs to adapt further for
very narrow viewports (it hasn't been tested below common phone widths with
a long `exitToGrid` label — today's labels are all short: "Grid", "Saved",
"Back").

---

## 2026-10-06 — Recipes and Music widen their centred column from --measure/30rem

**Decision.** `.recipe-scope`, `.recipe-index`, and `.recipe-doc`
(recipes.css) now cap at a fixed `46rem` instead of `var(--measure)`
(64ch). `.music-scope` (music.css) now caps at `38rem` instead of a flat
`30rem`.

**Why.** Direct user request — the recipes and music pages read as "way
too narrow margined" next to film (which fills `.wrap` symmetrically with
a grid and was left alone). The root cause wasn't the centring decision
from 2026-09-02 above, which stands: it was the specific widths chosen.
`--measure` is defined as `64ch`, but `ch` is keyed to Newsreader's own
glyph metrics, and resolves to roughly `34rem` in practice — under half of
`.wrap`'s `76rem` max-width, which read as a narrow column stranded in an
oversized page rather than a deliberate magazine column. Music's `30rem`
had the opposite reasoning problem: it was sized to exactly match a
Spotify embed's native width, technically precise but stark with nothing
else on the page to anchor it. Both moved to fixed `rem` values (so they
don't shift if the typeface's own metrics ever do) chosen to look
proportionate within `.wrap` at common desktop widths while staying well
short of hurting either prose readability (recipes) or embed
proportions (a 38rem-wide 16:9 YouTube embed lands at a reasonable
~337px tall). Neither change touches anything below roughly 49rem/41rem
respectively (column width plus `.wrap`'s own padding) — phones and most
tablets were already using the full available width and are unaffected.

**Revisit if.** A collection's column needs to track viewport width more
continuously than a single fixed breakpoint allows — a `clamp()` between
today's value and something narrower would be the next step, rather than
another flat number.

---

## 2026-10-06 — Recipes/Music widened a second time, to 58rem/44rem

**Decision.** `.recipe-scope`/`.recipe-index`/`.recipe-doc` move from
`46rem` to `58rem`; `.music-scope` moves from `38rem` to `44rem`.

**Why.** Direct, immediate follow-up to the entry above: the first widening
pass wasn't enough — "need to widen those margins" again, confirmed
against the same two collections rather than any other page (films and
photography were re-checked and genuinely have no equivalent narrow
column). No new reasoning beyond the entry above; this is the same
direction, taken further.

**Revisit if.** Same as above.

---

## 2026-10-06 — A roll is promoted to its own batch, same as the Paris split

**Decision.** `originals/liang/{4852,4853,4854}` (added this session, see
the batch-ingest entry above) is gone; each of its three rolls is now its
own top-level batch — `originals/4852/`, `originals/4853/`, `originals/4854/`
— the same shape `0827`–`0830` already use. `albums/liang/` and
`generated/albums/liang.json` no longer exist; `albums/4852/`,
`albums/4853/`, and `albums/4854/` replace them, each with its roll id as
`.` (a flat batch is roll `.`, per the film-roll model in `CLAUDE.md`).

**Why.** Direct user request — "they shouldn't be in /liang at all, move
the subdirs up to be level with the other rolls of film." The "liang"
grouping was never a meaningful trip/subject distinction, just this
session's convenient name for the whole transfer; three rolls that happen
to share no story beyond "came off the same card" don't need a shared
parent batch.

This hit the exact cross-batch sourceId limitation `CLAUDE.md` already
flags from the Paris split: identity-survives-a-move matching is scoped to
one batch slug's own previous manifest, so a plain `pnpm ingest` after the
move would have treated all 108 photographs as brand new — losing the
`liang` tag and the film stock already noted in `albums/liang/rolls.yaml`
minutes earlier. Rather than accept that loss (as the Paris split did, per
its own entry above), each new album's `photos.yaml`/`rolls.yaml` was
hand-written _before_ running ingest, with `sourceId`s and `tags` copied
over unchanged and `file` paths stripped of their old `4852/`-style roll
prefix (now redundant — the roll is the batch root). `pnpm ingest` then
matched every entry by `sourceId` and found nothing to add, remove, or
backfill, so it left all three files untouched; the move cost zero
re-encoding, too — `generated/derivatives/` is keyed by `sourceId`, which
never changed, so `pnpm publish:local` afterward uploaded 0 new files.

The `liang` tag itself was deliberately left as-is on all 108 photos,
not renamed to match the new batch names — tags are photographer-authored
and independent of batch naming (`CLAUDE.md`'s "Archive model"), and
nobody asked for a different tag, just a different directory shape.

**Revisit if.** The cross-batch sourceId-matching gap (item 4 in
`CLAUDE.md`'s "Immediate next priorities") ever gets built for real — at
that point this kind of restructuring wouldn't need a hand-written
`photos.yaml` detour at all, `pnpm ingest` could do it unassisted.

---

## 2026-10-06 — Browse mode is gone; the grid is always the page, a standard lightbox opens on click

**Decision.** This supersedes 3c38f72's "Browse becomes photography's only
reading experience" and every decision layered on top of it since (the
2026-08-24 pinch-zoom and mobile-frame entries, 2026-08-27's floating
nameplate, the 2026-08-28 trio tightening it, 2026-09-02's "masthead stays
on screen" and "the grid is back" entries). None of those decisions were
wrong given what they were solving at the time; this one changes what the
photo-viewing experience fundamentally is, so it replaces them rather than
adding another layer.

`Browse.astro`/`browse.ts`/`grid-toggle.ts` are deleted outright. In their
place: `Lightbox.astro` + `lightbox.ts`, a standard overlay — close
button, prev/next, a position counter, one photo at a time — that opens on
a grid-tile click and closes back to the exact same grid. There is no
mode to auto-enter on load, no "Grid" corner-mark button to switch back
and forth, no chapter intro panel (title/date/count — already shown in
the grid's own `.album-header`, which no longer ever hides) and no chapter
outro panel linking to the next album (redundant with the plain
`.next-album` link tag pages already render in the grid). The grid is
simply always the page, for every visitor, JavaScript or not — `lightbox.ts`
only intercepts a tile click to open the overlay instead of following the
link to the raw image.

Kept, carried over with no behavioural change: `#photo-<id>` +
`?photo=<id>` URL sync (`tools/serve/src/share-preview.ts` depends on the
exact `?photo=` convention for Open Graph previews — this is the one piece
that could not drift), deep-linking straight to a photo on load, the Save
button and its first-use hint (`saved.ts`, untouched), Selected Work's
per-load shuffle (now shuffling the lightbox's own photo order rather than
a scroll stack's), and pinch-to-zoom (`zoom.ts`, retargeted to the new
class names — `.lightbox-frame` instead of `.browse-item-frame` — and its
one piece of coupling to the old scroll-position tracking replaced with a
`MutationObserver` on `.is-active`, so it stays self-contained rather than
calling into `lightbox.ts`'s own navigation functions).

Saved and Share got simpler, not just ported: both lose their own
`exitToGrid`-driven "Back"/"Saved" corner button and Escape handler — that
existed only because leaving "browse mode" was a special case per page.
Every page now closes the lightbox the same way (×, Escape, or clicking
the backdrop), so that per-page logic was deleted rather than carried
forward.

One deliberate aesthetic call: the lightbox sits on a dark (ink-toned, not
pure black) scrim, a clean break from the mix-blend-mode-on-arbitrary-photo
trick the old corner marks needed (see the 2026-10-06 "opaque chips" entry
above, from earlier the same day — that fix was already heading this
direction before the whole mode was reconsidered). A uniform dark backdrop
makes mix-blend-mode unnecessary: plain light-on-dark colour is legible
against its own background regardless of which photo is open, which is
also why the lightbox's hover/focus state brightens toward white rather
than reaching for `--accent` (a dark oxblood red reads at roughly 1.7:1
contrast against a near-black scrim — nowhere near legible).

**Why.** Direct user request: "i need to improve the view of selected
photos vs grid - i think it's too messy as it stands... simplify it to be
more standard looking." Asked to confirm scope before touching anything
this established — the answer was the whole two-mode concept, not just
the grid's own styling: "the idea of two separate views for the same
photos (plus corner-mark toggles to switch) feels overbuilt. Simplify
toward one standard pattern — e.g. a plain grid that opens a
lightbox/viewer on click." That is exactly what this is: the pattern
essentially every photo site (Flickr, Google Photos, Unsplash, Apple
Photos) already uses, and it nets out as less code than what it replaced,
not an equivalent amount moved around.

**Revisit if.** A continuous, scroll-through reading experience turns out
to still be wanted for some specific context (a slideshow mode, say) —
that would be a new, clearly-scoped addition on top of the lightbox, not a
reason to resurrect Browse mode's machinery, which this decision treats as
gone for good.

---

## 2026-10-06 — The lightbox's open photo was rendering uncapped, not contained

**Decision.** `.lightbox-item` (base.css) gets an explicit `height: 100%`
on top of the `max-height: 100%` it already had.

**Why.** Direct user report, right after the lightbox shipped: "the
lightbox preview is bad i want it to be in the original aspect ratio" /
"don't stretch it out to fit the screen." The photo wasn't actually
distorted — it was uncapped. `max-height: 100%` only resolves against a
containing block with a _definite_ height; `.lightbox-item` had no height
of its own (just a max-height), so that percentage — and every
`max-height: 100%` further down the chain, including the `<img>`'s own —
computed to `none`. The image fell back to its natural intrinsic size
with only its width capped by `.lightbox-frame`'s (fully definite) width,
so a landscape photo rendered at full stage width with its height
following proportionally, often taller than the viewport. The old Browse
mode never hit this: `.browse-item` had a real `height: 100%`, inherited
from a `position: fixed` box with explicit `top`/`right`/`bottom`/`left`,
so every percentage down its chain was already definite. The lightbox's
`.lightbox-item` copied the `max-height` but not the `height` that made
it resolvable.

**Revisit if.** Never — this is a correctness fix, not a design choice to
reconsider.

---

## 2026-10-06 — A secret, unlinked `/photography/archives/` page

**Decision.** `site/src/pages/photography/archives/index.astro` — every
photograph in the collection (433, flat, not one cover per tag like
`/photography/archive/`), sorted newest-batch-first. Not in
`PhotographyNav`, not in `collections.ts`'s `urls()` (so `sitemap.xml.ts`
never lists it), the exact same "secret by omission" treatment
`/photography/archive/` already gets — confirmed directly rather than
built as a password-gated route like `/private`: a real page at a URL
nothing advertises, not actual authentication.

"Sort by date added" has no per-photo timestamp to sort by — nothing in
the manifest or `photos.yaml` records when a photo was added. `album.md`'s
`date:` field does, though, if accidentally: `pnpm ingest` scaffolds it
once, the moment a batch is first ingested, and never touches it again
(see `album-files.ts`), so it's a genuine, stable "date this batch was
added" record, just never meant to be read back as one. The page reads
each distinct batch's `album.md` directly (not through `archive.ts`) and
sorts by that, newest first, keeping each batch's own roll/frame order
within it — a one-off need for one secret page, not promoted into
`archive.ts`'s general API.

**Revisit if.** A second page wants the same "date added" sort — at that
point it's worth promoting into `archive.ts` properly instead of a second
copy of this file-reading code.

---

## 2026-10-16 — The masthead stops being sticky

**Decision.** `.masthead` in `base.css` is an ordinary in-flow header that
scrolls away with the page: `position: sticky`, `top`, `z-index`, and the
opaque background that sticky required are gone. `position: relative`
remains only to anchor the accent rule in `::after`. Direct user feedback:
a persistent bar felt unnatural on mobile (Safari and Brave on iOS) and
clipped photographs as they scrolled underneath it, which is exactly the
"chrome competing with the pictures" the site is meant to avoid.

This reverses 2026-08-28's "the collections nav needs to stay reachable"
call. Since the sticky header was always in normal flow, nothing else
(spacers, `padding-top`, `scroll-padding`) had been added to compensate,
so there was nothing else to remove. The lightbox is unaffected — it's a
`position: fixed` overlay at its own z-index. The films page's fixed
controls panel is unrelated page-specific UI, not the masthead, and stays.

**Revisit if.** Pages grow long enough that scrolling back to the top for
navigation becomes a real complaint — then a "back to top" link at the
foot of the page is the next step, not a return to a sticky bar.

---

## 2026-10-24 — Derivatives are served from where ingest writes them

**Decision.** `tools/serve` serves `/p/...` directly from
`generated/derivatives/`, and `astro dev`/`preview` do the same through a
few lines of Vite middleware in `site/astro.config.mjs`. `pnpm sync` is now
just `pnpm ingest`; the `publish:local` script is gone (the CLI's
`publish --local` remains for a generic static host).

**Why.** `site/public/p/` held a full copy of every derivative (5.9 GB),
and Astro copied all of it again into `site/dist/` on every build — three
copies of the same bytes, minutes per build, and, because Astro empties
`dist/` first while `tools/serve` keeps serving from it, the live site was
broken for the length of every deploy.

**Not a return of the symlink.** The symlink removed earlier in this project broke production
because a git-ignored path leaked into `dist/`. Here nothing reaches the
build output at all: the build never sees an image.

**Rejected.** R2 (the existing `pnpm run publish` path) — it works and
offloads bandwidth, but adds credentials and a second place images live
for a site served from one home machine. Still the next step if bandwidth
ever matters.

---

## 2026-10-24 — Rotation is a photos.yaml field, baked in at ingest

**Decision.** `rotate: 90|180|270` (clockwise) per photo in `photos.yaml`,
set from the editor (`[` / `]`). Ingest applies it on top of the EXIF
orientation and records the turn in each derivative's encode spec — only
when non-zero, so no existing key moved and only rotated photos re-encode.
The editor previews a pending turn in CSS, working out which turn is
already baked in by recomputing the Open Graph key for each candidate.

**Why.** Lab scans arrive with no orientation tag and are often sideways.

**Rejected.** Rotating the original file (or writing its EXIF orientation):
breaks "originals are immutable," gives the photo a new `sourceId`, and
needs a new dependency. Filebrowser has no image editing at all.

---

## 2026-10-24 — Masonry placement for the photography grid

**Decision.** `masonry.ts` positions each grid figure absolutely in the
shortest column. The CSS grid underneath is unchanged and is what a no-JS
visitor sees; column count is one custom property (`--grid-columns`).

**Rejected.** CSS `columns` (fills top-to-bottom, scrambling frame order and
Selected Work's sequence); native CSS masonry (not reliably shipped); a grid
of 1px rows with spans (a 500-photo page needs tens of thousands of implicit
rows, past browser limits); a layout library (unneeded for ~60 lines).

---

## 2026-10-24 — "Date added" means first committed to the repository

**Decision.** `batchAddedDates()` reads, from git at build time, when each
batch's manifest was first added. Selected Work gains a "Date added" toggle
(oldest first — a progression), and `/exposures/archives/` uses the same
helper newest-first, replacing its own read of `album.md`'s `date:` (which
is scaffolded from EXIF, i.e. when the photo was taken, not added).
Uncommitted batches count as newest; without git, order falls back to
archival order.

---

## 2026-10-24 — WebP is no longer encoded; ingest uses every core

**Decision.** `planVariants` produces AVIF (five widths) plus the two JPEGs
and nothing else; `webp` stays a valid manifest format so older manifests
still load. `defaultConcurrency()` is every core, not half.

**Why.** Ingest was the slow step for each new lab delivery (~2.7 minutes of
encoding per scan). Every current browser decodes AVIF, and anything that
doesn't falls back to the JPEG `<img>` — the five WebP files per photograph
were almost never served. And at half the cores, measured on this 12-core
machine, the load sat around 4: sharp's own pool is pinned to one thread,
so photographs in flight are the only parallelism there is. Neither change
touches quality: the AVIF and JPEG recipes, and therefore their keys, are
unchanged.

**How the switch costs nothing.** A previous record that covers every
planned key now counts as reusable even if it lists extra variants
(`reusableVariants`), so the first ingest after this rewrites every
manifest without WebP entries and without decoding a single original.

**Rejected.** Lowering AVIF effort: faster encodes at the same quality
setting but larger files, and it would change every AVIF key, forcing a
full re-encode that costs more time than it saves.

---

## 2026-10-24 — The lightbox is gesture-driven on touch screens

**Decision.** On a coarse pointer, `swipe.ts` makes the photo itself the
control: drag left/right to move between photographs (the neighbour slides
in beside it; release past a fifth of the width, or flick, to commit),
drag down to close (the scrim fades with it). The arrow buttons are hidden
there, a tap on the scrim no longer closes, and the overlay takes every
touch (`touch-action: none`, `overscroll-behavior: contain`) so nothing
behind it scrolls or pulls to refresh. Pinch-zoom (`zoom.ts`) is
untouched; swipes are ignored while a photo is zoomed. Desktop keeps its
arrows, keys, and click-the-scrim-to-close.

**Why.** On a phone, a stray tap beside a photograph dropped you back on
the grid, and the small arrow buttons were the only way forward.

**Rejected.** A carousel library — one ~200-line module covers it, with no
dependency and full control over how it feels.

---

## 2026-10-24 — Selected Work opens shuffled; the "Date added" toggle is gone

**Decision.** Selected Work deals a fresh random order on every visit (the
editorial `featuredOrder` sequence remains the no-JS fallback), Shuffle
deals another, and the "Date added" toggle is removed. `batchAddedDates()`
and album.md's `added:` override stay, used only by `/exposures/archives/`.

**Why.** Commit dates only go back to the repository's creation
(2026-07-28), so the first week's batches all bunched together and the
order never matched when the work was actually made. A random order on
every visit serves the same goal — the whole body of work, not just the
first screen — without claiming a chronology it can't back up.

---

## 2026-10-24 — Ingest caches each original's hash by size and mtime

**Decision.** `generated/source-hashes.json` (git-ignored) holds each
original's SHA-256 with the size and mtime it was computed at; an
unchanged file reuses it. A nothing-changed ingest — every `pnpm deploy` —
drops from ~45s (19 GB of TIFFs re-read) to ~1s, with byte-identical
output. A changed size or mtime always rehashes; deleting the file forces
a full rehash.

---

## 2026-10-24 — Films update from a dropped Letterboxd export

**Decision.** Drop Letterboxd's `ratings.csv` into `films/inbox/`
(git-ignored); `pnpm films:import` — run by `pnpm sync`, so by every
deploy — keeps the five-star rows, rewrites `films/five-star-ratings.csv`
in exactly the format it was hand-trimmed to (a test round-trips the
committed file byte for byte), and runs the TMDB lookup for new films only.
A file without the ratings columns is refused rather than half-imported.

**Why in sync, though it touches the network.** The TMDB step is the
same opt-in enrichment as `pnpm films:posters`, in its own workspace, and
never fails the import: no token or no network just leaves new films
without a poster until the next run. `pnpm ingest` itself stays offline.

---

## 2026-10-24 — Films read Letterboxd's ratings.csv as-is (supersedes the inbox, same day)

**Decision.** `films/ratings.csv` is Letterboxd's ratings export, committed
exactly as downloaded, and the site reads it directly. Updating `/pictures/`
is: replace that file, deploy. `pnpm sync` runs `pnpm films:posters`, which
only looks up films not already in `films/tmdb.json` and skips with a
warning when no TMDB token is set. The inbox and `films:import` from the
entry above are removed before ever shipping.

**Why.** Every rating given is five stars, so there is nothing to trim —
the export already _is_ the five-star list, and an import step that
rewrote it into a second file was machinery with no job.

---

## 2026-10-24 — A shared photo link previews as the photograph, uncropped

**Decision.** For `?photo=<id>` (and the first photo of a `?s=` share),
`tools/serve` now points `og:image` at the photo's own 1200px JPEG variant,
at its real proportions, instead of the 1200×630 `fit: cover` crop.
iMessage, Slack and the rest show the whole frame — a portrait stays
portrait. The crop remains the fallback for a photo without a JPEG, and
the default card for pages that aren't one photograph.

---

## 2026-10-24 — Every photo page opens in a random order; date-added is gone

**Decision.** Tag, film-stock, Archives, Saved and Share pages deal their
grid into a fresh random order on each load (`shuffle-on-load.ts`), as
Selected Work already did; the lightbox follows that order. The server
still renders archival order, the no-JS fallback. With Archives no longer
newest-first, `batchAddedDates()`, `byDateAdded()` and album.md's `added:`
had no caller and are removed.

---

## 2026-10-24 — Saved gets selection and an explicit share step

**Decision.** Save marks on every grid photograph (`grid-save.ts`: hover/
focus on pointer devices, only a ✓ on saved photos on touch) plus `S` in
the lightbox. The Saved page gains a selection mode (tiles become
checkboxes — click, Enter or Space; "N of M selected"; Share N, disabled at
0; Esc/Done exits) and Share all. Sharing opens an inline panel with the
link in a selectable box, Copy (with feedback), the system share sheet
where `navigator.share` exists, and Open — the link is always visible, so
a blocked clipboard is never a dead end. Clear confirms first. The shared
page gets a heading, a count, a note for ids no longer in the archive, a
message (and no photographs) for a link that resolves to nothing — before,
an empty or mangled link showed the whole archive under its error — and a
way on into Exposures.

**How links persist.** Unchanged: the ids are encoded in the URL itself.
No database, no accounts, nothing to expire; a link is as permanent as the
photographs it names. The cost is length (~11 characters per photograph)
and that a link can't be edited after it's sent — a new selection is a new
link. Sharing never writes to Saved.

**Rejected.** Server-stored short links (a database and an API on a site
that has neither); a modal dialog for the share step (an inline, ruled
panel fits the page and keeps the grid in view).

---

## 2026-10-24 — Share links carry 4-byte id prefixes

**Decision.** New share links are `?p=` with each photograph's first 4
bytes of `sourceId` — an abbreviated hash, as Git abbreviates commits —
about 5.3 characters per photo instead of 10.7. A prefix resolves to the
one photograph it starts; none or several resolve to nothing.
`share-code.test.ts` fails the build if two current photographs ever share
a prefix (no collisions at 532; ~1% chance of any at 10,000). Old `?s=`
links (full ids) still decode, on the page and in `tools/serve`'s previews.

**Rejected.** 3-byte prefixes (4 characters, but an 11% chance of a clash
by 2,000 photos); numbering photographs by position in a committed,
append-only list (~2.7 characters each, but a registry file the pipeline
must maintain forever, and a link that silently changes meaning if it's
ever reordered).

---

## 2026-10-25 — Only featured photographs are public

**Decision.** `loadArchive()` now returns only photographs marked
`featured: true`; `loadFullArchive()` returns all of them and is read by
`/exposures/archives/` alone (and by `share-code.test.ts`, so the prefix
check covers every photograph). Tag pages, film-stock pages, the tag index,
Saved, Share and collections.ts's counts and sitemap URLs all see the
featured subset, so a tag or film stock with no featured photograph has no
page. Filtering in the loader rather than per page makes a new page private
by default. Saved and Share are filtered too, because they render the whole
archive into the HTML and prune it in the browser; left unfiltered they
would ship every photograph. So a photo saved from `/archives/` is pruned
from Saved, and a share link naming an unfeatured photo counts it as
missing. Derivatives under `/p/` stay reachable by hash, as before.

**Rejected.** Filtering in each page (easy to forget on the next page); a
separate `public`/`hidden` flag (starring already says what is shown).

---

## 2026-10-25 — Tunes is a wall of stills; dates are set in spaced capitals

**Decision.** Tunes stops being a dated log of full-size players and becomes
a collection: a two-column grid (one column under 44rem) of 16:9 YouTube
stills, each with its title and artist beneath it, divided into rows by
hairlines that break at the gutter. No dates, notes or numbering on an
entry. `tracks.yaml` entries carry explicit `title` and `artist` instead of
a free-text `note` (a missing title stops the build); `postedAt` stays,
unshown, and orders the page newest first, later in the file first on the
same day. Clicking a still opens one shared native `<dialog>`, which
creates the YouTube iframe on open and removes it on close: no player
loads until asked for, and closing is what stops playback. Without
JavaScript every still is a plain link to the video.

Stills are `maxresdefault.jpg` (1280×720, no letterbox). Not every upload
has one, and YouTube answers with a 120×90 placeholder rather than
reliably erroring, so `tunes.ts` steps down through `hq720`, `sddefault`
and `hqdefault` (4:3 with bars, which `object-fit: cover` crops away) on an
error or a too-small load. Without JS a missing maxres shows that grey
placeholder, which is accepted: every current entry has one. Every player
shows a "Watch on YouTube ↗" link, because a video whose owner disabled
embedding shows YouTube's own error inside the iframe and the page cannot
detect it without loading YouTube's iframe API on every visit.

Dates everywhere are `27 August 2025` (`photography/date.ts`) in
`.dateline`: uppercase by CSS (so a screen reader hears words), 0.75rem,
0.1em tracking, muted, lining figures, the one exception to `.eyebrow`'s
small caps. Today only Exposures' tag page and tag index show a date, and
only for photos carrying EXIF dates, which no current scan does.

**Rejected.** Keeping the large embeds (seven players loading at once, each
a full YouTube page); a lite-youtube-style library (a dependency for one
`<dialog>`); fetching thumbnail availability or titles at build time (the
build stays offline; titles are two hand-written fields); a free-text
`note` split on " - " (guessing which half is the artist); continuous rules
across the gutter (they read as a table rather than columns on a page).

---

## 2026-10-25 — Tunes opens into a screening room

**Decision.** A still on Tunes no longer opens a modal; it grows into a
full-screen dark room (`tunes.ts`, `music.css`). The grid is untouched and
stays paper and ink — the room exists only once someone asks to watch.
Pieces, and why each is the plain version:

- **Viewer, not `<dialog>`.** A fixed `role="dialog"` element moved to
  `<body>`, with `.wrap` made `inert` behind it. `showModal()`'s top layer
  sits awkwardly with View Transitions; `inert` gives the same focus
  containment. Escape, ← / → (only while focus is outside the iframe —
  inside it, YouTube's own seek keys win), focus to the back control on
  open and back to the originating still on close, scroll position
  restored, `html` overflow locked while open.
- **The transition is the still itself.** A same-document View Transition
  names the clicked `.tune-still` and the viewer's screen `tune-screen`;
  the screen shows the grid's own (cached) image as a poster until the
  iframe loads and fades in over it, so the morph is one picture changing
  size, never a black box. The caption rises in just after. Closing
  shrinks back into the song now playing if it's on screen where the
  visitor left, otherwise the room fades. Steps crossfade the screen and
  slide the caption a few pixels the way the visitor is going. No View
  Transitions, or `prefers-reduced-motion`: everything is instant.
- **Ambient light from the still, in the browser.** i.ytimg.com sends
  `Access-Control-Allow-Origin: *`, so a CORS-mode copy of the 320×180
  `mqdefault` is drawn to a 32×18 canvas and `palette.ts` (pure, tested)
  picks three dominant colours, ignoring letterbox black and title-card
  white and weighting saturated pixels, then holds them at ≤55%
  saturation and 18–38% lightness. They light three radial gradients
  (no blur filter) through `@property`-registered colours, so a change of
  song fades the light over 1.2s. Any failure falls back to the site's own
  dimmed browns. Cached per video; neighbours prefetched. The iframe's
  pixels are never read.
- **Embedding-disabled videos via oEmbed.** One small CORS request per
  video opened: 400/401/403/404 means it can't play here, and the screen
  shows the still with "This one plays only on YouTube" and a link. The
  IFrame Player API would say the same through `onError` at the cost of a
  third-party script on every visit; nothing else it offers is needed.
  A "YouTube ↗" link is in the room's top bar regardless.
- **No autoplay of the next song.** A step is a click, so the new video
  starts; reaching the end of one does nothing.

**Rejected.** A blurred, scaled copy of the thumbnail as the background
(it's YouTube's own "ambient mode" look, and a large blur filter is the
expensive way to get softness gradients give for free); build-time
palette extraction (a network step in the build, for colours the browser
can read in a millisecond); the IFrame Player API; an animation library;
`viewport-fit=cover` site-wide just for safe-area insets (it would put
every other page under a phone's notch — the room uses `env()` with
fallbacks, which simply resolve to the fallbacks without it).

---

## 2026-10-25 — Pictures: Pick for me, and posters that arrive and glide

**Decision.** The film controls gain "Pick [n] for me" beside Shuffle:
n films drawn from what the page is showing (the genre filter sets the
pool), uniformly and without replacement (`films/pick.ts`, a partial
Fisher–Yates; tested for equal odds). Input is forgiving rather than
validated: empty or unreadable is 1, past either end is held to it, and
asking for more than there are picks all of them and says so in the
status line. The form is `novalidate` because the browser's own min/max
check would otherwise swallow exactly those cases. Picks are marked
where they stand — no card moves: a warm mat (the frame's `--rule` mixed
toward the accent), a hairline outside it, and a "Picked · 2 of 5" line
in words, so colour is never the only signal. For 2.6s the rest of the
wall dims to 60%, then returns. A short numbered list of titles sits on
its own row above the controls, each a jump to its poster; picks follow
their cards through Shuffle and the filter (a filtered-out pick stays
picked, its jump disabled). Each card's `id` is its Letterboxd short code
(`filmId`, tested unique).

Shuffle keeps its meaning — reorder everything — and Pick never reorders,
so the two don't overlap; a single combined control was considered and
rejected because "show me everything differently" and "choose for me" are
different requests.

Motion (`films/motion.ts`): only posters on screen ever animate. On load
they rise 8px and fade in over 360ms with a 14ms stagger capped at 12, so
a screenful lands in about half a second; an inline script hides cards
only while the HTML is parsing and animates the visible ones before
first paint, then lifts the hiding (a `finally`, so a failure can't leave
posters invisible). The page heading opts out of the site-wide header
reveal so the type is there at once. Shuffle is FLIP limited to the
viewport: the deal and scroll are instant, then a poster that was on
screen glides 420ms from where it was, and one that wasn't settles in
like arrival. A click mid-animation measures where cards visibly are,
cancels, and starts from there. Reduced motion, or no Web Animations
API: everything instant.

**Rejected.** Animating every card (775 animations for a dozen visible);
a smooth scroll under moving posters (two motions at once); duplicating
posters in a results panel; dimming that persists (it hides the
collection the picks came from); the browser's own number-field
validation.

---

## 2026-10-25 — Pick for me: the gallery is the result

**Decision.** Replaces the picks list from earlier today. There is no
results panel: while picks exist, every other film sits at 25% opacity
(a 300ms transition, none under reduced motion) until Clear — a button
that appears inline after "for me" — or the next pick, which hands the
light from the old set to the new in one frame. Picks keep full opacity,
the warm mat (the outline is gone) and their words: "Picked for you", or
"Picked · 2 of 4 · next ↓" numbered in page order, the jump being how
picks a long scroll apart stay findable. The first pick is centred; a
scroll of more than 2.5 screens is instant rather than smooth (a smooth
scroll across 775 films takes seconds). Shuffle renumbers the marks; a
genre that hides every pick clears them and says so; motion.ts's settle
animation now lands on a card's resting opacity, so a dimmed film doesn't
flash to full and snap back.

**Rejected.** The list of titles (it repeated what the posters say);
dimming that lifts after a moment (the picks then had to be found again).

---

## 2026-10-25 — Pick for me picks one, two or three; Shuffle clears picks

**Decision.** The open-ended number field is gone. "Pick for me" is the
whole button and picks one film; three muted oldstyle numerals after it
(`1 2 3`, real radios — arrow keys move between them, Enter on one picks)
offer two or three, with the chosen one in ink over a hairline. Shuffle
is for browsing and Pick for me for deciding, so Shuffle now clears any
picks — caught in the capture phase, before the page's own Shuffle
listener, and without the fade, so motion.ts settles every card towards
full opacity rather than towards the 25% being lifted. Spotlight, scroll,
genre pool and Clear are unchanged; `pick.ts` still clamps to the pool
(a genre with two films and "3" picks both).

**Rejected.** A select for the count (a dropdown for three choices is
more control than the choice); keeping picks lit through a Shuffle (it
mixed browsing and deciding back together).

---

## 2026-10-25 — Saved is a cart in the masthead

**Decision.** The "Saved 15" link above the Exposures heading
(`PhotographyNav.astro`, now deleted — Saved was its only link) becomes an
outline shopping cart at the far end of the site-wide masthead, after the
collections and set off by a hairline (`photography/SavedCart.astro`). A
cart because everyone reads it as "the things I've picked out", on a site
where nothing is for sale; the destination is still called Saved, with no
prices or checkout. The count is a small raised figure in the nav's own
numerals, absent at zero, written by the same `syncSavedUI` as every save
control and now also on a `storage` event, so another tab's saves show up
too; the link's accessible name carries it ("Saved, 15 photographs").
Muted at rest, ink on the Saved page, the accent on hover, with no
underline. On a phone it sits opposite the site title rather than
trailing onto a line of its own. This is the one deliberate exception to
`Base.astro` knowing nothing about a collection (CLAUDE.md says so); the
component itself lives in `photography/`. With the nav gone, every
Exposures heading starts at the same height as Dishes, Tunes and Pictures.

**Rejected.** A bubble badge (colour and weight the masthead never uses);
a bag or bookmark icon (the joke is the cart); keeping a per-collection
nav row for one link.

---

## 2026-10-25 — Slashless page URLs redirect to the slashed ones

**Decision.** Production (`tools/serve`) answered `/exposures` with a 404:
Astro builds every page as `<path>/index.html` with `trailingSlash:
'always'`, and the server only mapped `/x/` to `x/index.html`. Now
`canonicalPagePath` returns a 301 to `<path>/` (query string kept; the
browser carries a `#fragment` across by itself) when — and only when —
`dist/<path>/index.html` exists, and `/x/index.html` 301s to `/x/` instead of
serving a duplicate. Files, `/p/` derivatives, `/private` and paths with no
page behind them are untouched, so a typo still 404s directly. Old-name
redirects (`/recipes/<slug>` …) resolve through the same function and land
on the canonical URL in one hop. Internal links were already canonical.

**Rejected.** A client-side fix (the server would still 404 first);
redirecting every slashless path (bounces typos and files); Cloudflare
redirect rules (configuration outside the repository, for a fix the
server can make itself).

---

## 2026-10-25 — Audit fixes: Pictures spacing, nameless photo links, dev-server file exposure

**Decision.** Four small fixes from the quality audit, each measured:

- **Pictures' first year heading** sat 86px under the subtitle with
  JavaScript on and 56px without: Shuffle inserts its hidden
  `.film-shuffled` section on load, after which `.film-year-group:first-of-type`
  no longer matched and the between-years margin replaced the header's.
  The selector now also matches `.film-shuffled + .film-year-group`: 56px
  either way, the same as Dishes, and the page no longer shifts as the
  script runs (CLS 0.075 → 0.006 desktop, lab).
- **Photo links had no accessible name** — every grid tile is a link
  around an image whose alt text is (still) empty, 251 on Exposures alone.
  `Photo.astro` now names the link by the caption, or "View photograph",
  whenever alt is empty; real alt text remains the actual fix.
- **Pick for me's 1 2 3** were 20px targets touching each other (WCAG 2.2
  2.5.8); each is now at least 24px square.
- **`astro dev --host` served `private/notes.yaml` and full-resolution
  `originals/` over `/@fs/`** to anyone on the LAN or tailnet, because
  Vite's default `server.fs.allow` is the whole pnpm workspace. It now
  allows only `site/` and `node_modules/` and denies `private/` and
  `originals/` outright. Takes effect when the dev server restarts.

First-row Pictures posters now load eagerly, the very first and the
first Tunes still at high fetch priority.

**Rejected.** `content-visibility: auto` on Pictures' year sections: it cut
desktop DOMContentLoaded from 308ms to 123ms and the throttled-mobile LCP by
~0.3s, but off-screen years are estimated in size until rendered, so the
Year jump landed 14,000px short and a reload on `#year-2025` 1,485px short.
Correct navigation outranks a lab-measured third of a second.

---

## 2026-10-25 — Rate-limited /private; releases built beside the live site

**Decision.** `/private/login` allows five failures per visitor in fifteen
minutes, then answers 429 with `Retry-After` — right password or not, or
the lock only costs a guesser one request. A visitor is Cloudflare's
`CF-Connecting-IP`, believed only on a loopback connection (how the tunnel
arrives); anything connecting directly over the LAN or tailnet is its own
socket address, so it can't pick a fresh bucket per guess. Per visitor
only: a global lock would let one attacker lock out the owner.

`pnpm deploy` (deploy/deploy.sh) builds into `site/dist.next/` beside the
live release, proves it on a candidate server (`:4398`, `--dist=`) with the
same checks production gets — `/healthz`, the real Exposures page, a real
photograph, a list of films — then switches with two renames, keeping the
old release as `dist.prev` for `pnpm rollback`. The server reads
`site/dist` per request, so a content deploy has no restart and no
downtime; it restarts only when a hash of `tools/serve`'s code changed. A
failed production check rolls back automatically. The tunnel unit moves
from `Requires=` to `Wants=` (a server restart no longer drops it) and
gains `--no-autoupdate`; a once-a-minute watchdog (as randy, via the
existing sudoers rule) restarts the server only after three consecutive
failed local checks, logging diagnostics first, and never acts on a public
failure. `.env` is now mode 600.

**Rejected.** A symlinked `current` release (CLAUDE.md invariant 5 keeps
symlinks out of what the build and server read; two renames are as good);
blue-green with a second server and a port switch in cloudflared (true zero
downtime for server-code changes, at the cost of a tunnel reconfiguration
per deploy — a one-second restart is the honest trade for this site);
running the watchdog as root (it would execute a script randy can edit);
Docker or a reverse proxy (systemd already supervises both processes).

---

## 2026-10-25 — The lightbox is three reusable slots fed by JSON

**Decision.** Every photo page used to render each photograph twice: its
grid tile, and a full hidden `<figure>` in the lightbox. Now the lightbox
is three slots — the photograph on screen and the one either side, which
swipe.ts slides in during a drag — filled from an inline JSON list built by
`lightbox-data.ts` with the same srcset helpers and width cap Photo.astro
uses. Stepping forward reassigns roles by photograph (the slot already
holding the preloaded next photo becomes current) and refills only the
spare, so the photo on screen never reloads. zoom.ts also resets when a
slot is given a different photograph, not only when it stops being active.
Saved and Share stop pruning hidden markup and call `setLightboxOrder`.

Measured against the old build, both served by tools/serve at 4× CPU
throttle, three runs each: Exposures 4,320 → 1,622 elements and
DOMContentLoaded 2.62 → 2.21s; Archives 9,032 → 3,295 elements and
4.56 → 3.77s. Verified identical against the live old lightbox in
Chromium: order through a shuffled grid and Selected Work's filter, wrap
both ways, `#photo-` deep links, Enter/Escape focus, the next photo already
loaded when shown, S to save, the once-only hint, one- and two-photo share
links, swipe left/right/back/down, pinch-zoom reset on step and on reopen,
and a pixel comparison at 1440 and 390px (differences only in the shuffled
grid behind the scrim).

**Rejected.** A single slot (swipe needs the neighbour in the DOM to slide
it in); `<template>` per photograph (the parse cost — the actual problem —
stays); building the lightbox from the grid tile's own markup (tiles carry
only srcsets up to 1280px, the viewer needs 2560).

**Also learned.** `astro preview` never served `/p/` images — the
derivative middleware's `configurePreviewServer` hook doesn't run — so
earlier local measurements of photo pages ran with every image 404ing.
Measure photo pages through `node tools/serve/src/cli.ts --dist=…`.

---

## 2026-10-25 — Pick for me picks exactly one

**Decision.** The 1 2 3 choice and Clear are gone: Pick for me lights one
film, centred, and pressing it again picks another; Shuffle or Escape
restores the wall. With several picks the page could only scroll to the
first — the others sat thousands of pixels away behind a small "next ↓"
link — so asking for three looked like getting one. The count parsing and
the next-pick jumps went with it.

---

## 2026-10-25 — Faster photo pages: right-sized thumbnails, the deal before first paint, prefetch on intent, revalidated HTML

**Measured first** (Lighthouse 12.6 on the live site, cold): Exposures on
mobile scored 54 with an 8.0s LCP and 5.3 MB over 96 requests; desktop
pulled 6.5 MB. Two causes. Every grid tile downloaded the 640px AVIF — the
smallest width the pipeline made — into a tile at most 280 CSS px wide
(Lighthouse: 3–4 MB avoidable), and `sizes` claimed 11vw for a ~20vw tile.
And the LCP element was a `loading="lazy"` tile: the server gave the first
tile high priority, then the deferred shuffle moved it somewhere random.

**Decision.**

- `pipeline.config.ts` adds 320 and 480 widths (landscape medians 15.5 KB
  and 33 KB, against 58 KB at 640). Same quality setting; a browser only
  picks one that still covers the tile at its own pixel density, so
  Retina screens and phones keep 640+. `GRID_SIZES` (image.ts) states the
  tile's real width, from base.css's grid.
- `GridDeal.astro`, inline after each shuffled grid, deals the tiles
  before the first layout and makes the first row eager, the first tile
  high priority — the photographs actually on top. No server-side
  priority on those pages any more; no-JS keeps archival order.
- A speculation-rules block prefetches a same-site page after ~200 ms of
  hover (or on press), excluding `/p/` (grid tiles link to 2560px
  JPEGs) and `/private`. Prefetch, not prerender.
- tools/serve sends pages with `no-cache` plus a weak ETag and
  Last-Modified and answers 304 when unchanged; everything under
  `/private` is `private, no-store`.

**Rejected or deferred.** A service worker or client-side router (the
pages are static and small; revalidation plus prefetch gets most of the
benefit). Prerender (runs a fresh shuffle off-screen). Edge-caching HTML
at Cloudflare (needs dashboard cache rules and purge-on-deploy; a
separate decision). Pictures' layout cost (775 cards; content-visibility
was rejected earlier for breaking the year jump) and Cloudflare's
injected Web Analytics beacon (~1 s of main thread on a throttled phone)
are left as decisions.

---

## 2026-10-25 — Second performance pass: layout before first paint, the first screen first

**Measured.** After the first pass, Lighthouse showed the shuffled pages
shifting (CLS 0.141 on Exposures, 0.108 on a tag page): masonry, a
deferred module, moved tiles after the photos had painted. A real-network
test on production (390×844 @3×, 1.6 Mbps, 150 ms, 4× CPU, median of five)
then showed the real bottleneck on phones: every visible photo took
11.2 s on Exposures and 8.9 s on a tag page, because Chrome lazy-loads
~2500 px ahead on slow connections and ~40 off-screen photos split the
bandwidth with the ~9 on screen. Priority hints alone don't stop that.

**Decision.** `grid-layout.js`, inlined after each grid by
`GridLayout.astro` (replacing masonry.ts and GridDeal.astro): deal (where
the page shuffles), place every tile, then load the tiles that landed in
the first viewport at high priority and hold the rest until those arrive
(or 4 s), after which they load one screen ahead; a tile scrolled into
view loads at once. Production now serves `site/release`, written only by
`pnpm deploy`, after two plain `pnpm build`s put unchecked builds live.

**Result** (production, same conditions): visible photos loaded in 4.5 s
on Exposures (was 11.2 s) and 4.3 s on a tag page (8.9 s); CLS back to
0.018 and 0. Lighthouse mobile Exposures from the original baseline: score
54 → 91, LCP 8.0 → 3.3 s, 5.3 MB → 467 KB, 96 → 30 requests.

**Rejected.** A service worker (static pages, 304 revalidation and
prefetch already cover repeat visits); view transitions (no measured
bottleneck at navigation; native navigation is fast once prefetched);
prerender (would run a fresh shuffle off-screen); Lighthouse TBT as
evidence (it tracked load on the measuring machine, not the site).

## 2026-10-25 — Exhibition: one photograph at a time, full screen, from the URL

**What.** `/exposures/exhibition/` plays photographs full screen on a
dark wall. One static page; the URL names the source (`?tag=`, `?film=`,
both, a share code `?p=`/`?s=`, or nothing for Selected Work) and the
settings (`slide`, `fade`, `order`, `motion`, `info`, written only when
they differ from the defaults). An "Exhibition" link on Selected Work
(following its filters), tag, film, Saved and Share pages, revealed only
with JavaScript.

**Why this shape.** It's Saved and Share's arrangement again: the page
carries every public photograph's lightbox data (`lightbox-data.ts`, plus
tags, places, date — ~33 KB gzipped for 251) and picks its subset in the
browser. No server state, no new routes per tag, no dependency; a share
code doubles as a curated sequence in its sender's order. Only
`loadArchive()` is in the payload, so no link reaches an unstarred
photograph or `/private`. A code that decodes to nothing plays nothing,
as the Share page shows nothing.

**Details that matter.** Two layers only; a transition starts once the
next photograph has decoded (on a slow network the current one simply
stays longer; one that fails to load is skipped). Crossfade between
photographs of the same orientation; a dip to the wall between landscape
and portrait, so one frame's edges never hang over the other. Drift is a
≤3% scale about an origin 30–70% across, inside a 6vw/6vh mat, so it never
crops (a test ties the two numbers together); off under reduced motion.
Fades and drift are Web Animations, so pause freezes them mid-way — and
the site-wide reduced-motion CSS rule doesn't collapse the crossfade. Each
image's `sizes` is its exact contained width, so a portrait never
downloads a landscape's width; devices reporting ≤2 GB memory are capped
at 1920 device pixels. Wake lock while playing; a hidden tab pauses.
Controls and cursor leave after 2.5 s; the wall label gives way to them.
iPhone Safari has no page full-screen API, so the button isn't offered
there.

**Rejected / deferred.** Reusing the lightbox's three slots and
`swipe.ts` (built for drag-to-slide, not timed fades). Video export:
deferred — in-browser encoding needs a dependency and is slow on phones;
an offline ffmpeg render from the same URL-defined sequence is the right
shape if it's ever wanted, with files kept off the site (bandwidth over
the tunnel, Cloudflare's terms on video). Next: an ambient TV preset,
chapter cards between tags, hand-written exhibition files, and 3840 px
variants for 4K screens (pipeline-wide cost, every photo).

## 2026-10-26 — The watchdog runs through bash (SELinux)

**What happened.** From installation (2026-10-25) the watchdog never ran: every
minute systemd failed with `status=203/EXEC … Permission denied`, though
`deploy/watchdog.sh` is mode 755. Fedora's SELinux policy doesn't let `init_t`
exec a file labeled `user_home_t`; it may exec `/bin/bash` (`bin_t`), which
may then read the script. `photography-serve` never hit this because its
ExecStart is the node binary. `pnpm status` showed it under "Errors in the
last 24h"; nothing else did.

**Decision.** `ExecStart=/bin/bash …/deploy/watchdog.sh`.

**Rejected.** Relabeling the script (`chcon -t bin_t`): a git checkout or
`restorecon` quietly undoes it. A `semanage fcontext` rule: survives that,
but it's a machine-wide setting the repo can't carry, and it's invisible
to anyone reading the unit.

## 2026-10-26 — Exhibition: one photograph on the wall; the lightbox never shows a stale photo

**Reported.** Exhibition sometimes showed a portrait with large cropped
panels either side, or the previous photograph over the next; the
lightbox sometimes showed a photo, flickered, and switched to another.

**Causes.** Not a carousel — the panels were a landscape still on the
wall behind a portrait. (1) Fades were `fill: forwards` animations that
piled up on each layer, and a new step `finish()`ed some of them
mid-flight: stepping back during a landscape↔portrait change snapped one
layer to full while the other was still fading in. Reproduced in
Chromium on tag 0828 by stepping eight times at 90 ms (both layers at
1.00/0.84). (2) Pause paused the fades too, so stepping while paused froze
a fade at its first frame and the next step jumped it to its end. (3) Both
views reuse `<img>` elements; a reused one keeps painting its previous
photograph until the new bytes arrive, and its `decode()` can resolve
against the old image.

**Decision.** Exhibition: every opacity change goes through one list of
fades; a step first _settles_ any fade in flight (to its end, committed
inline), so one photograph is on the wall while the next loads. Pause
holds the drift and timer only. A crossfade only when the two aspect
ratios match within 2% (identical boxes); otherwise out, then in, in the
same total time — generalising "same orientation", since a 3:2 over a
square shows edges too. A fresh `<img>` per photograph in both views. The
wall is pure black; the top and bottom margins are at least a control
bar's height (bars slimmed to 0.5rem padding), so controls never lie over
a photograph. Default transition 1 s (was 2); manual steps 0.8 s.
Lightbox: the grid's already-loaded thumbnail sits behind the full-size
image while it loads (never one that hasn't loaded — that would start a
second download), and the two hidden neighbours are `decode()`d ahead,
since `display: none` images download but don't decode until shown.

**Rejected.** Crossfading every pair (the panels again, mid-fade).
Cancelling, rather than finishing, an interrupted fade (leaves an
arbitrary blend on the wall). Controls over the photograph while visible
(never overlap). Dropping the drift: it's a ≤3% scale inside the margin,
not movement between photographs, and off under reduced motion.

## 2026-10-26 — Grid: first-screen priority read from the layout, not the DOM

**Measured** (live Exposures, 390×844 @3×, 1.6 Mbps / 150 ms, 4× CPU,
median of five, each phase from Resource and Navigation Timing). The
inline grid script blocked the main thread for 2.9 s, 2.4 s of it in the
loop that picks the first screen's photographs: each iteration read
`getComputedStyle(item).transform` after the last had removed `src`/`srcset`
attributes, forcing a fresh style pass — 251 times. Fixed by keeping each
figure's `top` from `layout()` (a WeakMap). Same conditions, production
HTML against the new build: script 2.9 → 0.95 s, DOMContentLoaded 5.7 →
3.0 s, first photo painted 6.0 → 4.1 s, LCP 7.8 → 5.6 s.

**Tried and dropped.** Priority hints within the first screen — high for
the first row (or top half), low for the rest — made no measurable
difference; the remaining load time is nine full-quality photographs over
1.6 Mbps. `sizes` is already exact: a portrait tile's 636 px-wide variant
(named 960, its long edge) is the smallest that covers 163 CSS px at 3×.
Exhibition (first photograph 1.4 s desktop / 3.4 s throttled phone; every
transition's photograph decoded before its fade; heap flat at ~1.2 MB and
two `<img>` over two minutes of autoplay; about one 50–80 ms frame per
transition, with no script attributed — the incoming image's first raster
at near-zero opacity) had no measured bottleneck worth a change.

## 2026-10-26 — Security headers on every response; a parallel, cached `pnpm check`

**Headers.** Production sent none. `tools/serve` now sets, on every
response: HSTS (one year; not `includeSubDomains`, which would bind hosts
this server doesn't own; not preloaded), `nosniff`,
`strict-origin-when-cross-origin`, and `X-Frame-Options: DENY` plus
`frame-ancestors 'none'` — no page is meant to be framed, the `/private`
login least of all. `HEAD /private` now answers like `GET` (it was 404).
**Deferred:** a full CSP — the inline grid script, the inline JSON
payloads and Cloudflare's injected analytics beacon need a considered
policy, and a wrong one breaks the site silently.

**`pnpm check`** (tools/qa/src/check.ts) runs format, lint, each package's
types and the unit tests side by side, each with its own cache
(`prettier --cache`, `eslint --cache`, `tsc --incremental`). The same steps
in sequence, uncached, took ~97 s; warm, `check` takes 9–14 s. `verify` is
now `check` plus the trial build, so the pre-push hook and `pnpm deploy`
use it too. Everything still runs every time: the unit suite is ~7 s, too
cheap to select from.

## 2026-10-26 — Browser tests in the deploy gate, chosen by risk

**Why.** Every defect fixed today — Exhibition holding two photographs on
the wall, the lightbox showing a stale one, a 2.9 s layout loop, a
watchdog that never ran — passed `pnpm verify`. They were browser
behaviour, which nothing tested.

**Decision.** `tools/qa/src/browser/` on `node:test` + `playwright-core`
(docs/testing.md). `pnpm deploy` runs the smoke suite plus the areas
`risk.ts` picks for the changes since the live commit against the
candidate on :4398 before switching, and the smoke suite again against the
origin after, rolling back on failure. Assertions are geometric and
stateful rather than pixel diffs. The first full run found a real defect:
at 360 px Exhibition's bottom bar didn't fit one line — "Full screen" wrapped
and ran off the edge — so the bar grew taller than the margin reserved for
it and lay over portrait photographs. Below 30rem the bar now stacks into
two centred rows and `--mat-bottom` grows with it; no button label wraps.

**Rejected.** `@playwright/test` (a second test runner; `node:test` with
the library gives traces and screenshots on failure without one). Pixel
baselines in the gate (every photo page shuffles; a new photograph would
fail them). Selecting by import graph (a readable table is enough at this
size, and unknown paths run everything). Retries (a flaky test is a bug to
fix, not to hide).

## 2026-10-26 — Labels in tracked capitals; proper names; Saved as a word; an opaque lightbox

From the art-direction review (an artifact, 2026-10-26), decided on the
owner's instruction to use best judgment.

- **Labels.** The self-hosted Newsreader has no small-caps glyphs (setting
  `smcp` changes nothing; `font-synthesis: none` makes small caps vanish),
  so all 23 `font-variant-caps: small-caps` rules were the browser's
  shrunken capitals — thin, unevenly spaced ("Expo sures"). They are now
  real capitals, ~0.72–0.75rem, tracked 0.08em; `.dateline` matches.
  Buttons and selects inherit `text-transform` and `letter-spacing` (a
  browser's default is none, which left "Shuffle" in lowercase). Dishes'
  system-sans metadata and section heads moved to the same serif voice;
  the scale buttons are text toggles, not boxes. **Rejected:** hunting for
  a Newsreader build with true small caps — unverifiable today, and the
  tracked-capital voice already existed in `.dateline`.
- **Film stocks by name.** `film-stocks.ts` maps each `rolls.yaml` slug to
  its printed name (a test fails if a stock in the data has none); every
  display — the Exposures filter (uppercase in the option text, since a
  native option list ignores CSS), roll pages, film page titles, the
  lightbox, Exhibition — uses it. Slugs stay the key in data, URLs and
  filtering.
- **Saved** is the word and its count in the navigation, not a cart icon:
  nothing is for sale, and the cart misnamed the feature.
- **Lightbox.** The backdrop is opaque (was 92%: the grid and masthead
  showed through). The caption's first line is the edge print — stock and
  frame ("CINESTILL 400D · FRAME 22") — as on a negative's rebate.
- **Actions** (Shuffle, Exhibition, Saved's Share all) have no underline
  at rest; the accent hairline appears on hover or focus.
- **Phone masthead** tightened (name and Saved on one line, collections
  spread beneath, less padding).

## 2026-10-26 — Pictures as a catalogue; the Saved mark restored

Prototype A from the art-direction review, built (the review rendered
three options on the live page; A was recommended).

- **The year** stands in a 10rem margin column from 64rem up, set large in
  oldstyle figures with "N films seen", sticky beside its own films (it's
  in its own column, so it never covers one). Below 64rem it heads its
  section. An **index of years** with counts sits under the lede.
- **Each card:** a catalogue line — № in the year's viewing order (the year's
  first film seen is № 1) and the day it was seen, from `ratedOn` — then
  the title (now the Letterboxd link, replacing 775 "Letterboxd ↗" lines),
  then director · release year · runtime, then the synopsis clamped to three
  lines (two on a phone). Genres left the card; the genre filter still
  reads them. Posters lost the mat for a hairline (many carry their own
  white border) and grew from 208px to 222px wide at 1440. Hover is a darker
  hairline: no lift, shadow or zoom. A pick is an accent ring.
- **Controls** are one ruled line in the page's flow. Not sticky: a first
  build made them sticky, and the new Pictures browser test showed posters
  clipped under it while scrolling — the reason the masthead stopped being
  sticky on 2026-10-16.
- **The load-time arrival** (posters rising and fading in, staggered) is
  gone: they are simply there. Shuffle's and the filter's glide (motion.ts)
  stays — that's feedback on an action, not loading.
- A **colophon** closes the log.

**Saved** keeps the word, and the cart mark is back after it with its
count — dropped earlier today, restored at the owner's request.

## 2026-10-26 — Make It Vegan: one library, two ways to prepare each recipe

**Shape.** `recipes/substitutions/vegan.yaml` is a curated, hand-edited
library (dairy, eggs, meat, seafood-derived, honey, gelatin, hidden
ingredients such as pesto's Parmesan, Worcestershire's anchovy and lard in
some tortillas). Each entry has phrases, `unless`/`unlessFollowedBy`
exclusions and options by culinary role, each with a confidence —
`direct`, `recipe-dependent` or `reformulate` — products, and a reason.
`site/src/recipes/vegan.ts` reads it at build time and returns a vegan
reading of each recipe without touching it. Lines a swap changes are
rendered twice; one `data-version` attribute chooses which shows, so the
switch is instant, the scaler scales both, and without JavaScript the
recipe reads as written. One remembered preference (`dishes:version`)
drives the recipe toggle and the Dishes index's Vegan filter. A recipe
can choose another option per ingredient (`vegan: { use: { egg: just-egg } }`).

**Rules that keep it honest.** Already-plant-based wording ("vegan ground
beef", "plant-based…", "-free") is never swapped. Quantities are never
invented: swaps keep the recipe's amount, ratios (flax per egg) live in
the explanation. `reformulate` swaps are never applied, and such a recipe
isn't offered as vegan. Instructions change only for ingredients the
recipe actually swapped, with the same choice. The index distinguishes
"Vegan" (as written) from "Can be made vegan".

**Also.** Recipe notes render again (dropped from the page on 2026-08-10
by the checklist rewrite, though every recipe kept writing them).

**Not done.** Editing the library in an admin interface: `pnpm run edit`
is the photo editor, and recipes have always been edited as YAML, so the
library is YAML beside them. There is no recipe search and no saved
recipes to keep consistent; the index filter is the discovery surface.

## 2026-10-26 — Exposures on a phone: one toolbar row, less air, two columns kept

The two-column masonry stays (an owner decision, not to be revisited).
Around it, below 40rem: the toolbar is one row aligned to the title —
the film-stock select takes the remaining width (it had sized itself to its
longest option, pushing Exhibition onto an orphaned second row), Shuffle
and Exhibition together at the right — and title, toolbar and grid are
spaced by the grid's own 1rem gutter. The four collections fit one line
down to 360px (column gap 1rem). Measured: photographs start at 220px at
360–430px wide (were 265–298px). A gallery test holds this at 360, 375,
390 and 430px. Desktop unchanged.

## 2026-10-26 — Loading that disappears: a session-stable deal, no entrance animations

**Measured first** (production, Exposures, median of three; phone =
390×844 @3×, 1.6 Mbps / 150 ms / 4× CPU). Cold: FCP 2.35 s, LCP 5.6 s.
Refresh: FCP 0.80 s but LCP **6.1 s** — worse than cold — with 60 of 74
photographs fetched again; returning from another page: LCP 5.3 s, 31 of
68 from the network. The HTML itself revalidated to a 0.3 KB 304 and every
asset was cached; the cause was the shuffle: each load dealt a new order,
so the first screen was mostly photographs the browser had never fetched.

**Decision.** The deal stays random per visit but is seeded once per page
per browsing session (sessionStorage), so a refresh or a return finds the
arrangement — and the cache — it left; a new session reshuffles, Shuffle
still reshuffles. And no entrance animations anywhere: page titles rose
and faded in over 0.8 s, archive rows in a stagger, Tunes' list faded in;
all removed, so structure and type are in the first frame. Photographs keep
their colour placeholder and simply appear when they arrive — no fade, so
nothing cached is ever delayed.

**Rejected.** A fade-in for late images (a 120–180 ms reveal was allowed by
the brief "if useful"; telling cached from late reliably needs per-image
script, and the colour placeholder already makes arrival calm). Fewer or
smaller first-screen photographs (fidelity). A service worker (HTML
revalidation already costs one round trip and no bytes).

## 2026-10-26 — /system: the site's health, recorded by jobs, read by a page

**Shape.** `status/` (git-ignored, machine-local) holds three files, each
written whole and renamed into place: `deploys.json` (last 50) by
`deploy/deploy.sh` through `tools/qa/src/status-record.ts` on every way a
deploy ends — a step failing (blocked, via an ERR trap naming the stage),
the candidate's browser checks failing (blocked), production failing after
the switch (rolled back), or success; `watchdog.json` by the minute
watchdog (when it ran, whether the server and the public address
answered); `perf.json` (last 90) by `pnpm measure` — Lighthouse 12.6.0
mobile and desktop and the throttled-phone Exposures and Exhibition
measurements used for the 2026-10-26 performance work, medians of three,
each run carrying its config and a version. `photography-measure.timer`
runs it weekly. `tools/serve/src/system.ts` renders /system from those
files at request time, plus the same in-process health check /healthz
runs; it never starts a test, build or measurement.

**Honesty rules, all tested.** A missing or malformed file is "no data" or
"could not be read", never an error page or a guess. The verdict follows
printed rules (Incident: live health fails; Unknown: no health or no
deploys; Degraded: watchdog stale over 10 minutes or failing, or the
latest deploy stopped or rolled back after the serving release;
otherwise Operational). Measurements older than 8 days say stale. Runs
with different setups are never compared, and trend lines break between
them. Changes within noise (Lighthouse ±5, timings ±10%, CLS ±0.02) read
"within noise". Uptime says "Not monitored": every check runs on this
machine. Only allowlisted fields reach the page; a deploy note is the
commit subject up to its first colon, and any text that looks like a path,
address or port is dropped (a test feeds it hostile records).

**Not done.** External uptime monitoring (a paid or third-party service:
needs the owner's decision), real-user field data (INP), Firefox/WebKit
runs, visual-regression screenshots, Exhibition endurance runs — each shows
as "Not run" or "Not monitored" on the page, not as passing.

## 2026-10-26 — /infra: a service directory for the tailnet only

A read-only list of avadoplex's services (infra/services.yaml, git-ignored:
hostnames and ports stay off GitHub), with a TCP-connect availability dot
each, rendered by tools/serve. Public `/system` is separate.

**Boundary, in the server, from the connection itself.** Served only when
(1) the socket's local address is this machine's Tailscale address — the
Cloudflare tunnel (ingress: randyliang.net and www → localhost:4322, else 404) and Tailscale serve both connect from loopback, so they never qualify;
(2) the peer is a Tailscale address — not spoofable over TCP, since replies
route back over Tailscale and a forged handshake never completes; (3)
tailscaled's local-API `whois` names the peer as a node owned by the same
user as this machine, or holding the `randyliang.net/cap/infra` capability
granted in the tailnet policy — so ACLs and grants decide, not this code.
Any failure, tailscaled not answering included, is the site's ordinary 404.
No header is ever read. Verified before deploy against the new server on a
spare port, every request carrying forged `cf-connecting-ip` /
`x-forwarded-for`: loopback v4/v6, LAN address and public IPv6 → 404;
Tailscale v4/v6 → 200.

**Rejected.** A password (the tailnet already authenticates the device); a
header from Tailscale serve (spoofable through any other path); listing it
in robots.txt (that would advertise it).

## 2026-10-26 — The deploy proves dependencies load, not just that pnpm says so

**What happened.** After merging /system, the deploy's `pnpm install
--frozen-lockfile` reported "Already up to date" while 113 packages were
missing from disk — `tslib` among them, which Lighthouse's i18n needs. The
gate passed (nothing it ran needed those packages), and the failure showed
up later as Lighthouse returning nothing in the measurement (both a manual
run and the first systemd run). pnpm's state files (`.modules.yaml`,
`.pnpm/lock.yaml`, `.pnpm-workspace-state-v1.json`) all claimed a complete
install; only `pnpm install --frozen-lockfile --force` relinked it — no
version changed.

**Decision.** `tools/qa/src/deps-check.ts`, run by the deploy straight
after the install: for each workspace package, import every declared
dependency from that package's directory in a fresh process, start
Lighthouse's CLI, and check Playwright's browser is on disk. ~2 s. A
failure stops the deploy at the "dependencies" stage, recorded on /system,
with the fix printed.

**Rejected.** Comparing `node_modules/.pnpm` against the lockfile entry by
entry (pnpm's directory naming for peer-dependency variants is an internal
detail; loading the modules is what actually matters).

## 2026-10-26 — /system: a typeset report, linked from the footer

A refinement pass, not a redesign. The four figures that matter most —
Lighthouse mobile and desktop, phone LCP on a first visit and on refresh —
sit large under the status, each with its change since the latest earlier
run measured the same way that has the figure, read against noise bands
(±5 points, ±10%: inside them, "steady"). Trends became rows: name, line,
latest value and range, each point titled with its date and value. Tables
use fixed, equal columns with right-aligned tabular figures and headers
that may wrap, so nothing is clipped at 390px. The title gained its
subtitle and a way home.

**Discoverable, not promoted:** "Site status" in the global footer, in the
footer's muted label voice, opposite the copyright; never in the
navigation. `/infra` stays tailnet-only and is linked from nowhere.

## 2026-10-26 — Pictures, denser: one way between years, small year headings

The year appeared three times (the index, a Year dropdown, a huge margin
heading) and the page opened on empty space. Now: the index of years is
the one way between years — in one compact row with Genre, Shuffle and
Pick for me — and marks the year in view (aria-current, an
IntersectionObserver; the first year at load). The dropdown is gone. Year
headings are a small line ("2026 · 27 films seen") above their films; the
margin column is gone, so the grid has the full width back (five across
from 80rem). No rules or underlines on the controls; tighter spacing
throughout: the first posters start ~360px down at 1440×900 (were 500+).
Also fixed: Pick for me announced "Picked ." with no year since the
title became a link — it reads the title from the heading's text and the
year from the card's `data-year`.

## 2026-10-26 — Pictures: each year's favorites, dated

The films are the owner's favorites of the year they were watched, not a
log of everything seen. The "№" viewing-order number is gone from each
card; the date line is just the day it was watched ("18 October"). Copy
follows: "27 favorites" under each year, "775 favorites since 28 January
2020" to close, and the collection's description "Favorite films, by the
year I watched them." Order and identifiers unchanged.

## 2026-10-26 — A refresh deals again (correcting the session-stable deal)

Keeping each photo page's arrangement for the whole session (earlier today)
also kept it through a refresh — and a visitor refreshing expects new
photographs; the owner noticed. Now `grid-layout.js` reads the navigation's
type: on a reload it deals afresh (and stores that deal); following a link
back, or Back/Forward, keeps the arrangement left, so returning is still
served from cache. The cost is the original one: a refresh on a slow phone
loads mostly uncached photographs again (LCP ~5–6 s on the throttled
profile, against ~2.5 s when it kept the order).

## 2026-10-26 — Pick for me opens over the page instead of moving it

It used to dim every other film and scroll to the pick, losing the
visitor's place. Now a native `<dialog>` shows the picked film's own card
(a copy: poster, date watched, title linking to Letterboxd, credits, the
full synopsis) over a translucent paper backdrop, from wherever the
visitor is. The page is held still while it's open (body fixed at its own
offset; `scrollbar-gutter: stable` so nothing shifts) and restored to the
exact position on close — ×, Escape or a click outside. "Another" draws
again in place. The genre filter still narrows the pool. A dialog rather
than a new overlay component: there was none on Pictures to reuse, and the
native element gives the top layer, focus containment and Escape for free.
Tests, desktop and phone, from 3000px down: in view on open, Another
changes the film, and each way out returns to the same scroll position
with what was on screen unmoved.

## 2026-10-26 — The pick, set as a catalogue page; a refresh starts at the top

**Pick for me's dialog** is laid out like a page from a catalogue: poster
beside its words, centred together; "Picked for you" in the accent above
the date and title; the full synopsis at reading size; "Pick another" and
"On Letterboxd ↗" under it, in the label voice; × quiet in the corner. A
0.22s fade-and-rise on opening, a 0.18s crossfade between picks, neither
under reduced motion. Initial focus is the sheet, not the × (a browser
would ring it).

**A refresh starts the page over at the top** (every page, Base.astro):
photo pages deal a new arrangement on reload, so the browser's restored
scroll position pointed at nothing. Only on a reload is
`history.scrollRestoration` set to manual, and it goes back to automatic
as the page is left, so Back and Forward still return to the place left;
a #fragment still scrolls to its target.

## 2026-10-26 — One entrance motion for image-bearing pages

The owner asked for a site-wide image entrance (reversing this morning's
"no entrance animations" for images; titles and words still appear in the
first frame). One primitive, `site/src/layouts/reveal.ts`, loaded by
Base.astro, not per-page code (and not a shared src/lib: it is layout
infrastructure, like Base itself).

**Motion.** An item rises 24px and fades in over 750ms
(`cubic-bezier(0.16, 1, 0.3, 1)`) as it first enters the viewport; items
arriving together follow reading order 80ms apart (capped at 8 steps);
captions and words follow 150ms behind; items wider than 60% of the
viewport rise 40% less over 950ms. Targets: photo grids (incl. Saved,
Share), film cards, Tunes entries, the tag index's covers. Lightbox,
Exhibition and the Pick dialog keep their own transitions; Dishes has no
images.

**Rules.** Decided before first paint by an inline head script (`.motion`
on <html>): never under reduced motion, never on Back/Forward, never
without IntersectionObserver/WAAPI; if reveal.ts doesn't run within 3s the
class is lifted, so nothing can stay hidden. Each item once per visit
(unobserved after). An item waits for its image (≤1.2s). Opacity and
transform only; the rise is `composite: 'add'`, so masonry positions are
untouched.

**Tests.** Below-the-fold photographs aren't revealed at load and enter
when scrolled to; scrolling back replays nothing; Back shows everything at
once; reduced motion shows everything. Geometry checks wait for motion to
settle. LCP before/after: recorded in the deploy that shipped this.

## 2026-10-26 — Pictures' Shuffle is a toggle; the bar holds still

Shuffle could only be undone by reloading, and it hid the year index,
which shifted the controls across the bar and scrolled the page. Now it
toggles (`aria-pressed`, shown in ink): pressed again, every film goes back
to its year in its original order. The label never changes, the year index
stays (muted while shuffled; a year clicked there ends the shuffle and goes
to that year), and the bar keeps its exact place on screen through both.

## 2026-10-26 — Pictures' bar is pinned while you browse

Once you had gone to a year, the years, genre, Shuffle and Pick were all
back at the top of a very long page. The bar (`.film-bar`) is now sticky on
every width: one slim line on a desktop; on a phone two lines — the years
as a single sideways-scrolling strip (the current year kept in view), the
controls beneath. A hairline appears under it only once it is pinned
(a sentinel's IntersectionObserver sets `.is-stuck`). Year headings carry
`scroll-margin-top` so a chosen year lands just below the bar, and the
year marker ignores whatever is hidden under the bar. Rejected: a
floating "Options" button on phones (one more tap for every choice, and
it hid the year you're in), and a pinned bar of years only (genre and
Pick would still be a scroll away). The masthead stays unpinned — only
this page's own controls follow you.

Also: Society (1989) had matched Dead Poets Society on TMDB; pinned to
22244 in `films/tmdb-corrections.yaml`.

---

## 2026-10-26 — Hearts replace the star: a three-tier rating that publishes and weights

**Decision.** photos.yaml's `featured: true` becomes `rating: 1|2|3`
(Decent, Good, Great); absent is unrated. Any rating publishes the photo,
exactly as the star did — `featuredOnly`, `selectedWork()` now test
`rating > 0` — so one field decides both whether and how strongly a photo is
shown, and the two can never disagree. The editor's star becomes a heart
control that cycles Unrated → Decent → Good → Great → Unrated (grid,
inspector, and review's F). Migration: every `featured: true` (251) became
`rating: 1`, every `featured: false` (10) was dropped; nothing changed on
the public site. No fallback reader for `featured` — the same no-migration
stance as the manifest schema.

**Weighting.** `weightOf` (archive.ts): unrated 1, Decent 1.5, Good 2,
Great 3. Every shuffle — the pre-paint deal in grid-layout.js, Selected
Work's Shuffle, Exhibition's rounds — is Efraimidis–Spirakis: each photo
draws u^(1/weight) and the largest go first. Equal weights are an ordinary
uniform shuffle; a heavier photo tends to land earlier, never certainly
(3× against 1× leads three times in four — a unit test holds that). The
deal stays seeded per visit, so Back still finds the same arrangement.
There is no selection step to weight: every page shows all its photos, so
weight only moves position (and how soon Exhibition reaches a photo).

**Visibility.** The shuffle runs in the browser, so each tile carries its
weight as `data-w`. Never shown, but readable in page source — accepted by
the owner over baking a weighted order into each build (which would hide it
at the cost of per-visit randomness).

**Rejected.** Hearts beside a kept star (two controls for one judgement;
the owner chose replacement); a separate weights file (the rating already
is the weight); a fallback reader for old `featured:` entries.

## 2026-10-27 — Vegan swaps list the swap and the products, not the reasoning

The Vegan swaps section on a recipe showed each option's `why` — a few
sentences on how the substitute behaves ("Grated over pasta or vegetables
it reads the same…"). Too verbose for the page. It now shows the swap
(`butter → plant-based butter`), its confidence, and "Try …" products.
`why` stays required in `recipes/substitutions/vegan.yaml` as the library's
own reasoning, unrendered.

**Cost.** Ratios that live only in `why` (flax per egg, lemon per cup of
soy milk) no longer reach the page. No current recipe uses those swaps;
when one does, the ratio belongs in a short `use` or in the recipe itself.

**Rejected.** Deleting `why` from the library (it's how the options were
chosen, and the tests rely on each option being explained).

Same day: recipe notes that read as generic filler rather than the
author's own voice were removed (one teriyaki note kept), following the
Crunchwrap's notes on 2026-10-26.

---

## 2026-10-27 — Tunes is removed

**Decision.** The Music collection is gone: `/tunes/`, `site/src/music/`,
`music/tracks.yaml`, its `collections.ts` entry (so it leaves the masthead,
`/collections/` and the sitemap), and the `/music/` → `/tunes/` legacy
redirect. `/tunes/` and `/music/` now get the ordinary 404. The track list
survives only in git history.

**Why.** Direct owner request. Asked whether the screening room should
show stills instead of playing videos, the owner chose to drop the page
entirely rather than keep a reduced version.

**Rejected.** A still-only room linking out to YouTube; a still covering a
still-playing player (YouTube's terms forbid hiding the embed); sending
`/tunes/` somewhere else with a redirect (there is no successor page).

---

## 2026-10-27 — Exhibition is called Gallery

**Decision.** Visitors see "Gallery" wherever they saw "Exhibition": every
link to it (Selected Work, tag, film stock, Saved, Share), the page's
title and label, and /system's measurement labels. It lives at
`/exposures/gallery/`; `tools/serve` 301s `/exposures/exhibition/…` there,
query string intact, so every link already shared (whose URL is the whole
state) still plays. Code keeps the name exhibition (`exhibition.ts`,
`exhibition-model.ts`, CSS classes, the `exhibition` test area, the
`exhibitionFirstPhotoMs` field in `status/perf.json`, the preferences key in
localStorage).

**Why.** Direct owner request.

**Rejected.** Renaming the code too: in this codebase "gallery" already
names the photo grid (`.grid`, `grid-layout.js`, the `gallery` browser-test
area), so a full rename would merge two different things under one name,
and renaming the perf field and the localStorage key would break recorded
history and visitors' saved settings for no visible gain.

---

## 2026-10-28 — Tunes is back, still-image uploads only

**Decision.** The 2026-10-27 removal is reverted: `/tunes/`, `site/src/music/`,
`music/tracks.yaml`, its `collections.ts` entry and the `/music/` → `/tunes/`
redirect return as they were. "Favorite Girl" (Justin Bieber) is dropped from
the list. Every YouTube entry now points at a still-image upload of the song
— the artist's own "Official Audio" where it has one, otherwise the "Artist -
Topic" art track (the first such result) — never a music video. Seven links
changed: Stateside, Kitten, Melatonin, Residue, Still Tippin', 夢中人, and
Sexy Boy (whose earlier "Official Audio" upload is an animated visualizer;
the band's other Moon Safari upload is a still).

**How it was checked.** Each video's three auto-captured frames
(`i.ytimg.com/vi/<id>/{1,2,3}.jpg`, at 25/50/75% of its length) were
compared; a still image's frames are near-identical (mean difference < 2/255
here, against ~100 for the visualizer). New tracks should be held to the
same rule.

**Why.** Direct owner request: the page is for the songs, not their videos.

---

## 2026-10-28 — Family chat

**Decision.** A private group chat at `/family/`, inside `tools/serve`
(`src/family/`): per-person accounts (username + password, Argon2id via
`node:crypto`), revocable database sessions (random token, SHA-256 at rest,
400-day sliding cookie scoped to `/family`), SQLite via `node:sqlite` in
`private/family/chat.db` (WAL, `synchronous = FULL`), live delivery over
Server-Sent Events with a global `rev` for replay, client-generated ids for
idempotent sends, photos stored by random id and sniffed from their bytes.
Admin is a Members page for admin accounts plus `pnpm family` for the first
account, backups and restore. iMessage-like interface, own stylesheet and
script under `static/`, strict CSP, no third-party asset. Owner's three
requests (chat, iMessage look, password accounts) arrived together and were
built as one.

**Why.** The existing server already owns every private boundary (`/private`,
`/infra`), runs as one supervised process, and is what Cloudflare reaches; a
second app would mean a second service, port and ingress rule for a handful
of users. Node 24 ships Argon2id and SQLite, so no dependency (invariant 11
not triggered). SSE over WebSockets: plain HTTP the server and Cloudflare
already handle, built-in browser reconnect with `Last-Event-ID`, and the
only thing that must flow server → client live is events; sends are ordinary
POSTs with ordinary error handling. Passwords over the first draft's invite
links: the owner asked for them, and a password works on a new phone without
him sending anything through WeChat. Mother in mainland China shaped the
rest: nothing from Google or any CDN, no email/SMS/CAPTCHA, reconnect and
replay assumed to be routine rather than exceptional.

**Rejected.** WebSockets (a dependency or a hand-rolled framing layer, and
nothing gained at this volume). The existing `/private` HMAC token for
sessions (stateless, so not revocable per person). A separate service or a
hosted chat backend (Firebase etc. are unreliable from China and put
messages with a third party). Rendering the chat in the Astro build
(invariant 10's whole point is that the build never sees private data).
Per-username lockout only, or per-address only: both, so a guesser can't
spread one name across addresses, and one address can't spray names.
Claiming end-to-end encryption: it isn't; Cloudflare terminates TLS and the
database is plaintext on disk, and docs/family.md says so.

**Contrast note.** `#007AFF` (the owner's specified blue) under white 17px
text is 4.0:1, under WCAG AA's 4.5:1 for normal text; kept as specified
since it's the defining colour of the look, with text at 17px. `#0066D6`
would reach 5.4:1 if that ever matters more.

## 2026-10-28 — Family chat: notifications, sync epochs, and a hub crash

**Decision.** Web Push for `/family/`, implemented in `webpush.ts` on
`node:crypto` alone (RFC 8291 `aes128gcm`, RFC 8292 VAPID, ES256), verified
byte-for-byte against RFC 8291's worked example. One subscription per
device, keyed by endpoint and **tied to the sign-in** (`session_hash`,
`ON DELETE CASCADE`), so every way a session ends also ends that device's
notifications. Payload generic by default ("New message"); sender and text
only with the device's own Preview switch. Suppressed for anyone whose
page reports itself visible (a 40 s lease renewed every 25 s), never for
the author. A service worker with no `fetch` handler. A database **epoch**
in `meta`, renewed by restore: a page whose epoch differs, or whose
last-seen rev is ahead of the server's, gets `reset`. Unsent photo uploads
are deleted after 24 h. The page script is split into ES modules whose
relative imports the server stamps with one shared version at startup,
preloaded from the page.

**Why.** The `web-push` package would be a dependency (and its own
`http_ece`, `jws`, `asn1.js`) for ~120 lines Node already has the
primitives for; the RFC's test vector makes a hand-written encoder
checkable. Tying subscriptions to sessions makes revocation one rule
instead of four code paths. Generic by default because lock screens are
shared; the push payload itself is end-to-end encrypted to the browser
either way. Server-side suppression rather than in the worker because
Safari revokes permission from sites whose pushes show nothing — the
worker must always show one. Without an epoch, a restored (older)
database would leave open pages either waiting for revs the server
already had or skipping new ones that reuse their numbers. One script
version for all modules (not one hash each) because a module's URL then
depends on nothing but the set of files — no dependency-ordered hashing —
and the chat's scripts change together anyway.

**Also fixed.** `Hub` kept an ended stream registered until its `close`
event; a broadcast in between wrote after end, which Node reports as an
`error` event — unhandled, an uncaught exception that takes the whole
server down. `disconnectUser` (revoke, disable, password reset) opened
exactly that window. Ended streams now leave the hub at once, writes to an
ended stream are skipped, and every stream has an `error` listener. And
the chat's font stack put Noto Sans CJK ahead of any Latin face, so on
Android and Linux English set in it with full-width punctuation
("browser’ s"); Latin faces now come first.

**Rejected.** The `web-push` package (above). Subscriptions per user rather
than per session (a revoked phone would keep being notified). Suppressing
in the service worker (Safari). Caching anything in the worker for offline
use: an offline copy of a private conversation on a phone is exactly what
signing out should remove, and the outbox already covers sending while
offline. A user-facing sheet per feature: one Details sheet holds members,
notifications, and what later phases add.

**Not verified on a device yet.** The encryption, VAPID header and the
whole subscribe → send → decrypt path are tested against the RFC and a
stand-in push service; Chromium headless can't receive real pushes. The
first real test is a phone after deploying: Details → Notifications →
Send a Test Notification.

## 2026-10-29 — Family chat: rooms

**Decision.** `/family/` holds several rooms — Family and Disc to start —
among the same members. A `rooms` table (id, slug, name, position);
`messages.room_id` added as `NOT NULL DEFAULT 1`, so the migration moves
every existing message into Family without rewriting a row, and a trigger
stands in for the foreign key (SQLite won't add a `REFERENCES` column with a
non-null default). Read positions move to `room_reads` (user, room),
seeded from `users.last_read_rev`, which stays in place unread. One SSE
stream per tab carries every room's events tagged with `roomId`, on the
existing global `rev`. Presence names the room on screen, so notifications
are suppressed per room. Any request naming no room means Family; a stream
that doesn't ask for `rooms=all` gets Family's events only. URLs:
`/family/` (Family), `/family/?room=<slug>`, `/family/?rooms` (the phone's
list without JavaScript). The header now sets the room's name as iMessage
does — small system type under the faces, with a ›, and no member list
(the subtitle appears only for "Connecting…").

**Why.** One global `rev` keeps replay, ordering and the restore epoch
exactly as they were: a reconnect is still "everything after N", for all
rooms at once, and the list's unread counts update live for rooms not on
screen. Defaulting to Family is what keeps the overlap safe: during a deploy
the previous server writes to a schema-3 database (its inserts land in
Family; it still finds `users.last_read_rev`), and a home-screen app left
open across the deploy keeps working as a Family-only page instead of
showing Disc's messages as Family's. Every member in every room because
that's the request and the existing access model; a membership table can be
added later without touching messages.

**Rejected.** A stream per room (a reconnect per switch, and per-room revs
would mean per-room replay and epochs). Rebuilding `messages` to get a real
foreign key (a copy of every row, `AUTOINCREMENT` and the self-referencing
`reply_to` to carry across, for a constraint a trigger gives). Dropping
`users.last_read_rev` (breaks the previous server mid-deploy). Path-style
room URLs (`/family/disc`), which would share a namespace with `admin`,
`api`, `static` and the rest. Opening `/family/` on the list on phones:
Mom opens the app to Family and should keep doing so.

## 2026-10-29 — Disc is its own chat at /disc/, not a room in Family's

**Decision:** Undo the rooms released this morning. Disc is a second,
separate instance of the chat (`FamilyChat` with `chat: DISC`) at `/disc/`:
its own data directory (`private/disc/`: database, photos, VAPID keys), its
own accounts, its own `disc_session` cookie scoped to `/disc`, its own
service worker and manifest. The chat's code takes its path and name from a
`ChatIdentity` (`chats.ts`); the server mounts one instance per entry. The
browser scripts get the path from the page (`boot.base`, the worker's
scope); the outbox key in localStorage carries the chat's slug, since both
chats share the origin and their user ids overlap. Migration 4 drops the
rooms tables and column, carrying Family's read positions back to
`users.last_read_rev`, and refuses (a CHECK in a temp table) if a message
was ever sent outside Family — none had been.

**Why:** What was wanted was no connection at all — "no way to get to
Family" from Disc. Rooms shared accounts and sessions, so anyone in Disc
was in Family; per-room membership could have fenced that, but it would
still be one sign-in, one database and a selector that knows about both.
Separate instances make the separation structural rather than a check
that every route must remember: a Disc session's token is looked up in a
different database and never even sent to `/family`.

**Rejected:** Keeping rooms and adding a membership table (one access check
per route as the only wall; a leaked link or a bug crosses it). Copying the
chat's code into a second module (two places to fix every bug). Keeping
migration 3's tables unused (every new Disc database would be born with a
"Family" room in it). Rewriting migration 3 (append-only: production has
run it).

## 2026-10-29 — Chats: starter passwords below the minimum, offered for replacing

**Decision:** `pnpm <chat> add --suggest-change` accepts any non-empty
password (Disc's first members were given their usernames) and sets
`users.suggest_new_password`; signing in with it lands on an optional
Choose a Password page, once. Choosing one keeps the current device signed
in and signs out the others. The owner's admin account in Disc was made with
`--same-password-as=family`, copying the Argon2 hash rather than retyping.

**Why:** The owner asked for it. A guessable password is a real weakness on
a public sign-in page; the login limiter (per address and per username)
slows guessing, and the prompt makes replacing it one step. Forcing a change
was rejected: the request was that it be optional.

**Rejected:** One shared account across chats (it would reconnect what
was just separated); making the 8-character minimum apply to starters
(the owner would have to invent and hand out other passwords).
