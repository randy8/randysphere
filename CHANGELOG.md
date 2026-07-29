# Changelog

A development journal, not a commit log. Entries cover significant
architectural, design, and product milestones only — not refactors,
dependency bumps, formatting, or bug fixes, unless the change materially
altered what the project can do or where it's headed. Entries are appended
chronologically and are never rewritten, except to correct a factual error.

---

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
