# originals/

Your master photographs. Nothing in this repository modifies, commits, or
uploads them.

Organise them one directory per album, named with the slug you want in the URL:

```
originals/
  hokkaido-winter/
    001.jpg
    002.jpg
  lisbon-in-august/
    001.jpg
```

Files sort by name, and that order becomes the default sequence of the album,
so numbering them is how you edit the sequence. You can override it per photo
later without renaming anything.

`pnpm ingest` reads this directory, writes derivatives into
`generated/derivatives/`, and records what it found in `generated/albums/`.
Originals are read-only to the pipeline.

## Back these up yourself

Everything here is git-ignored, which means this repository is not a backup and
never will be. The derivatives on the CDN are downsized and stripped of
metadata; they will not reconstruct your masters. If this machine dies and you
have no other copy, the photographs are gone.
