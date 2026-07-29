# generated/

Output of the image pipeline. Two halves with opposite rules.

## `albums/*.json` — committed

The manifest: dimensions, aspect ratios, available widths and formats,
placeholder colours, and an allow-listed subset of camera metadata for every
photograph. This is the contract between the pipeline and the site, and the
only thing the site reads.

It is tracked in git on purpose. It is small, it diffs usefully when you add
photographs, and committing it means the site builds without network access to
object storage.

One file per album rather than one large file, so that adding a photograph
produces a diff in one place instead of rewriting the world.

## `derivatives/` — git-ignored

The encoded AVIF, WebP, and JPEG files, and a local cache so that re-running
`publish` does not re-encode anything. Rebuildable from `originals/` at any
time, so there is no reason to carry them in git history forever.

## Do not edit either by hand

Both are written by `pnpm ingest`. Hand edits are silently overwritten on the
next run. Anything you want to say about a photograph — its caption, its alt
text, its position in the sequence — belongs in `albums/`, which the pipeline
reads but never overwrites.
