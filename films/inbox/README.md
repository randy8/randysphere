# films/inbox/

Drop Letterboxd's `ratings.csv` here — from Letterboxd, Settings → Data →
Export your data, then take `ratings.csv` out of the zip. The next
`pnpm sync` or `pnpm deploy` (or `pnpm films:import` on its own) keeps the
five-star rows, rewrites `films/five-star-ratings.csv`, and fetches posters
for any new films. `/pictures/` updates on that deploy.

The CSV here is git-ignored (it holds every rating, not just five-star
ones) and can stay: re-importing the same file changes nothing.
