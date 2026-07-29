# samples/

Four small photographs so that a fresh clone has something to ingest. They are
not in `originals/`, because that directory is git-ignored and belongs to you;
copy them across as the first step of the Quick Start.

They are synthetic, and each one is here to exercise a specific path:

| File | Size | Why it exists |
| --- | --- | --- |
| `001.jpg` | 1800 × 1200 | An ordinary landscape frame. |
| `002.jpg` | 1200 × 1800 | Portrait, so the grid has to cope with both shapes. |
| `003.jpg` | 1800 × 1200, **EXIF orientation 6** | Stored landscape but meant to be seen portrait. If the manifest reports this as 1800 × 1200, orientation handling is broken. |
| `004.jpg` | 1600 × 1067, **carries GPS** | Tagged with coordinates in Sapporo. After ingest, neither the manifest nor any derivative may contain them. |

Two checks worth running once, after your first `pnpm ingest`:

```sh
# 003 must be described as portrait: height greater than width.
grep -A3 '"file": "003.jpg"' generated/albums/sample-album.json

# Nothing anywhere may mention the coordinates that 004 carries.
grep -ri 'GPS\|Latitude\|Longitude' generated/albums/ ; echo "exit $? (1 means clean)"
```

Replace all of this with your own work as soon as it has served its purpose.
These files are MIT licensed along with the rest of the source, unlike real
photographs, which are not.
