# CLAUDE.md

Operating guide for Claude Code sessions here. Rules and a map, not history:
`docs/decisions.md` (append-only, dated) records _why_ each call was made,
`docs/dependencies.md` why each dependency exists, `docs/deployment.md` how
randyliang.net stays up, and `CHANGELOG.md` the milestones. Grep
`docs/decisions.md` for a topic before re-litigating it.

## What this is

A personal, long-term archive at randyliang.net — closer to a photobook or a
museum archive than a portfolio. No engagement mechanics, no feeds, no chrome
that doesn't help someone browse. `/` redirects to `/exposures/`.

Four **collections** (`site/src/collections.ts`, introduced at `/collections/`),
each bringing only the machinery its own content needs — the asymmetry is the
design; don't hoist one collection's shape onto another, and don't add a
shared `src/lib/`:

| Collection  | Route         | Content                                                              | Code                    |
| ----------- | ------------- | -------------------------------------------------------------------- | ----------------------- |
| Photography | `/exposures/` | `originals/` → pipeline → `generated/albums/*.json`                  | `site/src/photography/` |
| Recipes     | `/dishes/`    | `recipes/*.yaml`, hand-written, read off disk                        | `site/src/recipes/`     |
| Music       | `/tunes/`     | `music/tracks.yaml`, hand-written                                    | `site/src/music/`       |
| Films       | `/pictures/`  | `films/ratings.csv` (Letterboxd's export, as-is) + `films/tmdb.json` | `site/src/films/`       |

Adding a collection: one entry in `collections.ts`, its own `src/pages/<slug>/`,
and (if needed) its own `src/<slug>/`. `Base.astro` stays collection-agnostic.

## Photography: architecture

```
originals/<batch>/[<roll>/]*.tif|jpg|png|webp   git-ignored, immutable, never uploaded
   │  pnpm ingest   (offline, deterministic)
   ▼
generated/albums/<batch>.json    committed manifest — the pipeline↔site contract
generated/derivatives/p/<hash>/  git-ignored, rebuildable encoded images
albums/<batch>/photos.yaml       hand-edited: alt, caption, tags, featured,
                                 featuredOrder, rotate
albums/<batch>/rolls.yaml        hand-edited: filmStock, notes
albums/<batch>/album.md          only `cover:` is read
   │
   ▼
site/ (Astro, static)   reads manifests + albums/, builds HTML only
tools/serve/            production server: site/dist/ + /p/ straight from
                        generated/derivatives/ + password-gated /private
```

- **`/p/` images are never copied into the site.** `tools/serve` serves them
  from `generated/derivatives/`; `astro dev`/`preview` do the same through a
  small middleware in `site/astro.config.mjs`. So `pnpm build` never touches
  gigabytes of images. (`pnpm run publish` uploads to R2 instead, if
  `imageBaseUrl` in `site/src/photography/config.ts` is ever pointed there.)
- **Archive model.** The site merges every manifest into one flat `Archive`
  (`site/src/photography/archive.ts`); every page is a query over it. A
  _batch_ (top-level `originals/` dir) is pipeline provenance only, with no
  public meaning. A _trip is a tag_ — `/exposures/<tag>/` is `viewForTag`,
  identical code for trips, places, subjects. Never reintroduce a structural
  "trip"/"album" type that owns photographs.
- Non-tag queries: film stock (`rolls.yaml` → `/exposures/film/<stock>/`),
  Selected Work (`featured`/`featuredOrder` → `selectedWork()`, the
  `/exposures/` front page), and cover (`album.md`).
- **Every photo page opens in a random order** on each visit — tag, film
  stock, Archives, Saved, Share (`shuffle-on-load.ts`) and Selected Work
  (`selected-view.ts`, plus its Shuffle button). The server renders
  archival/editorial order, which is what a no-JS visitor gets.
- **Presentation order never disturbs archival order.** `(roll, frame)` is
  chronological; `featuredOrder` and shuffle are read on top.
- **Rolls**: any directory directly containing images, at any depth. A
  photo's manifest `file` is relative to its batch (`0827/001.tif`). No roll
  routes until there's a product reason.
- **Identity**: `sourceId` = SHA-256 of the original's bytes. A `photos.yaml`
  entry follows its content across a move (matched by `sourceId`, then path).
  Matching is per batch — splitting a batch loses its history.
- **Rotation**: `rotate: 90|180|270` (clockwise) in `photos.yaml`, set from
  the editor. Baked into derivatives at ingest; part of each derivative's
  encode spec (only when non-zero), so only rotated photos re-encode.
- **Gallery**: every photo grid — tag/film/Selected Work pages, and Saved/
  Share's contact sheets — is one `.grid`, a plain CSS grid with no JS; `masonry.ts` then
  places each figure in the shortest column (positions only, never DOM
  order — the lightbox, tab order, and Selected Work's filter/shuffle depend
  on DOM order). Column count lives in `--grid-columns` in `base.css`.
- **Saved & Share**: Saved is a list of ids in localStorage (`saved.ts`);
  `syncSavedUI` keeps every save control on the page in step (grid marks
  from `grid-save.ts`, the lightbox's Save / `S`, the nav count). The Saved
  page (`saved-view.ts`) has browse / select / confirm-clear modes; sharing
  encodes the chosen ids into `/exposures/share/?p=` (`share-code.ts`) and
  shows the link in a panel — it never modifies Saved. The link _is_ the
  data: no server state, permanent. `?p=` carries each id's 4-byte prefix
  (~5 chars per photo; a test fails the build if two photos ever share one);
  older `?s=` links carry full ids and still work. Ids since removed
  from the archive are skipped and counted on the recipient's page.
- **Lightbox** (`Lightbox.astro`, `lightbox.ts`, `zoom.ts`): progressive
  enhancement over each tile's plain `<a>` to the full-size JPEG. State in
  the URL (`#photo-<sourceId>`).

## Commands

```sh
pnpm dev                 # Astro dev server, :4321 (images served from generated/derivatives)
pnpm build / preview
pnpm sync                # pnpm ingest + pnpm films:posters: encode new/changed photos,
                         # rewrite manifests, fetch TMDB details for new films
                         # (~1s when nothing changed: originals' hashes are cached
                         # by size+mtime in generated/source-hashes.json)
pnpm run edit            # local editor, 127.0.0.1:4500: tags, alt, captions,
                         # Selected Work, city tags, rotation ([ / ]); paste a
                         # live-site photo link into the filter to jump to it.
                         # Bare `pnpm edit` is
                         # pnpm's own reserved command — always `pnpm run edit`.
pnpm doctor              # report drift, change nothing
pnpm describe            # optional: draft alt text via Claude (ANTHROPIC_API_KEY)
pnpm films:posters       # TMDB details for films not looked up yet (TMDB_READ_ACCESS_TOKEN;
                         # skipped with a warning if unset): --only, --regenerate
pnpm serve               # production server (needs PRIVATE_SITE_PASSWORD,
                         # PRIVATE_SESSION_SECRET in .env)
pnpm deploy              # sync + build + restart photography-serve (sudo)
pnpm verify              # format:check, lint, typecheck, test, build —
                         # also the pre-push hook (.githooks/, core.hooksPath)
```

## Invariants — do not break

1. `pnpm ingest` is offline and deterministic. No network, no API key, ever.
2. Hand-written descriptions are never overwritten without an explicit force.
3. `tools/pipeline` never imports Astro, Vite, or Tailwind (ESLint-enforced),
   and has no build step (Node's native TS type-stripping).
4. The site never touches a photograph's bytes — it builds URLs from manifest
   data (`site/src/photography/image.ts`).
5. No symlinks between derivatives and anything the build reads.
6. Nothing writes to `originals/`. It is git-ignored and never committed.
7. The site works with JavaScript disabled.
8. Manifest schema changes bump `SCHEMA_VERSION` (`tools/pipeline/src/manifest.ts`,
   currently 2) with no migration — old manifests are rejected, re-ingest.
9. `pnpm run edit` binds `127.0.0.1` only — it writes with no authentication.
10. Nothing under `site/src/` reads `private/`. Only `tools/serve` does, and
    only after `verifySessionToken`.
11. No new dependency without a `docs/dependencies.md` entry.

## Sharp edges

- `pnpm ingest` **deletes** a batch's manifest and `albums/<batch>/` (captions,
  tags) when `originals/<batch>/` is missing — including on a fresh clone,
  and regardless of `--album`. Never run it with `originals/` unmounted.
- Ingest scans a batch when it reaches it: a batch still being copied in
  (e.g. via filebrowser) can be ingested half-finished. Wait for the copy.
- `filebrowser/` (untracked, compose file) has write access to `originals/`;
  it binds the Tailscale address only. Its `database/` is git-ignored.
- `/exposures/archive/` (tag index) and `/exposures/archives/` (every photo,
  newest batch first) are both deliberately unlinked.
- `pnpm describe`'s Claude provider has only been tested against a fake.

## Working here

- Before calling a change done: `pnpm typecheck`, `pnpm test`, `pnpm build`;
  for anything touching `originals/` handling, a real `pnpm ingest` too.
  Every pipeline module has colocated `node:test` coverage (`*.test.ts`), no
  other test framework. The editor frontend (`tools/pipeline/src/editor/static/`)
  has no automated tests — check it in a browser.
- `CHANGELOG.md` is milestone-only (architectural/product shifts, 2–5
  paragraphs). `docs/decisions.md` gets a dated entry for any non-obvious call,
  including rejected alternatives. Neither is rewritten after the fact.
- Boring and explicit beats clever; duplication between collections is
  cheaper than a wrong abstraction.

## Current state (2026-10-24)

- 15 batches, ~530 photographs. Nearly all have empty alt text and only an
  auto-seeded batch-name tag — retagging (`pnpm run edit`) and alt text are
  the top priorities. The four Paris batches `0827`–`0830` want one shared
  trip tag; confirm what other batches are before tagging them.
- Several new lab scans (`llfl03`–`llfl05`) arrive sideways — rotate them in
  the editor, then `pnpm sync`.
- Only some rolls have `filmStock` noted in `rolls.yaml`.
- Selected Work is a small, provisional set; it needs a real pass.
- No roll routes, no `tags/<slug>.md`, no per-photo `location` field until a
  specific photo or tag needs one.
