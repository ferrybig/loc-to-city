# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CGEODATA: a binary reverse-geocoding format (spec in `reader/binary-format.md`) that
resolves a GPS point to city/region/country from real OpenStreetMap
administrative boundaries, replacing nearest-labeled-point lookups (which
get it wrong near borders — see README's "Why nearest-point is wrong"). The
target consumer is Immich (Node.js), which is why the reader has zero
runtime dependencies.

`README.md` describes the current, working system. `history.md` is what the
deleted Python prototype (`scripts/`, `webapp/`) taught us, kept only as a
record of what was measured and where the format/algorithms came from. Don't
resurrect deleted `scripts/`/`webapp/` code or reference it as if it still
exists.

`countries.md` is the per-country ledger: which `admin_level` each country
resolves at, every override/fallback and the measurement behind it, and the
known-wrong places. **Any change to `countryAdminLevels.ts`, a Voronoi
fallback list, or how a country is resolved must be recorded in that
country's section there** (including attempts that were reverted). Open
problems end their title with `*(open)*` (also `*(unsolvable)*`,
`*(human error)*`, `*(false positive)*`), so
`grep -n '\*(open)\*' countries.md` lists the work. Spot-check coordinates
in it are mirrored in `verify/src/cases.ts` (run by
`verify/test/world-queries.test.ts`): each case carries the ledger `status`
(`fixed`, `false-positive`, `open`, `unsolvable`, `human-error`) and the
`section`/`entry` it belongs to. Fixed and false-positive places are plain
tests, the others are `todo` tests; when you fix one, change its `status`
(a `todo` that starts passing prints `NOW PASSING`).
`verify/test/ledger.test.ts` fails when a case's section or entry is not in
this file, or its status disagrees with the entry's marker. The same
results are exported as JSON and drawn as markers on the demo's map (see
`verify/` below).

## Workspaces

Five npm workspaces (Node >=26, see `.nvmrc`), all TypeScript, ESM
(`NodeNext`), `strict` + `noUncheckedIndexedAccess` +
`exactOptionalPropertyTypes` in `tsconfig.base.json`:

- **`reader/`** — the format's reference reader. Zero runtime dependencies
  besides Node's built-in `zlib`. Tested byte-for-byte against
  `reader/binary-format.md`'s Appendix A worked example, not just self-consistency
  with the compressor.
- **`compressor/`** — turns a GeoJSON of city/region/country polygons plus a
  place-hierarchy JSON into a `.bin` file. Free to use real dependencies
  (`@turf/*`, `rbush`) since it only runs at build time. Exposes its types
  (`CityProperties`, `HierarchyCountry`, ...) as a package so `data-ingest`
  imports them instead of reaching into `compressor/src/`.
- **`data-ingest/`** — owns everything OSM-shaped: raw `.osm.pbf` extracts
  (`data/00-raw/osm/`, gitignored) and osmium's exported intermediate
  GeoJSON (`data/01-extracted/`, gitignored), plus the scripts that turn
  those into whatever a specific compressor run needs. See
  `data-ingest/PIPELINE-STAGES.md` for the full `data/` directory layout
  (`00-raw` → `01-extracted` → `02-resolved` → `03-final`) and file
  dependency graph. Outputs land in `data/02-resolved/`, which is what you
  point the compressor at.
- **`verify/`** — the spot-checks of the worldwide build: `src/cases.ts`
  is the data (every place `countries.md` documents, plus every country's
  capital), `src/evaluate.ts` runs a case against a reader and says how it
  turned out (`verified`, `regression`, `open`, `known-wrong`,
  `report-upstream`, `now-passing`), `test/` asserts them and checks them
  against `countries.md`, and `src/export.ts` writes the results as
  `<name>.checks.json`, which the demo picks up next to the `.bin` it serves
  and draws as markers. It reads a finished `.bin`, so it sits after
  `data/03-final/` in the pipeline, and depends on the reader only.
- **`demo/`** — an Express server: a click-to-query Leaflet page plus a
  grid tile overlay, the reader's TypeDoc output under `/docs/` (when
  built), and the dataset plus the sidecar indexes in use under
  `/download/`. The page's source is `demo/web/` (an HTML template,
  TypeScript modules, one stylesheet; `tsc -p web/tsconfig.json` in
  `typecheck`), which `src/buildWeb.ts` bundles with esbuild, Leaflet
  included, into `dist/public/index.html` and content-hashed
  `dist/assets/main-<hash>.{js,css}` served as immutable, so a page load
  revalidates only the HTML. `npm run build -w demo` builds it; the dev
  server (`node src/server.ts`, run as TypeScript) builds it at startup and
  rebuilds on every edit (reload to see one). Static files and downloads
  are served from disk; `npm run prepare-static -w demo -- [dir...]` (the
  Docker build runs it) writes `.br` files and a content-hash
  `.etags.json` per directory. Don't run it in a dev checkout: its output
  goes stale on the next edit (a page rebuild removes it from
  `dist/`, but not from `reader/docs/`).

