# Changelog

A development journal, not a commit log. Entries cover significant
architectural, design, and product milestones only — not refactors,
dependency bumps, formatting, or bug fixes, unless the change materially
altered what the project can do or where it's headed. Entries are appended
chronologically and are never rewritten, except to correct a factual error.

---

## 2026-07-29 — The archive becomes canonical; trips become a tag

The site stopped treating a trip as a structural thing with its own manifest
and route, and started treating it as one tag among many on a photograph.
There is now a single canonical `Archive` — every photograph from every
scanned batch merged into one flat list — and every page (a trip, eventually
a place or a subject) is a _query_ over it: filter by tag, sort by roll and
frame. `/projects/paris-2025/` still works, still shows the same 150
photographs in the same order, but it is now the output of `viewForTag(archive,
"paris-2025")` rather than a page bound to its own manifest file.

This followed directly from the roll/hierarchy work two entries back: once a
trip could hold multiple rolls, the next question was whether a roll — or a
photograph — should ever have been assumed to belong to exactly one trip in
the first place. It shouldn't. A photograph tagged `paris-2025` today might
reasonably also be tagged `street` or `film` tomorrow, and forcing that through
one owning manifest would have meant inventing a second structural concept
("collections") to hold multi-trip or multi-place cases, sitting awkwardly
next to the first. Tags avoid that split: trip, place, and subject are the
same mechanism, a photograph can carry any number of them, and nothing is
duplicated when it appears in two views — both reference the same record.

