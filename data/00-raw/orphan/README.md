# Orphan input (resolved)

`nl_cities.geojson` (and, until 2026-09-28, `eu_cities.geojson`) was
produced by `scripts/extract_boundaries.py` /
`scripts/extract_boundaries_europe.py` — the Python prototype documented
in the root `history.md`, deleted once the
TypeScript pipeline superseded it. This repo's `CLAUDE.md` explicitly
forbids resurrecting that deleted code, so nothing regenerates either
file. Both were OSM `admin_level=10` ("woonplaats"-equivalent) polygons,
spatially resolved to their containing municipality/region —
`nl_cities.geojson` is 2,521 Dutch woonplaats features, `eu_cities.geojson`
was the same idea at European scale (202k features). See root
`README.md`'s "Data source" section for the exact original extraction
method.

**This is no longer load-bearing.** Investigating the irreplaceability
and (for `eu_cities.geojson`, 313MB — too big for GitHub, so it was
gitignored with no git backup) backup-risk problem found that
`data/03-final/world.bin`'s worldwide pipeline already resolves the
Netherlands and Europe at least as well as these files did — e.g. Utrecht
gets a real city name in `world.bin` where the old Zuid-Holland fixture
had no city data there at all (it only ever had Zuid-Holland province's
187 cities). `data-ingest/src/prepare-world.ts`'s generic per-country
`COUNTRY_ADMIN_LEVELS` resolution (`NL: { city: [10] }`, the same OSM
level these files' data came from) already does the same job, for every
country in the world.

`data-ingest/src/filter-by-scope.ts` was built to replace both
`prepare-zuid-holland.ts` and `prepare-europe.ts` with a single tool that
filters `prepare-world.ts`'s already-resolved worldwide output down to a
country or continent scope. `data/03-final/zuid-holland.bin` and
`data/03-final/europe.bin` are now both built this way — see
`data-ingest/PIPELINE-STAGES.md`'s "Why prepare-zuid-holland.ts/
prepare-europe.ts were deleted" section for the full story.

**As a result:** `prepare-europe.ts` (the only thing that ever read
`eu_cities.geojson`) was deleted, and `eu_cities.geojson` along with it —
it was gitignored, so it's not recoverable from git, only from whatever
copies exist outside this repo. `nl_cities.geojson` is gitignored too
(2026-09-28, alongside a history rewrite that dropped it and
`data/02-resolved/*` from git entirely, since neither is read by
anything any more) — it still exists on disk here but is no longer
committed, kept only in case it's useful as a reference sample of what
the deleted Python prototype's output looked like.
