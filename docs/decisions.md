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