Two things this deliberately does not do yet: there is no authored metadata
per tag (`tags/<slug>.md` doesn't exist) — a view's title is its tag string
humanised, and its date is derived from EXIF, not written by a photographer.
And there is no per-photo location field. Both were real, closed decisions to
defer, not gaps that were missed: build them the first time a specific tag or
photograph actually needs one, not speculatively for all of them.

Migrating the real archive needed no schema change and no re-encode. Tags are
photographer-authored data living in `photos.yaml`, the same file `alt` and
`caption` already lived in — never the pipeline's manifest. `pnpm ingest` now
seeds a new photo's tags with its batch directory's name, and, once, backfills
that same default onto any existing `photos.yaml` entry that predates tags
entirely (no `tags` key at all). Run against `paris-2025`, that tagged all 150
existing entries `paris-2025` in a single pass with no other change to the
file — same captions, same order, same comments intact.

## 2026-07-29 — Reading View replaces the traditional lightbox

The gallery gained a continuous-scroll "browse mode": clicking a thumbnail no
longer opens a modal dialog with prev/next arrows over a dimmed backdrop.
Instead it switches the album page into a vertical stack of large images
(roughly 70–90% of the viewport tall) that the visitor scrolls through
continuously, with the grid preserved underneath and a single "back to grid"
control to return.

The point of this was less about lightboxes specifically and more about how a
photo essay is actually read: one photograph at a time, in sequence, at a size
that lets it breathe, rather than paged through behind a dimmed backdrop one
click at a time. A modal lightbox was the obvious default and was explicitly
rejected in favor of this reading-first mode.

Browse mode's position lives in the URL (`#photo-<id>`), pushed to history
only on the click that opens it — scrolling or using the keyboard replaces the
hash instead of stacking a history entry per photo. That was a deliberate
choice over pure in-memory JS state: it means the back button closes browse
mode, and a reload or a shared link reopens at the same photograph, which a
state-only toggle could not offer.

This was built as a progressive enhancement on top of the site's existing
JS-free base — every thumbnail is still a real link to its full-size JPEG, so
browse mode degrades cleanly if scripting fails or is off. That constraint
(no unnecessary JavaScript, gallery works with scripting disabled) was kept
rather than relaxed, which matters for whatever reading-experience work comes
next: it sets the expectation that new interaction layers here are additive,
not load-bearing.

---

## 2026-07-29 — The archive becomes hierarchical; rolls become first-class

The pipeline no longer assumes `originals/<album>/` is a flat folder of image
files. It now recursively scans for "rolls" — any directory that directly
contains at least one image, at any depth — so a trip organized as
`originals/paris-2025/0827/`, `0828/`, `0829/`, `0830/` (one folder per
shooting day) is read the same way a flat album always was, with nothing
hardcoded about how deep a roll sits or what its parent folders are named.

This was driven by how the archive actually got used, not a hypothetical: a
real trip is naturally organized as rolls within a trip, not one pile of
files, and the ingest pipeline needed to catch up to that reality rather than
forcing a workaround (renaming files to encode roll information, or splitting
one trip into several fake "albums"). A photo's identity in the manifest
changed from a bare filename to a path relative to the album directory, and
every photo now records which roll it came from.

Rolls also became data the manifest exposes deliberately: a top-level list of
rolls with derived metadata (frame count so far), and a new `rolls.yaml`
alongside `photos.yaml` where a photographer can add roll-level notes (film
stock, etc.) that ingest preserves the same way it already preserved
hand-written captions. The alternative — making each roll its own page/route
— was considered and set aside for now, since the trip is still the story a
visitor is consuming; a roll becoming a real URL later is a presentation
decision layered on data that already exists, not a data migration.

The manifest's schema version moved from 1 to 2 to mark this as an
incompatible shape change — every existing manifest needs a full re-ingest,
which is expected and by design, not a regression.

---

## 2026-07-29 — AI-generated descriptions become an optional ingest stage

`pnpm describe` was added as a separate command, callable independently of
`pnpm ingest`, that asks the Claude API to draft alt text and a short caption
for any photograph that doesn't have one yet. It caches what it generates
against each photo's existing content-derived id, so a repeat run doesn't pay
to re-analyze a photo it already has an answer for, and it never overwrites a
caption a person wrote by hand — only ever filling in what's currently empty.

Hand-writing accessible alt text for every photo in a growing archive doesn't
scale, but the project's foundational property is that `pnpm ingest` runs
fully offline and deterministically, with no network dependency beyond an
opt-in publish step. Folding description generation into ingest by default
would have broken that guarantee outright. Keeping it a separate, optional
stage — behind a small `DescriptionProvider` interface with exactly one method
— means ingest's offline guarantee holds unconditionally, while photographers
who want it still get a real head start on captions instead of a blank field.

The provider interface, rather than a direct call wired into the orchestration
logic, is what makes this extensible: today there's one implementation
(Claude, via the official SDK), but adding a second provider — a different
model, a local one — is implementing that interface once, not touching the
caching, manual-edit-preservation, or resumability logic at all. That logic
was written to survive interruption (a rate limit, a crashed process) without
discarding completed work, and to report a failure on one photo without
stopping the rest of the run — properties that matter more as the archive
this runs against gets larger.

---

## 2026-07-29 — A local metadata editor for batch tagging

`pnpm edit` starts a small local web app for editing the archive's tags, alt
text, and captions — built for speed at the hundreds-of-photos scale, closer
to Lightroom or Photo Mechanic than a form-based CMS. A dense,
keyboard-navigable grid supports click/shift-click/cmd-click
multi-selection; a batch bar shows which tags are on every selected photo
versus only some, and applies an add or remove across the whole selection in
one write; a tag-autocomplete input keeps new tags consistent with what's
already in use instead of accumulating near-duplicate spellings; and a
tag-maintenance view can rename or delete a tag across the entire archive at
once. Every edit writes straight back to the relevant
`albums/<slug>/photos.yaml`, immediately, with no separate "Save" step and no
draft state held only in the browser — the archive stays exactly as
file-backed and git-diffable as it already was.

This exists because hand-editing YAML sequence entries one at a time does
not scale once tagging is the primary way trips, places, and subjects get
organized (see "trips become a tag" above) — the 150-plus photos already in
the archive need real tags beyond the one auto-backfilled trip tag, and that
job needed to be fast enough to actually get done. A hosted or
database-backed tagging tool was rejected outright: the whole point of this
project is that the archive is a set of files, not a service with its own
state to keep in sync. Reusing the Astro site itself as an editing surface
was also rejected — the site is deliberately read-only and static, and
giving it a write path would undermine that boundary for a workflow that's
entirely local and pre-publish anyway.

The editor lives inside `tools/pipeline` rather than as a new top-level
tool, and its frontend is plain, unbundled JavaScript rather than a
framework — both follow directly from constraints this project already
committed to (no build step for the pipeline, no bundler anywhere; see
today's `docs/decisions.md` entry for the specifics). No new dependency was
needed for either half. Left for later: per-roll metadata editing, and
numbered quick-tag hotkey slots in the style of Photo Mechanic's keyboard
shortcuts, once ordinary batch tagging has seen enough real use to know
which tags would benefit from one.

---

## 2026-07-29 — A photo's identity survives a move, not just its path

Moving or renaming a file under `originals/` — into a different roll, or
out of one entirely — used to destroy its caption, alt text, and tags:
`photos.yaml` matched an entry to a photo purely by path, so a moved file
looked exactly like "one file deleted, one unrelated file added." Now a
photo's content (`sourceId`, already computed from its raw bytes for every
photo) is checked first, falling back to path only when content can't
disambiguate; a move is matched and reported as a move, its entry's `file`
updated in place, everything else about it left untouched.

This was a direct prerequisite for reorganizing `originals/paris-2025/` —
the 150 photos there had just been given real tags by hand (via `pnpm
edit`), and flattening the trip's roll subdirectories, as intended, would
have silently wiped all of it under the old behavior. Rather than work
around that (caption/tag everything again after the move) or postpone the
reorganization indefinitely, the underlying assumption — that a
`photos.yaml` entry's identity was its path — got fixed instead, since the
tool to fix it (content hashing) already existed and just wasn't being used
for this.

A same-path re-export is still deliberately a new identity (new
derivatives, new URLs — unchanged from the source-digest decision), and
still keeps its caption, matched by path exactly as before; only genuine
moves are what's newly recognized. Migrating the real archive needed no
schema version bump and cost one silent, one-time backfill: running `pnpm
ingest` with nothing moved gave every one of the 150 existing entries a
`sourceId`, with the rest of the file — captions, tags, comments, order —
untouched. `rolls.yaml`'s identical problem one level up (renaming a roll
directory still loses its film-stock notes) is a known, smaller gap left
for later, not fixed here: a roll has no single hashable identity the way
one photo does.

