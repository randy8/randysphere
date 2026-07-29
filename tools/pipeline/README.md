# @photo/pipeline

Turns original photographs into web derivatives and a manifest. It has no
dependency on Astro, Vite, or Tailwind, and an ESLint rule fails the build if
one ever appears. If the website is rewritten in something else, this package
keeps working and the new site reads the same JSON.

## Commands

```sh
pnpm ingest                    # encode derivatives, rewrite manifests
pnpm ingest --album lisbon     # just one album
pnpm run publish               # upload to R2
pnpm run publish --local       # write into site/public/ instead
pnpm doctor                    # report drift, change nothing
```

`pnpm publish` is a built-in pnpm command, so the image publisher is
`pnpm run publish`. `pnpm publish:images` is the unambiguous alias.

## What it guarantees

- **Repeat runs do nothing.** A photograph is decoded only if one of its
  derivatives is missing or its content changed. An unchanged collection
  re-ingests with zero decodes.
- **A failed run never lies.** Manifests and `published.json` are written last
  and atomically. Interrupt anything and the previous state survives intact.
- **Nothing is deleted, ever.** Not originals, not derivatives, not remote
  objects. `doctor` reports orphans; collecting them is your decision.
- **No location data can escape.** Camera metadata is copied by allow-list, and
  derivative EXIF is constructed from scratch rather than copied.

## The manifest

One file per album in `generated/albums/`, treated as a public interface: it
may outlive this implementation, so it is versioned, contains no timestamps,
and stores complete object keys rather than fragments the reader must assemble.

```json
{
  "schemaVersion": 1,
  "slug": "hokkaido-winter",
  "photos": [
    {
      "file": "003.jpg",
      "sourceId": "9f2c41a7be03d5e8",
      "width": 6240, "height": 4160,
      "color": "#6b7a82",
      "lqip": "data:image/webp;base64,...",
      "camera": { "make": "Fujifilm", "model": "X-Pro3", "lens": "XF35mmF2 R WR",
                  "focalLength": 35, "aperture": 2, "shutterSpeed": "1/500",
                  "iso": 160, "takenAt": "2024-02-11T08:14:23" },
      "variants": [
        { "format": "avif", "width": 400, "height": 267, "bytes": 9812,
          "key": "p/9f2c41a7be03d5e8/400-1a2b3c4d.avif" }
      ],
      "og": { "format": "jpeg", "width": 1200, "height": 630, "bytes": 96122,
              "key": "p/9f2c41a7be03d5e8/og-4d5e6f70.jpg" }
    }
  ]
}
```

Because the manifest has no timestamp, it is a pure function of the originals
and `pipeline.config.ts`. Running ingest twice produces no diff, which is what
makes it worth committing.

## Keys

```
p/{sourceId}/{width|"og"}-{variantDigest}.{ext}
```

`sourceId` is the first 16 hex characters of the SHA-256 of the **original
file's bytes** — not of its pixels. Re-exporting a photograph with identical
pixels but different metadata therefore produces a new identity and new URLs.
That is a deliberate trade: hashing pixels would mean decoding every original
on every run just to discover that nothing changed.

`variantDigest` is the first 8 hex characters of the SHA-256 of the canonical
JSON of everything that determines those bytes — recipe version, source,
format, width, quality, effort, kernel, colourspace, and copyright. Change the
AVIF quality and only AVIF keys move.

The sharp and libvips versions are deliberately **not** in the digest.
Including them would move every URL on the site on a patch bump. Content
addressing here expresses declared intent, not bit-exact reproducibility across
encoder releases. Use `recipeVersion` when you want a forced re-encode.

Keys are content-addressed and therefore immutable, so they are uploaded with
`Cache-Control: public, max-age=31536000, immutable` and never need purging.

## Who owns what

| Path | Owner |
| --- | --- |
| `originals/**` | You. Opened read-only, never written. |
| `pipeline.config.ts` | You. |
| `albums/<slug>/album.md` | You. Created if absent, never edited after. |
| `albums/<slug>/photos.yaml` | Split: the pipeline decides which files are listed, you own every field, the ordering, and the comments. |
| `generated/**` | The pipeline. Hand edits are overwritten. |

Ingest appends new entries to `photos.yaml` and removes entries whose source is
gone. Before modifying it, it re-serialises the file unchanged and compares: if
the round-trip is not byte-identical, it refuses to write and prints the exact
edits to make by hand, rather than silently reformatting an album's captions.

## Working on it

```sh
pnpm test        # node:test, no runner dependency
pnpm typecheck   # tsc --noEmit; nothing here is ever compiled
```

Node runs the TypeScript directly. There is no build step and no `dist/`, so
only erasable syntax is allowed — no enums, no parameter properties, no
namespaces. `erasableSyntaxOnly` turns a violation into a type error.

Modules that touch a dependency are kept thin and separate from the logic worth
testing: `exif.ts` wraps the EXIF parser while the allow-list lives in
`camera-metadata.ts`; `storage/r2.ts` wraps the HTTP client while the response
reader lives in `storage/s3-list.ts`. That is why the tests that matter most —
GPS exclusion, key determinism, publish integrity — run with nothing installed.
