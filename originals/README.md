# originals/

Your master photographs. Nothing in this repository modifies, commits, or
uploads them.

Organise them one directory per album, named with the slug you want in the URL.
Inside an album, files can sit directly in the album directory, or be split
into rolls — any subdirectory that directly holds images, at any depth:

```
originals/
  hokkaido-winter/
    001.jpg
    002.jpg
  paris-2025/
    0827/
      001.tif
    0828/
      001.tif
      002.tif
```

Nothing is hardcoded about how deep a roll sits or what it's named — `paris-2025`
above is a trip with two rolls; `hokkaido-winter` is a single roll with no
subdirectory at all, and both work the same way.

Files sort by name within a roll, and rolls sort by path; together that order
becomes the default sequence of the album, so numbering files is how you edit
the sequence within a roll. You can override it per photo later without
renaming anything.

`pnpm ingest` reads this directory, writes derivatives into
`generated/derivatives/`, and records what it found in `generated/albums/`.
Originals are read-only to the pipeline.

## Back these up yourself

Everything here is git-ignored, which means this repository is not a backup and
never will be. The derivatives on the CDN are downsized and stripped of
metadata; they will not reconstruct your masters. If this machine dies and you
have no other copy, the photographs are gone.