---

## 2026-08-03 — The site becomes multi-collection, and photography gets a front of house

The homepage stopped being the photography archive. `/` is now a short table
of contents introducing **collections**, and photography — still the flagship,
still the only one with a pipeline behind it — moved to `/photography/`
alongside a second collection, recipes, at `/recipes/`. Everything specific to
photographs moved with it, out of the shared `src/components/`, `src/lib/`, and
`src/scripts/` and into `src/photography/`. What stayed shared is what is
genuinely site-wide: the page shell, the type and colour tokens, the author's
name.

This is the archive-model argument from July 29th one level up. That entry
refused to invent a second structural concept next to the first, and collapsed
trip, place, and subject into tags. The same question arrived again from
outside: photographs are not the only thing worth archiving carefully, and the
alternatives were a second site or a homepage that grows a branch per content
type. A registry (`site/src/collections.ts`) makes a collection a piece of
data instead — adding one is an entry there plus its own pages directory,
never an edit to the homepage or to another collection. The homepage's counts
are computed by asking each collection to count its own things, so they can't
drift the way a hand-typed number does.

Recipes deliberately arrived with none of photography's machinery: one
hand-written YAML file per recipe, read straight off disk, no ingest step, no
manifest, no images. That asymmetry is the proof the seam is real. A
collection brings only what its content actually needs, which is the whole
reason adding one is supposed to be cheap.

