# albums/

What you write about your photographs. The pipeline reads this directory and
writes to it only in the two narrow ways described below.

```
albums/<slug>/album.md      title, date, location, description, cover
albums/<slug>/photos.yaml   one entry per photograph: alt text, captions, order
```

`pnpm ingest` creates both files when an album first appears and never edits
`album.md` again. In `photos.yaml` it maintains only *which files are listed*:
new photographs are appended, entries whose original is gone are removed, and
your ordering, your fields, and your comments are left exactly as they are.

If a rewrite would also reformat the file, ingest refuses and prints the edits
to make by hand instead. It will not restyle your writing to add a line.

Alt text matters here more than in most places: a photograph with an empty
`alt` is invisible to anyone using a screen reader. `pnpm ingest` reports how
many are still empty after every run.