## Code style: tabs

Indent with tabs. `reader/` and `demo/` are formatted by biome
(`npx biome format --write reader demo`, enabled per directory in
`biome.json`'s `overrides`); `compressor/` and `data-ingest/` are still
two-space and not yet under the formatter. Pure reformatting commits go
in `.git-blame-ignore-revs`.

**Reading tab-indented files with the Read tool**: each output line is
`<line number><TAB><line content>`, so the *first* tab after the number
is the tool's separator and every tab after it is the file's own
indentation. With `⇥` for a tab, `244⇥⇥⇥const NX` is a line indented by
**two** tabs, not three -- easy to miscount deep in a file, where a
two-tab method body looks like the separator plus one. When copying a line into an `Edit`
`old_string`, drop the number and exactly one tab. If in doubt, `sed -n
'244p' file | cat -A` shows each tab as `^I`.

## Commands

```bash
npm install                                # installs all five workspaces
npm run build --workspaces                 # tsc for each package
npm run typecheck                          # tsc over src/ + test/ for each package (needs a build first)
npm test -w reader                         # Appendix A conformance, unit tests, and the main entry in headless Chromium
npm run docs -w reader                     # TypeDoc API reference -> reader/docs/ (fails on any undocumented export)
npm run bench -w reader -- <file.bin>      # performance baseline; compare before/after reader I/O or API changes
npm test -w compressor                     # synthetic-dataset unit tests + real-data tests
npm test -w demo                           # unit tests (not e2e)
npm test -w verify                         # world spot-checks against world-high-res.bin, else world.bin; CGEODATA_WORLD_BIN overrides (skipped without one) + ledger consistency
node verify/src/export.ts data/03-final/world-high-res.bin --out data/03-final/world-high-res.checks.json
                                           # the same checks as JSON; the demo draws them as markers
```

Each workspace's test script is `node --test test/*.test.ts` (Node's built-in
test runner, no Jest/Vitest; Node >=26 strips TypeScript types natively, no
`tsx`/`ts-node` dependency). To run a single test file directly:

```bash
node --test compressor/test/geometry.test.ts
```

`npm test -w data-ingest` covers the pure, library-shaped parts only
(`adminLevelDetection`, `placeTagSignal`, `cities500`, `admin1Codes`,
`polygonCountry`, `voronoiFallback`, `geojsonseqStream`, `pointOnFeature`,
`osmCountryBorders`, `duplicateGeometries`); the ingest scripts themselves have
no test coverage — validate those by running a scoped build (see below)
and reading their diagnostic output.

Demo e2e (spins up its own server on :8767, per
`demo/playwright.config.ts`) runs against the committed
`data/03-final/appendix-a-example.bin`, the spec's Appendix A worked
example, so it needs no build: seven places on a 2x2 chunk grid, of which
only Nederland, Noord-Holland and Zaandam have cells (Section A.5 works
out the lookups the tests click). Its spot-check markers come from the
hand-written `demo/e2e/fixtures/appendix-a-example.checks.json`. The config
starts the browser with the page's OpenStreetMap base map switched off
(a `localStorage` setting), so cacheless test browsers never fetch OSM's
tiles. `demo/test/tiles.test.ts`'s real-data case still needs
`data/03-final/zuid-holland.bin` (`make netherlands`) and skips without it.

```bash
cd demo && npx playwright install chromium && npx playwright test
```

### Deploying the demo