Photography also gained a front of house it didn't have: a **Selected Work**
sequence, an **Archive** index, an **About** page, and film-stock views at
`/photography/film/<stock>/` built from the roll notes that were already being
recorded and, until now, never shown. Selected Work is the interesting one,
because it is explicitly _not_ a tag — `featured` and `featuredOrder` in
`photos.yaml` let a photographer pick and order a run of photographs by hand,
which is a claim about presentation that a tag has no way to make. The same
distinction gave `album.md` a working `cover:` field. Both sit on top of the
archive's chronological order without disturbing it: a photograph being
featured changes nothing about where it appears in its own tag's view.

What this does not yet fix is the thing that most needs fixing. All 289
photographs across eight batches still carry only their auto-seeded batch-id
tags, and all 289 still have empty alt text. The new pages make that more
visible, not less: Selected Work currently holds four photographs, and the
archive index lists eight views named after directories. Tagging and
describing the real archive remains the next real work.

---

## 2026-08-03 — Every derivative re-encoded, for fidelity and for a portrait bug

`recipeVersion` went to 2 and the entire archive was re-encoded. The
triggering discovery was a genuine bug: a size tier was being applied as a cap
on a derivative's _width_, which for a portrait photograph is its short edge.
A portrait's long edge was therefore never capped by any tier — a "1200"
variant of a portrait scan came out 1200 wide and far taller, at several times
the intended pixel count and file weight. Landscapes were correct throughout,
which is exactly why it went unnoticed. A tier is now a cap on whichever edge
is longer, with the aspect ratio preserved for both orientations.

Fixing it required the version bump rather than benefiting from content
addressing. A derivative's key digests the encode spec — the tier number, the
quality, the kernel — but not _how_ the resize gets computed from them. The
bug changed the output bytes while every field in the spec stayed identical,
so nothing would have re-keyed on its own. `recipeVersion` exists as the
deliberate escape hatch for precisely that case, and this is the first time it
has been used.

Since everything was being re-encoded anyway, the quality settings were
revisited and moved decisively toward fidelity: AVIF 55 → 82, WebP 76 → 90,
JPEG 80 → 90, and two new size tiers at 3200 and 3840. The old values were
picked as a bandwidth trade-off, which is the wrong trade for an archive of
film scans where grain and subtle gradients _are_ the content. The browse view
renders a photograph at full viewport width, and the previous 2400 ceiling was
visibly short on a large or Retina display.

One thing was measured rather than assumed, and the measurement said no: AVIF
effort 6 ran for over three hours on a few hundred photographs without
finishing. Effort buys a few percent of file size at the same quality and does
not affect how a photograph looks, so it stayed at sharp's default of 4. The
config comment had already called effort 9 a bad trade; 6 turned out to be one
as well.

The cost is that every image URL on the site changed and everything had to be
re-published. That is the designed behaviour of content-addressed derivatives
rather than a regression — no schema change, no migration, and nothing under
`originals/` touched.

---

## 2026-08-03 — A third collection: films, a five-star viewing log, then posters via TMDB

`/films/` joins photography and recipes, built from Letterboxd's own data
export rather than anything hand-written or pipeline-generated. The whole
collection is one committed CSV — the export's `ratings.csv`, trimmed to
5-star rows — read by a small hand-rolled CSV parser rather than a new
dependency, since Letterboxd titles routinely contain the commas and quotes
that make `split(',')` unsafe. The page groups 773 films by the year they
were rated.

It launched as a dense, text-only index on purpose: Letterboxd's own
`robots.txt` disallows AI crawlers by name across the whole site, and a
direct fetch independently came back 403 — both are the site asking
automated tools not to extract its content, and switching from a direct
fetch to browser automation would have been the same scrape in a different
tool, not a different answer. Posters were always meant to come from TMDB's
API instead, which explicitly permits this kind of personal use — and once a
key was available, `tools/films/fetch-posters.ts` (`pnpm films:posters`)
became a fourth workspace, separate from `tools/pipeline` the way
`pnpm describe` is separate from `pnpm ingest`: it makes real network calls
and writes a committed cache, `films/tmdb.json`, that the site reads at
build time with no network access of its own. All 773 films matched a TMDB
entry; 772 came back with a poster. Two small hand-maintained files back the
automated match up — `films/tmdb-corrections.yaml` overrides TMDB's search
heuristic for the rare title it gets wrong, and `films/poster-overrides.yaml`
gives one specific poster a cropped, focal-point treatment instead of the
default uncropped card. The films page now reads as a real poster grid, with
TMDB's required attribution line rendered only when at least one poster is
actually showing.

