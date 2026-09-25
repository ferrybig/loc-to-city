# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CGEODATA: a binary reverse-geocoding format (spec in `binary-format.md`) that
resolves a GPS point to city/region/country from real OpenStreetMap
administrative boundaries, replacing nearest-labeled-point lookups (which
get it wrong near borders — see README's "Why nearest-point is wrong"). The
target consumer is Immich (Node.js), which is why the reader has zero
runtime dependencies.

`README.md` is split in two: everything up to "Historical record: the
Python prototype" describes the current, working system; everything after
that is a deleted Python prototype kept only as a record of what was
measured and where the format/algorithms came from. Don't resurrect deleted
`scripts/`/`webapp/` code or reference it as if it still exists.

## Workspaces

Four npm workspaces (Node >=26, see `.nvmrc`), all TypeScript, ESM
(`NodeNext`), `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes` in `tsconfig.base.json`:

- **`reader/`** — the format's reference reader. Zero runtime dependencies
  besides Node's built-in `zlib`. Tested byte-for-byte against
  `binary-format.md`'s Appendix A worked example, not just self-consistency
  with the compressor.
- **`compressor/`** — turns a GeoJSON of city/region/country polygons plus a
  place-hierarchy JSON into a `.bin` file. Free to use real dependencies
  (`@turf/*`, `rbush`) since it only runs at build time. Exposes its types
  (`CityProperties`, `HierarchyCountry`, ...) as a package so `data-ingest`
  imports them instead of reaching into `compressor/src/`.
- **`data-ingest/`** — owns everything OSM-shaped: raw `.osm.pbf` extracts
  (`data-ingest/osm/`, gitignored) and osmium's exported intermediate
  GeoJSON (`data-ingest/work*/`, gitignored), plus the scripts that turn
  those into whatever a specific compressor run needs. Outputs land in
  `data/`, which is what you point the compressor at.
- **`demo/`** — a click-to-query Leaflet page plus a grid tile overlay.

## Commands

```bash
npm install                                # installs all four workspaces
npm run build --workspaces                 # tsc for each package
npm test -w reader                         # Appendix A conformance + varint/Morton unit tests
npm test -w compressor                     # synthetic-dataset unit tests + real-data tests
npm test -w demo                           # unit tests (not e2e)
```

Each workspace's test script is `tsx --test test/*.test.ts` (Node's built-in
test runner, no Jest/Vitest). To run a single test file directly:

```bash
npx tsx --test compressor/test/geometry.test.ts
```

`data-ingest` has no `test` script — it's ingest scripts, not a tested
library; validate it by running a scoped build (see below) and reading its
diagnostic output.

Demo e2e (spins up its own server against `data/zuid-holland.bin` on
:8767, per `demo/playwright.config.ts`):

```bash
cd demo && npx playwright install chromium && npx playwright test
```

### Reading a `.bin` file

`reader/src/cli.ts` (installed as `cgeodata`) is a thin layer over
`CGeoDataReader`'s public API -- anything the CLI can do, a library
consumer (Immich, the demo) can do through the same methods
(`query`, `place`, `places`, `search`, `chunkRecords`, ...). Add
capability to the reader first, then expose it as a subcommand:

```bash
npx tsx reader/src/cli.ts help                              # or help <command>
npx tsx reader/src/cli.ts info   data/world.bin             # header, counts, byte split, largest chunks
npx tsx reader/src/cli.ts lookup data/world.bin 52.37,4.9   # no points -> read them from stdin
npx tsx reader/src/cli.ts list   data/world.bin --level city --country nl --tree
npx tsx reader/src/cli.ts search data/world.bin amst        # exit 1 when nothing matched (grep-style)
npx tsx reader/src/cli.ts search data/world.bin amsterdam --sort  # rank by relevance, not id order
npx tsx reader/src/cli.ts show   data/world.bin 192858      # a place id from any other command
npx tsx reader/src/cli.ts chunk  data/world.bin 3232        # the chunk index lookup printed
```