`./deploy.sh` builds the Docker image (serving
`data/03-final/world-high-res.bin` unless `DATASET=<name>` is given),
ships it to geodata.ferrybig.nl and restarts it there. When pointing the
user at places to check after a deploy, link them with the map's
`#map=zoom/lat/lon` hash (`demo/web/viewHash.ts`), e.g.
[Campione d'Italia](https://geodata.ferrybig.nl/#map=12/45.9694/8.9736).

### Reading a `.bin` file

`reader/src/cli.ts` (installed as `cgeodata`) is a thin layer over
`CGeoDataReader`'s public API -- anything the CLI can do, a library
consumer (Immich, the demo) can do through the same methods
(`query`, `place`, `places`, `search`, `chunkRecords`, ...). Add
capability to the reader first, then expose it as a subcommand:

The package has four entry points: `.` (`src/index.ts`: the reader,
its result types, errors and byte sources -- keep it small, it's what a
consumer reads first), `./node` (`src/node.ts`), `./indexes` (the
search/locate index classes and builders) and `./format` (`src/format.ts`:
spec-level codecs the compressor and low-level tests use, no stability
promise). Add an export to the narrowest one that works.

The reader's API is async and platform-neutral: nothing under
`reader/src/` imports `node:*` except `node.ts` (`openFile`,
`FileSource`, `nodeInflater`, the `*PathFor` sidecar helpers -- the
package's `./node` export) and `cli/`. Bytes come from a `ByteSource`
(`source.ts`), blocks are inflated by an `Inflater` (`inflate.ts`;
`DecompressionStream` by default, sync zlib on Node). Choices that were
measured (`reader/bench/bench.ts`, see the commit messages) and are easy
to undo by accident: file reads are async but Node's inflate is sync
(async zlib cost 15-40% on tile bursts for no gain, since parsing
dominates); decodes take turns one macrotask each (`turns.ts`), or
concurrent lookups block the event loop for the whole batch; hot loops
use `lookupCached() ?? await lookup()` so a cache hit never awaits;
decoded chunks hold codes in a `Uint32Array` and palette indices only
as wide as the file stores them, since decoded chunks are what fills
the cache; and those codes decode through their own
`readDeltaVarints32Into`, not a `readDeltaVarintsInto` taking either
array (one function seeing both parsed ~8% slower than with
`Float64Array` alone, two parse ~20% faster). The reader rejects files
deeper than `max_depth` 16 (`MAX_SUPPORTED_DEPTH`, a
`CGeoDataUnsupportedError`), though the format allows 26: a chunk is
one zlib block a lookup inflates whole, so deeper chunks only make
lookups slower (finer cells should come from a bigger chunk grid), and
32-bit codes depend on it.

Chunks of 64+ records decode through a WebAssembly
SIMD fast path (`reader/wasm/chunkDecoder.wat`, ~5x the JavaScript
parser): `npm run build:wasm -w reader` compiles it into the committed
`src/chunkDecoderWasm.ts` (wabt is a devDependency only), and
`test/chunkDecoder.test.ts` fails when that file is stale. The `.wat`
never reports an error: it accepts a block or declines it, and a
declined one is parsed again by `parseChunk`'s JavaScript path, which
stays the oracle (like the compressor's `--workers 0`) and the only
source of errors. So the `.wat` must never accept a block JavaScript
rejects; the test checks that against thousands of corrupted chunks,
and every check in the `.wat` is one that test fails without (break
it, rebuild, rerun to see). Its memory is reused while decodes follow
each other and dropped after a second idle (`chunkDecoder.ts`), so an
idle reader holds none. `CGEODATA_BENCH_WASM=0` benches without it.

How much slowdown a reader change may cost: a change that buys something
(a non-blocking event loop, browser support, bounded memory) may cost
~10-15%; "everything 2x as slow" is not acceptable. A cold single lookup up
to ~50 ms is fine now that it is awaited instead of blocking. **The demo's
tile burst is the metric that matters most** (see the comment above the
worker pool in `demo/src/server.ts`): run `npm run bench -w reader --
<file.bin>` (burst section first) before and after, put the numbers in the
commit message, and if a change costs more than ~15% on bursts, find a
cheaper variant or ask before keeping it. Async zlib (+15-40%) was dropped
on this rule, async file reads (+~10%) kept.

```bash
node reader/src/cli.ts help                              # or help <command>
node reader/src/cli.ts info   data/03-final/world.bin             # header, counts, byte split, largest chunks
node reader/src/cli.ts lookup data/03-final/world.bin 52.37,4.9   # no points -> read them from stdin
node reader/src/cli.ts list   data/03-final/world.bin --level city --country nl --tree
node reader/src/cli.ts search data/03-final/world.bin amst        # exit 1 when nothing matched (grep-style)
node reader/src/cli.ts search data/03-final/world.bin amsterdam --sort  # rank by relevance, not id order
node reader/src/cli.ts show   data/03-final/world.bin 192858      # a place id from any other command
node reader/src/cli.ts chunk  data/03-final/world.bin 3232        # the chunk index lookup printed
node reader/src/cli.ts locate data/03-final/world.bin 309463      # a representative lat, lon per place id
```

`<file.bin>` may be `-` for stdin. `search` is a linear scan over the
name blocks unless a trigram search index (`reader/binary-format.md` Appendix B,
`reader/src/searchIndex.ts`) is in use: its trigram lists narrow queries
of 3+ characters to candidate places, and its short-query table answers
sorted 1-2 character searches with `--limit` up to its top count (5) and
no filters outright. A reader opened with `openFile()` picks up
`<name>.search-index.bin` next to it (`build-search-index <file.bin>
--output data/<name>.search-index.bin`) on the first search, reading
only the lists a query needs; `useSearchIndex()` (the CLI's `--index` /
`--no-index`) overrides that. A stale index next to the file makes
`search` throw rather than silently fall back. The index only narrows
which places get checked, so results must stay identical with and
without it -- `reader/test/searchIndex.test.ts` asserts that, and
builds Appendix B.12's worked example byte for byte; compare timings
against `--no-index`. Matching and ranking both fold diacritics
(`foldDiacritics`, NFD + strip combining marks + lowercase -- distinct
from `foldSymbols`'s heavier, trigram-only folding, which also buckets
digits/punctuation together and would be too loose for deciding how well
something matches): `search data/03-final/world.bin munchen` finds
München. `--sort` scores each match in Appendix B.5's relevance order --
exact match beats whole-word match beats plain substring, each tier
further split by whether the query's own spelling (not just its folded
form) already reached it, then country beats city beats region
(`reader/src/relevance.ts`, shared by the search and the short-query
table builder, which must rank identically) -- and has to score every
match before yielding any, since the best one isn't necessarily the
first found; plain `search` keeps the cheaper early-exit scan when
`--limit` is given without `--sort`. A sorted 1-2 character query only
reads the short-query table when its own text needs no folding (an
accented short query like `ë` always falls back to a live scan, since
the table is keyed and scored by each key's own already-folded spelling,
which can't represent the bonus a differently-spelled live query would
get -- see Appendix B.6).

**With a locate index attached, `--sort` ranks by area instead**
(Appendix B.5.1, `compareAreaRelevance`):
1. folded tier;
2. country first;
3. "rank area", a region taking that of its largest same-named city;
4. spelling bonus;
5. city before region;
6. id.

This is `areaTieBreak: "auto"` (CLI `--area-tie-break auto|on|off`). It
is the one deliberate exception to "index and scan agree": a locate
index changes the *order* (never the set) of sorted results. Don't "fix"
that with a chunk-scan fallback for the areas, which costs 5-10 s and was
rejected (sidecars are built wherever the `.bin` is used). A search
index records the order its short-query table was built in
(`relevance_rule`). The reader only uses the table when it ranks the
same way, so build the locate index *before* the search index, whose
`"auto"` follows whether one is attached. A rule-1 index is checksummed
over the whole prefix (header + directory + place table), not just the
place table. A text with commas (`Paris, Texas`, Appendix B.13,
`parseQualifiedQuery`) is matched as the whole text and as head plus
ancestor contexts, nearest first. Each head uses the trigram index on
its own, and comma queries never use the short-query table.

`locate` (and `search --locate`) returns the centre of a place's
representative cell (`reader/binary-format.md` Section C.3): the area-weighted
per-axis median of the cells of the place *and everything under it*
(a country's regions and cities count), moved to the nearest cell inside
that area if the median falls outside it -- so `query()` at the point
always resolves to the place or a descendant. Computing it decodes every
chunk (one place: ~0.5s on `data/03-final/world.bin`, ~3.5s on
`world-high-res.bin`); a locate index (Appendix C,
`build-locate-index <file.bin> --output data/<name>.locate-index.bin`,
~7s for `world.bin`, ~90-100s for `world-high-res.bin`, one fixed-width
entry per place id plus one area byte each, Section C.3's `1 + floor(4 log2 cells)` of the subtree, which `locate()` returns as
`area` in square degrees) makes it one small read, and
is picked up next to the `.bin` and overridden (`useLocateIndex()`,
`--index`/`--no-index`) exactly like the search index. Index and scan
must agree -- `reader/test/locateIndex.test.ts` asserts that on every
place of `data/03-final/zuid-holland.bin`, and its builder output byte-for-byte
against Appendix C.8. The builder reads chunks with `chunk(i, { cache:
false })`, so a one-pass walk doesn't evict everything lookups had
cached. The reader's cache is an LRU under a byte budget
(`open(input, { cacheBytes })`, default 64 MiB, `reader/src/cache.ts`)
shared by decoded chunks and name blocks.

Also runnable as `npm run reader -- <subcommand> ...` (the `--` is
required so npm forwards args instead of eating them).

**Use `lookup`/`show`/`search` against `data/03-final/world.bin` to spot-check
`COUNTRY_ADMIN_LEVELS` changes** (`data-ingest/src/lib/countryAdminLevels.ts`)
before trusting a coverage-percentage comment: the auto-detected level
that best tessellates a country by area isn't always the level whose
*names* are the ones a lookup should return (see the US county-vs-
incorporated-place and Canada regional-district-vs-city entries in
`countries.md`). A quick loop —
`npm run reader -- lookup data/03-final/world.bin <lat,lon>` against a handful of
well-known cities in the country just changed — catches a wrong city name
(or a `city` that's empty because gap-fill couldn't cover it) far faster
than rebuilding and diffing the full cities500-style match-rate script.

### Building a `.bin` file

`compressor/src/cli.ts` (installed as `cgeodata-compress`) takes a
hierarchy JSON, a cities GeoJSON/`.geojsonseq`, an output path, and
`--regions`/`--countries` GeoJSON:

```bash
node compressor/src/cli.ts <hierarchy.json> <cities.geojson|.geojsonseq> <out.bin> \
  --regions <regions.geojson[seq]> --countries <countries.geojson> \
  --width-exp 6 --height-exp 6 --max-depth N --keyframe-exp 7 \
  --attribution "..." --workers N [--only-chunks LIST] [--unlock-depth-limit]
```

- `--only-chunks` takes indices/ranges (`200` or `200,300-500`) and leaves
  every other chunk empty — doesn't touch country/region/city resolution,
  just skips the (expensive) chunk-compression stage. `--only-chunks ''`
  builds just the place table, useful for inspecting record counts on a
  huge dataset without paying for chunk compression at all (a ~2s local
  build against the worldwide inputs — `data/03-final/world_no_chunk.bin` is a
  gitignored, regenerate-on-demand artifact, not committed, since it goes
  stale the moment `world-hierarchy.json`/cities/regions change and costs
  nothing to rebuild).
- `--max-depth` above 16 is an error unless `--unlock-depth-limit` is
  given: the reader refuses such files (`MAX_SUPPORTED_DEPTH`), since a
  lookup inflates a whole chunk and deeper chunks only make that slower.
  For finer cells, raise `--width-exp`/`--height-exp` instead.
- `--workers N` spreads chunk work across `node:worker_threads` (`0` = the
  original sequential path, kept as the byte-identity oracle parallel
  output is checked against; `1` still spawns a real worker, isolating
  serialization overhead as a genuine A/B control). Output is byte-for-byte
  identical at every worker count — this is asserted in
  `compressor/test/parallel.test.ts`, so don't casually change tie-break or
  ordering logic in `quadtree.ts`/`chunkWorkerPool.ts` without rerunning it.

Existing small/medium datasets to build against, in increasing size:
`make netherlands` (`filter-by-scope.ts --only-country NL`, filtered from
the worldwide pipeline's own output, see `data-ingest/PIPELINE-STAGES.md`)
→ `data/03-final/zuid-holland.bin`, `make europe`
(`filter-by-scope.ts --only-continent Europe`) → `data/03-final/europe.bin`,
`make world` (`data-ingest/src/prepare-world.ts` +
`compressor/src/cli.ts`) → `data/03-final/world.bin`. A worldwide build
(`prepare-world.ts` + `data/02-resolved/world/*`) must exist before either
scoped one can be filtered from it — `make` builds it as a prerequisite
automatically. The worldwide compressor step (`world.bin` from
already-resolved `data/02-resolved/world/*`) takes ~53s wall / ~6.5min CPU
at `--workers 16` on a 4.7GHz CPU, peaking at ~7.6GB resident (main thread
and workers together) — it used to take over an hour at `--workers 2` and
16GB (the first worldwide run recorded in README.md), and the output is byte-identical
(`cmp`-verified) to the old build. Download, osmium extraction and
`prepare-world.ts` are separate stages that this speedup didn't touch, so a
from-scratch `make world` is still long and memory-heavy (see below). To
iterate on compressor logic, rebuild just `world.bin` from existing
`02-resolved` output, or use `make netherlands`/`make europe` for a smaller
dataset.

### Worldwide extraction/build pipeline

```bash
make world    # download planet.osm.pbf + geonames/natural-earth, build the
              # Docker extraction image, extract, resolve, and compress --
              # whatever's already up to date is skipped
```

Each stage is also reachable on its own: `make download` (raw inputs only),
`make extract` (boundary extraction only), `make docker-image` (just the
`loc2city-tools` image). There's no more per-continent scoping at the
extraction stage — `data/00-raw/osm/` holds a single whole-planet
`planet-latest.osm.pbf` now, not per-continent Geofabrik extracts (see
`data-ingest/PIPELINE-STAGES.md`).

Runs `extract-boundaries.sh` (osmium, via the `loc2city-tools` Docker
image — `docker build -t loc2city-tools -f Dockerfile.tools .`), then
`prepare-world.ts`, then the compressor CLI. Extraction skips any file
whose output is already newer than its input, so swapping one `.osm.pbf`
and re-running only re-extracts that file; file discovery is by glob, not
a hardcoded continent list. `make` itself takes no scoping arguments —
for staged verification, run `data-ingest/scripts/extract-boundaries.sh
<basename>...` directly, which still scopes extraction to a subset of
`.osm.pbf` basenames.

**What the Makefile treats as out of date.** `node_modules` is an
order-only prerequisite (`| node_modules`): make still runs `npm install`
when `package.json` or the lockfile changed, but a newer `node_modules` never
rebuilds anything, so an `npm install` does not restart the worldwide
resolve. Only the cheap sidecars (the two indexes, `.checks.json`) list
source files (`reader/src`, `verify/src`) as prerequisites. The resolve and
the `.bin` do not depend on `data-ingest/` or `compressor/` sources, so
after changing those, delete the output you want rebuilt. `make -n` always
shows the `.bin` rebuilding (its `.args` file is a `FORCE` target); add
`-o data/03-final/<name>.bin.args` to see what would really run. The
Dockerfile's `sidecars` stage builds the indexes from `reader/src` and the
`.bin` alone (no `npm ci`), so a lockfile change from another workspace
does not rebuild them; keep it free of anything that changes with the
lockfile.

## Architecture notes that span multiple files

**Format is meta-chunked.** The world is sharded into a `width_exp` ×
`height_exp` grid of independently-decompressible chunks; a lookup only
ever touches one chunk plus the place table, never the whole file. Within
a chunk, places are laid out on an adaptive Morton/Z-order quadtree, refined
up to `max-depth`. Country → region → city hierarchy is stored as
delta-coded counts plus keyframe-compressed name blocks (`nameBlocks.ts`)
so names resolve by id without decompressing the whole list. Read
`reader/binary-format.md` for the actual spec before changing wire format code in
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
lands — not batched until the end, which matters for progress reporting on
a big build.
Candidate array order is not significant: every pick in `quadtree.ts`
goes through `preferred` (smaller area, then finer tier, then lower
global id), a total order. It used to be first-in-array-wins, which made
the few hundred OSM relations with identical geometry flip between builds
whenever any candidate was added, since that reorders the R-tree's
search results. Keep it a total order.

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

**Coverage gap-fill** (`CountryAdminLevels.coverageGapFill`, `coverageGrid.ts`):
the representative-point test above drops a district as soon as one parish
covers its point, however much unparished town it holds (GB: Norwich,
Winchester). For the levels a country lists there, each candidate carries a
grid over its bbox that every primary clears where it contains a cell
centre, and the candidate is added when `MIN_UNCOVERED_KM2` is left. Only GB
uses it so far. It needs the compressor's max-depth rule (a candidate
crossing a cell with >= 25% of it beats one containing it), or the added
districts take every border cell between the parishes they contain.

**Borrowed `name:en`** (`CountryAdminLevels.nameEnFromWikidata`): a candidate
with no `name:en` takes it from any relation of its country with the same
`wikidata` tag, at any level (BE: Brussels' level-9 relation has none, the
level-8 City of Brussels does). Pass 1 keeps a small `NameSource` record for
every non-candidate relation of such a country that has both tags; opt-in,
only Belgium so far.

**Pinned primary level** (`CountryAdminLevels.primaryLevel`): skips the
area vote, for a country whose finest real city tier covers little (BG:
settlements at 8, 46.5%) with a coarser filler above it (municipalities at
5, in `coverageGapFill`). Without it the vote picks the filler and hides
the cities the finer tier has (Sofia).

**Region gap-fill** (`CountryAdminLevels.regionGapFill`): relations at these
levels are regions too, next to the `region` level, and the compressor and
`assignCityRegion` give a cell to the smaller of two regions, so they show only
where no primary region covers. For a country whose cities sit in holes of the
region level (PH: Metro Manila and the independent cities are not in any
province, and a city with no region is dropped; level 3 holds them). Only the
Philippines so far.

**Regions outside the region level** (`CountryAdminLevels.regionOutside`):
relations at these levels are regions only when their point lies in no region
of the chosen level (NL: of the level-8 gemeenten, only Bonaire, Saba and Sint
Eustatius, which no province holds). Their towns come from the hole fill on
those regions only (`VORONOI_CITY_FALLBACK_HOLES_IN`); GeoNames' BQ places are
read as NL (`GEONAMES_COUNTRY_OF`).

**Namesake regions** (`RegionCandidate.localName`): regions are joined to
their cities by name, so relations of one country and level that share a
name but whose bboxes do not touch (Poland's ten pairs of powiaty, e.g. two
`powiat ostrowski`) are keyed and named `name [id]` throughout ingest, and
the hierarchy's `regionLocalNames` gives the compressor the name to show.
Same-named relations whose bboxes touch are duplicates: the larger bbox wins.

**Region hole fill** (`VORONOI_REGION_HOLES`, `regionHoles.ts`): for a country
whose regions leave populated land out (Bissau, Baku's outer districts,
Karakalpakstan, Madeira), the cities500 places there get Voronoi cells (every
place of the country is a site), minus the regions, that join the region of
the nearest covered place with the same GeoNames admin1 code, or else become a
region named for the admin1. Runs before `regionIndex`, on the OSM outlines. A
country with no region at all takes its own name instead (`CITY_STATES`).

**Per-region `city` overrides** (`CountryAdminLevels.overrides`, keyed by
region name — see `countryAdminLevels.ts`'s doc comment): for the rare
case where one level doesn't fit a whole country (New York's real
municipal tier is `admin_level=7`, not the rest-of-the-US `8`). A listed
region's own `[primary, ...gapFill]` list replaces the country's `city`
vote entirely for candidates resolving to it — first level primary
unconditionally, later levels gap-fill *within that region only*. Two
flatter designs (a country-wide multi-level `city` list; a region
override with every level primary at once) were tried and both caused
measured regressions elsewhere — see `countries.md`'s United States section — because
a large candidate level can out-vote a real, smaller one it geographically
contains at their shared boundary cells once both are eligible for the
same cell; `[primary, ...gapFill]` order is what prevents that.

**Voronoi-from-cities500 fallback** (`voronoiFallback.ts`, `cities500.ts`,
`admin1Codes.ts`, `countryAdminLevels.ts`'s `VORONOI_CITY_FALLBACK`/
`VORONOI_REGION_FALLBACK`): for a country with a genuine, confirmed
absence of OSM admin polygons at the city tier (Libya, Egypt, Chad,
Eritrea — 0–0.7% coverage) or region tier (Slovenia — `region: []`), not
fixable by any `admin_level` choice unlike every per-country override
above, synthesizes polygons from `data/00-raw/geonames/cities500.txt` points
instead. Both share `computeClippedCells`: `d3-delaunay` builds the
Voronoi diagram (clipped to a bbox), `@turf/intersect` re-clips each cell
to the country's real outline. `buildCityFallback` emits one candidate
per point directly; `buildRegionFallback` groups points by GeoNames
admin1 code first (the `${countryCode}.${admin1Code}` join key
`admin1CodesASCII.txt` itself uses, read here purely for display names
since it has no coordinates in this repo) and `@turf/union`s each group's
cells into one region. `prepare-world.ts` routes a synthesized city
through the same `assignCityRegion`/`emitCity` path as a real OSM one —
it isn't a separate output shape, just an extra candidate source. The
region fallback must run *before* `finalRegions`/`regionIndex` are built
(every downstream region assignment depends on it), the city fallback
runs after everything else. Both opt-in per country (see `countries.md`'s Libya
and Slovenia sections for the full rationale,
why a fixed-radius buffer per point was rejected in favor of a real
tessellation, and a known residual limitation: a real OSM city's
`repPoint` can land in a neighboring region's Voronoi cell when that
city's own polygon is large or off-center — confirmed on Ljubljana).

**Country resolution is Natural Earth, corrected by OSM's own borders.**
`resolvePolygonCountry` (`polygonCountry.ts`) samples points against
Natural Earth, but `prepare-world.ts` first wraps that index with
`withOsmCountryBorders` (`osmCountryBorders.ts`): the corpus's own
`admin_level=2` relations, keyed by their `ISO3166-1:alpha2` tag, override
Natural Earth only where it names a country whose OSM border doesn't
contain the point while another country's does. That fixes enclaves
Natural Earth's 10m outlines don't have (Baarle-Hertog's Belgian enclaves
inside NL resolved to NL and were dropped) without letting OSM's
territorial waters or its folding of dependencies into a parent country
change anything else. Only a polygon Natural Earth places nowhere at all
(a coastal village inland of its coastline, like Ter Heijde; an atoll it
lacks) is sampled again against the drawn outlines below (`outlineAt`),
instead of being dropped. Relations tagged `natural=coastline` are never
candidates (islands with admin tags added). That is which country a
*city or region* belongs to. The country *outlines* the compressor draws are OSM's own
(`loadOsmCountryRelations`): the `admin_level=2` relation, or a
dependency's own ISO-tagged relation (Hong Kong, Puerto Rico), territorial
waters included. Where two outlines overlap (a dependency inside its
parent's, Crimea, Western Sahara), `countryOutlines.ts` cuts the overlap
out of one of them, the owner being whichever the city/region lookup above
names there -- the compressor has no rule that makes an unrelated nested
country win a cell, so an overlap left in place loses the smaller one's
cities. Natural Earth is the outline only for codes OSM has no relation
for (Palestine, Antarctica, U.S. Minor Outlying Islands). The same rule
cuts a country out of a *foreign region* that covers land the lookup gives
to the country (`cutCountriesOutOfForeignRegions`): when regions were
still simplified they lost small holes, so Lazio covered the Vatican and
Provence-Alpes-Côte d'Azur Monaco. City-states (`CITY_STATES`) get a region (and if OSM has none, a
city) covering the whole country; their cities get that region by country
code, not through `assignCityRegion`, whose answer for a point inside two
overlapping regions is the first in R-tree order -- adding regions to that
tree moves cities elsewhere. A region that is one city (`REGION_CITIES`:
Berlin, Prague, Kyiv, Moscow, ...) is emitted as a city too, and only when
no other city lies inside it.

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
inputs. `prepare-world.ts` never holds primary-city geometry at all
(holding every country's at once was measured at ~19GB): after Pass 1,
one streaming read hands each primary to `createGapFillTracker` and
writes it straight out as osmium's own geometry text, and a second read
fetches just the gap-fill cities. Both reads skip unwanted records by an
id peeked off the raw bytes (`geojsonseqStream.ts`'s
`streamGeoJSONSeqRecords`/`peekFeatureId`), so only Pass 1 parses the
whole corpus. A primary only counts as covering a gap-fill candidate of
its own country.

**`prepare-world.ts` runs on worker threads, with byte-identical output.**
A worldwide run takes ~2.5 minutes on 16 cores (it was ~20). Three kinds
of work are spread over `workerPool.ts`'s threads (`PREPARE_WORKERS=N`,
default one per core; `0` runs everything on the main thread, the path
the parallel one must match):
- **Pass 1's per-relation work.** `classifyAdminFeature` (parse, country
  resolution, area) runs on batches of raw records. The
  results are folded in strictly in corpus order (`buildAdminBoundaryIndex`),
  since candidate order and same-name region ties depend on it. The
  workers share the country lookups through `SharedArrayBuffer`s
  (`CountryPolygonIndex.pack`), rather than each getting a copy.
- **Every polyclip-ts call** (`clip.ts`): country overlaps, countries cut
  out of regions, and Voronoi cells. polyclip-ts computes in arbitrary
  precision (bignumber.js), so it was most of the run. Cuts that depend on
  each other still run in the original order, each from the outlines the
  cuts before it left, chained through promises (`countryOutlines.ts`).
- **Cropping before clipping.** Before each call, `cropForClip` cuts the
  clipper down to the edges near the subject, and replaces the rest of each
  ring with a path along a frame that keeps every winding number inside
  it. polyclip-ts then answers the same, byte for byte, for a fraction of
  the work. Highland's 355k-vertex council area took ~7 s and ~1.5 GB per
  Voronoi cell before. `test/cropForClip.test.ts` compares the two on
  shapes built to break it (a spiral winding around the cell); it fails
  when the winding is not preserved.

The pool has a weight budget (`maxWeight`: vertices for clipping, bytes
for Pass 1), because sixteen threads in polyclip-ts at once took 22 GB.
Point-in-polygon tests of one polygon against many points use
`preparedPolygon.ts`, which gives turf's answers exactly, boundary
included, from a banded edge index.

**Memory-constrained runs**: use
`systemd-run --user --scope -p MemoryMax=<N>` around a build, and set `N`
*below* what the system can actually spare — too high and the kernel's
global OOM killer fires and can kill unrelated processes instead of
containing the one that's over budget.