The same session pushed the shared design system further than either
existing collection had gone: an oxblood accent reserved entirely for the
moment of interaction, a headline scale that goes up to 6.5rem with a
lighter editorial weight, entrance animation on headers and list rows, and a
chapter-opener "ghost numeral" behind every roll's title in scroll mode —
the view's own photo count, restated as huge, nearly-invisible type. Recipes
needed the opposite adjustment: the shared heading scale swamped a recipe
title, and the instruction list's one-line-per-step layout combined with
generous section gaps turned an 11-step method into a very long, sparse
scroll. The steps are now a compact numeral-gutter grid closer to a
magazine's method list than a photobook's chapter breaks, and notes got a
"chef's note" treatment of their own — an accent rule and a fleuron mark,
set apart from the functional Ingredients/Instructions register on purpose.

---

## 2026-08-04 — Recipes get a serving-size scaler and a real checklist

Two additions to the recipe page, both pure client-side progressive
enhancement over the same server-rendered document — neither touches
`recipes/*.yaml`, the pipeline, or `pnpm ingest`. A ½×/1×/2× button group
rescales every ingredient quantity in place; ingredients and instructions
both became real checkboxes, with a per-section "6/11 · 55%" progress count
and checked state remembered per recipe across visits.

Scaling deliberately stops at the ingredients list. A recipe's instructions
carry their own embedded measurements in prose — a splash of pasta water, a
cook time — that don't scale linearly with servings and would misinform a
cook if rescaled automatically; that text was already styled quieter
(`.measurement`) precisely because it isn't something to shop for, and the
scaler leaves it alone. Every quantity is scaled from its original,
unscaled text cached on first read rather than from whatever the previous
scale factor left on screen, so switching ½× → 2× → ½× repeatedly never
compounds rounding error, and the result is always reformatted to a common
cooking fraction (¼, ⅓, ½...) rather than a raw decimal.

The checklist's progress counter has no honest value on a fresh page load —
nothing is checked yet — so it renders nothing rather than a technically-true
but useless "0/11 · 0%", and only appears once a visitor has actually checked
something. Checked boxes persist in `localStorage`, keyed per recipe and per
section, so leaving the kitchen mid-recipe and coming back doesn't lose your
place; the checkboxes themselves are real `<input type="checkbox">` elements
styled with `:checked ~ span`, so the strikethrough treatment and the boxes
themselves both work with JavaScript disabled, same as every other
interactive surface on this site.

---

## 2026-08-08 — A private, password-gated notebook, and the site's first long-lived server

`/private` is a small personal notebook — short dated entries, a `joy` tag,
an occasional photo — that needed to actually be private, not just
unlinked. Every other page on this site is either static HTML built once by
`pnpm build` or an offline CLI that exits when it's done finished; neither
shape can check a password on every request. `tools/serve` is new
infrastructure to make that possible: a small long-lived Node process
(`pnpm serve`) that serves the existing static `site/dist/` build unchanged
and adds exactly one gated route on top, with a real server-verified,
HMAC-signed session cookie — no client-side password check, no session
database, no framework. The 26 public pages are exactly as static as they
were before; nothing in `site/src/` can reach the private notebook's data
even by accident, because nothing in `site/src/` runs at request time at
all. Full reasoning, including why this became a new workspace instead of
giving Astro a server adapter, is in `docs/decisions.md`.

The notebook launched already populated: nine "Recent Joys" — specific,
ordinary things (a good curry, a treadmill, a fence finally getting built),
deliberately not smoothed into generic gratitude-journal language. Adding
more is meant to be as low-friction as editing a text file, because that's
exactly what it is: append an entry to `private/notes.yaml` and it shows up,
newest first, filterable by All/Joys/Photos, with no code to touch and no
UI to redesign.