`<file.bin>` may be `-` for stdin. `search` is a linear scan over the
name blocks unless a text search index (`binary-format.md` Appendix B,
built by `build-search-index --output <file>`) is attached with
`CGeoDataReader.useSearchIndex()` (the CLI's `--index`); the index only
narrows which cities get checked, so results must stay identical with
and without it -- `reader/test/searchIndex.test.ts` asserts that. The
demo server picks up `<dataset>.search-index.bin` next to its `.bin`
automatically. `--sort` scores each match -- exact name match beats
whole-word match beats plain substring, city beats region beats country
(`nameMatchQuality`/`LEVEL_BONUS` in `reader/src/reader.ts`) -- and has
to score every match before yielding any, since the best one isn't
necessarily the first found; plain `search` keeps the cheaper early-exit
scan when `--limit` is given without `--sort`.

Also runnable as `npm run reader -- <subcommand> ...` (the `--` is
required so npm forwards args instead of eating them).

**Use `lookup`/`show`/`search` against `data/world.bin` to spot-check
`COUNTRY_ADMIN_LEVELS` changes** (`data-ingest/src/lib/countryAdminLevels.ts`)
before trusting a coverage-percentage comment: the auto-detected level
that best tessellates a country by area isn't always the level whose
*names* are the ones a lookup should return (see the US county-vs-
incorporated-place and Canada regional-district-vs-city entries in
README.md's "Known issues and open work" section). A quick loop —
`npm run reader -- lookup data/world.bin <lat,lon>` against a handful of
well-known cities in the country just changed — catches a wrong city name
(or a `city` that's empty because gap-fill couldn't cover it) far faster
than rebuilding and diffing the full cities500-style match-rate script.

### Building a `.bin` file

`compressor/src/cli.ts` (installed as `cgeodata-compress`) takes a
hierarchy JSON, a cities GeoJSON/`.geojsonseq`, an output path, and
`--regions`/`--countries` GeoJSON:

```bash
npx tsx compressor/src/cli.ts <hierarchy.json> <cities.geojson|.geojsonseq> <out.bin> \
  --regions <regions.geojson> --countries <countries.geojson> \
  --width-exp 6 --height-exp 6 --max-depth N --keyframe-exp 13 \
  --attribution "..." --workers N [--only-chunks LIST]
```

- `--only-chunks` takes indices/ranges (`200` or `200,300-500`) and leaves
  every other chunk empty — doesn't touch country/region/city resolution,
  just skips the (expensive) chunk-compression stage. `--only-chunks ''`
  builds just the place table, useful for inspecting record counts on a
  huge dataset without paying for chunk compression at all (a ~2s local
  build against the worldwide inputs — `data/world_no_chunk.bin` is a
  gitignored, regenerate-on-demand artifact, not committed, since it goes
  stale the moment `world-hierarchy.json`/cities/regions change and costs
  nothing to rebuild).
- `--workers N` spreads chunk work across `node:worker_threads` (`0` = the
  original sequential path, kept as the byte-identity oracle parallel
  output is checked against; `1` still spawns a real worker, isolating
  serialization overhead as a genuine A/B control). Output is byte-for-byte
  identical at every worker count — this is asserted in
  `compressor/test/parallel.test.ts`, so don't casually change tie-break or
  ordering logic in `quadtree.ts`/`chunkWorkerPool.ts` without rerunning it.

Existing small/medium datasets to build against, in increasing size:
`data-ingest/src/prepare-zuid-holland.ts` → `data/zuid-holland.bin`,
`data-ingest/src/prepare-europe.ts` → `data/europe.bin`,
`data-ingest/src/prepare-world.ts` (invoked via
`data-ingest/scripts/build-world.sh`) → `data/world.bin`. Rerunning the
worldwide build is multi-hour and memory-heavy (see below) — prefer the
Zuid-Holland or Europe build when iterating on compressor logic.

### Worldwide extraction/build pipeline

```bash
data-ingest/scripts/build-world.sh                          # everything in data-ingest/osm/
data-ingest/scripts/build-world.sh australia-oceania-260918  # one continent, end to end
```

Runs `extract-boundaries.sh` (osmium, via the `loc2city-tools` Docker
image — `docker build -t loc2city-tools -f Dockerfile.tools .`), then
`prepare-world.ts`, then the compressor CLI. Extraction skips any file
whose output is already newer than its input, so swapping one `.osm.pbf`
and re-running only re-extracts that file; file discovery is by glob, not
a hardcoded continent list. Positional args scope both the extraction and
the run to a subset of `.osm.pbf` basenames, for staged verification
before a full rebuild.

## Architecture notes that span multiple files

**Format is meta-chunked.** The world is sharded into a `width_exp` ×
`height_exp` grid of independently-decompressible chunks; a lookup only
ever touches one chunk plus the place table, never the whole file. Within
a chunk, places are laid out on an adaptive Morton/Z-order quadtree, refined
up to `max-depth`. Country → region → city hierarchy is stored as
delta-coded counts plus keyframe-compressed name blocks (`nameBlocks.ts`)
so names resolve by id without decompressing the whole list. Read
`binary-format.md` for the actual spec before changing wire format code in
`reader/` or `compressor/src/writer.ts`.

**Compressor pipeline** (`buildCore.ts` orchestrates):
`candidateIndex.ts` builds an rbush-indexed candidate list (cities +
regions + country, via `regionCountryCandidates.ts`) → `chunkJobs.ts`
enumerates one job per non-empty chunk → `quadtree.ts`'s
`buildChunkRecords` recursively subdivides each chunk, classifying
candidates against cells via `geometry.ts`'s `classifyCell` → `chunkEncoder.ts`
encodes the resulting records → `writer.ts` assembles the final buffer.
`build.ts` runs this sequentially; `buildParallel.ts` +
`chunkWorkerPool.ts` + `chunkWorker.ts` run the same per-chunk work across
`node:worker_threads`, dispatching worst-first (chunk cost varies up to
~1000x) and reporting `onChunkBuilt` incrementally as each worker's result
lands — not batched until the end, which matters on an hours-long build.
Candidate array order is significant: `quadtree.ts` breaks containment/
depth ties by first-in-array-wins, so anything that reorders candidates
(a `Set`/`Map` round-trip, a sort) can silently change output for
ambiguous cells.

**`geometry.ts`'s `classifyCell`** replaced turf's `booleanContains`/
`booleanIntersects` — those gave wrong answers on multi-part polygons at
country/region scale (verified: turf claimed full containment where
sampled points fell outside). It's a segment/rectangle classifier
(Liang-Barsky clipping) that distinguishes a boundary merely grazing a
cell edge (`CONTACT_GRAZE`, doesn't rule out containment) from one cutting
through the interior (`CONTACT_INTERIOR`, does). Tested against
densely-sampled ground truth, not against turf, since turf is what was
being replaced for being wrong.

**Data-ingest's 3-pass admin_level detection** (`adminLevelDetection.ts`,
ported from a deleted Python prototype): accumulate polygon area by
`(country, admin_level)` for levels 5–11, pick the finest level covering
≥60% of that country's Natural Earth area as the "primary" division for
that country, gap-fill anything a primary doesn't cover by representative-
point containment; if no level clears 60%, fall back to whichever has the
single largest share. This is why different countries resolve at wildly
different real-world granularity (USA → counties, France → communes,
Australia → gazetted localities) — the algorithm is finding whatever OSM
admin level actually tessellates each country, not applying one fixed
level worldwide.

**Multi-file country handling.** OSM relations for a single country (e.g.
Russia, Turkey) can be split across multiple continent extract files with
zero overlap — each file has a complete, non-overlapping slice. Resolved
by `mergeAdminBoundaries.ts` deduplicating by relation id across every
file (`osmium export --add-unique-id type_id` — the id is a deterministic
`"a<id>"`-style area id, not `"r..."`), not by any per-country priority
list.

**Node's size limits shaped `compressor/src/cities.ts` and
`prepare-world.ts`.** `readFileSync` refuses files over 2GiB even as a
Buffer, and `JSON.parse` can't handle a string over
`buffer.constants.MAX_STRING_LENGTH` (~512MB) — both hit hard at world
scale (the city layer is ~4GB). `cities.ts`'s `loadCities` streams a
GeoJSON Text Sequence (`.geojsonseq`, RS-delimited) record-by-record
instead, falling back to plain `JSON.parse` for smaller `.geojson`
inputs. `prepare-world.ts` batches primary-geometry loading by country
(largest countries first, into the smallest batch) against a live RSS
guardrail, because holding every country's primary geometry at once was
measured to exceed available memory before output was even close to
done — the guardrail fails fast with an actionable message rather than
letting the whole machine OOM.

**Memory-constrained runs**: use
`systemd-run --user --scope -p MemoryMax=<N>` around a build, and set `N`
*below* what the system can actually spare — too high and the kernel's
global OOM killer fires and can kill unrelated processes instead of
containing the one that's over budget.
