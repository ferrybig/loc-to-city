# loc-to-city

Resolving a GPS coordinate to a city/region/country from real
OpenStreetMap administrative boundaries, instead of the nearest-labeled-
point lookup that gets it wrong near every border.

**The working system is [reader/, compressor/, data-ingest/ and
demo/](#the-cgeodata-format-and-its-javascripttypescript-implementation)**
-- a from-scratch JavaScript/TypeScript implementation of CGEODATA (the
binary format specified in `binary-format.md`), since JavaScript is what
Immich, the actual target, runs.

This README is in two halves. Everything up to [Historical record: the
Python prototype](#historical-record-the-python-prototype) describes the
system as it stands. Everything after it is the Python prototype that came
first: four competing techniques benchmarked against each other, which is
where the format and the algorithms came from. That code (`scripts/`,
`webapp/`) and the `.bin` files it produced have been deleted, so the
second half is a record of what was measured, not something you can run.

**Target precision:** 10m or better. **Constraint:** size matters — the
existing production system stores one lat/lon point per place (double
precision, "nanometer precision" the source data doesn't need) and costs
112MB worldwide.

## Goal: replacing Immich's reverse geocoding

The concrete motivation for this whole exploration: [Immich](https://immich.app)
(the self-hosted photo manager) resolves a photo's GPS EXIF data to a
city/state/country using a local copy of GeoNames' `cities500.txt` (populated
places ≥500 residents) plus `admin1CodesASCII.txt` / `admin2Codes.txt`,
loaded into Postgres and queried with `earth_box()`/`earth_distance()`
nearest-point ordering — see `agent-resources/base-images/server/Dockerfile`
lines 75-81 for exactly which files get baked into the image, and
`agent-resources/immich/server/src/repositories/map.repository.ts` for the
actual query. It's the same nearest-labeled-point design as the "existing
production system" referenced throughout this README, and it's wrong for
the same reason: cities aren't points. `agent-resources/agent-research.md`
has the full writeup of how Immich's `geodata_places` table is built and
used; the short version is two independent consumers with different shapes:

```
reverseGeocode(point)     : { latitude, longitude } -> { country, state, city }   -- main focus for now
searchPlaces(query)       : { search: string } -> { id, name, latitude, longitude, admin1Name, admin2Name, countryCode }[]  -- secondary; addressed since, see "Known issues and open work" below
```

Five real-world examples of where the current nearest-point approach gets
it wrong (same failure mode as A below, just more of them):

```
52.488789, 4.794346  should resolve to Wormerveer, not Zaandijk
52.034656, 4.388124  should resolve to Den Haag, not Nootdorp
51.970738, 4.123725  should resolve to Europoort, not Hoek van Holland
52.333399, 5.237517  should resolve to Almere, not Huizen
52.131565, 5.277514  should resolve to Soest, not Soesterberg
```

The interactive demo's tile overlay (below) makes the size of this
disagreement directly visible — including a good reminder that "correct"
isn't always what you'd eyeball on a map: 52.683459, 5.295410 (open water
off Enkhuizen, near the Houtribdijk) genuinely resolves to **Lelystad**,
not Enkhuizen or generic "Flevoland" — Lelystad's official municipal
boundary is 765km² total but only ~230km² of that is land, the rest is
IJsselmeer/Markermeer water under its jurisdiction. B/C/D all agree on
this; only A (nearest-point) disagrees, because it picks whichever single
*label point* is physically closest rather than which polygon actually
contains the location.

**What "better" means here** isn't one number — a solution can be tuned
along several axes, and we want to know the real tradeoff curve between
them, not just optimize one in isolation:

- disk space used
- computation time, total (including one-time cold-boot/load cost)
- computation time, excluding cold boot (steady-state per-query cost)
- memory used

A solution that optimizes *only* memory would be a single (optionally
compressed) CSV of every city/region/country polygon, scanned line by line
until the first match — minimal memory, terrible CPU. Adding a
`min-lat,max-lat,min-lon,max-lon` bounding-box column per row trades a bit
more disk for a cheap early-reject test, cutting CPU without needing an
index at all. Binary search (what approaches C/D actually do) sits at the
opposite end: excellent CPU, but it's inherently random-access, so it needs
the *entire* decoded dataset resident in memory — there's no way to binary
search a compressed or line-oriented stream directly. That's exactly why
the [compact on-disk format](#compact-on-disk-format) below works the way
it does: the compact *at-rest* representation only has to survive being
decompressed once, at load time, into that in-memory random-access
structure — disk footprint and query-time memory/CPU are genuinely
separate axes, not a single dial.

**Hard constraint on the final solution:** it needs to run from
JavaScript, since that's what Immich's server (`immich-server`, Node.js)
actually runs. Everything in this repo so far is Python — that's fine for
proving techniques out, but the on-disk format and algorithms are chosen
with a JS port in mind: zlib (not zstd/brotli) because both Node's `zlib`
module and the browser `DecompressionStream` API support it natively with
no extra dependency; varint decoding and binary search are both trivial
loops with no library requirement either way. The JS port has started: see
[The CGEODATA format and its JavaScript/TypeScript
implementation](#the-cgeodata-format-and-its-javascripttypescript-implementation)
below.

## Why nearest-point is wrong

The existing system (`existing_data.sql` / `existing_data.csv`) — and
Immich's `geodata_places`, which is the same design — stores one
`(lat, lon)` per named place and answers "what city is this?" with a
nearest-neighbor search. Cities aren't points — they're irregular polygons —
so "nearest labeled point" and "which polygon actually contains this
location" frequently disagree, especially near any border (which is exactly
where geotagged photos often land). `scripts/approach_a_nearest_point.py`
reproduces this behavior against the NL subset of the existing dataset and
gets only 26–46% agreement with the real boundaries in the benchmark below.

## Data source

Netherlands has excellent open boundary data: OSM carries `admin_level=10`
("woonplaats") boundaries sourced directly from BAG (the Dutch government's
address/buildings register — `source=BAG`, `ref:woonplaatscode=<official
code>`). These are survey-grade, sub-municipality polygons — exactly
"city/town" granularity, not just the 342 municipalities. 2,521 of them
cover the country. `admin_level=8` (municipality) and `admin_level=4`
(province) give the region/country hierarchy.

```
scripts/extract_boundaries.py
```
parses the osmium-exported boundary relations and, for each of the 2,521
city polygons, spatially resolves its containing municipality and province,
producing `data/nl_cities.geojson` — the canonical dataset every approach
below is built from or benchmarked against.

## Reproducing

This step is still needed: `data-ingest/src/prepare-zuid-holland.ts` reads
its output (`data-ingest/work/nl-admin.geojson`) directly, and
`data-ingest/work/` is gitignored, so a fresh clone has to regenerate it.
For continent-scale extraction the equivalent step is scripted -- see
[Worldwide build](#worldwide-build-data-ingestscriptsbuild-worldsh).

Requires Docker (for `osmium-tool` + `gdal`, used once to extract boundary
relations from the `.osm.pbf`).

```bash
docker build -t loc2city-tools -f Dockerfile.tools .
curl -L -o data-ingest/osm/netherlands-latest.osm.pbf \
  https://download.geofabrik.de/europe/netherlands-latest.osm.pbf

docker run --rm -v "$PWD:/work" loc2city-tools bash -c "
  osmium tags-filter data-ingest/osm/netherlands-latest.osm.pbf r/boundary=administrative \
    -o data-ingest/work/nl-admin.osm.pbf --overwrite -f pbf &&
  osmium export data-ingest/work/nl-admin.osm.pbf -o data-ingest/work/nl-admin.geojson \
    --overwrite -f geojsonseq --geometry-types=polygon,multipolygon
"
```

## The CGEODATA format and its JavaScript/TypeScript implementation

Everything above is the Python prototype that found and fixed the real
problems. `binary-format.md` specifies the actual result: CGEODATA, a
from-scratch binary format (not the same bytes as the Python `.bin` files)
designed from the start to be readable with zero runtime dependencies in
Node.js and browsers -- the hard constraint from the
[Goal](#goal-replacing-immichs-reverse-geocoding) section. It keeps the
adaptive Morton-grid idea from approach D, adds a "meta chunk" layer that
shards the world into independently-decompressible pieces so a lookup never
has to touch more than a small, bounded part of the file, and stores the
place hierarchy (country → region → city) as delta-coded counts plus
keyframe-compressed name blocks so names can be recovered by id without
decompressing the whole list. Read `binary-format.md` for the actual spec;
this section just covers the code that implements it.

Four npm workspaces, all TypeScript:

- **`reader/`** — the format's reference reader. Zero runtime dependencies
  (only Node's built-in `zlib`), matching the spec's own constraint. Tested
  against `binary-format.md`'s Appendix A worked example byte-for-byte, not
  just self-consistency with the compressor below.
- **`compressor/`** — turns a GeoJSON of city polygons, region polygons,
  and a country polygon, plus a small place-hierarchy JSON, into a `.bin`
  file. Free to use real dependencies (`@turf/*` for polygon math, `rbush`
  for the candidate spatial index), since it's a build-time tool, not
  something Immich would load. Exposes its own types
  (`CityProperties`/`HierarchyCountry`/...) as a package, so `data-ingest`
  can import them instead of reaching into its `src/`.
- **`data-ingest/`** — owns everything OSM-shaped: the raw `.osm.pbf`
  extracts (`data-ingest/osm/`, gitignored) and osmium's exported
  intermediate GeoJSON (`data-ingest/work*/`, also gitignored), plus the
  scripts that turn those into whatever a specific compressor run needs
  (`prepare-zuid-holland.ts`, `prepare-europe.ts`). Its outputs land in
  `data/`, which is what you point the compressor at.
- **`demo/`** — a click-to-query Leaflet page plus a grid tile overlay, the
  JS/TS equivalent of `webapp/`'s demo but for one format with one lookup
  path instead of comparing four approaches.

```bash
npm install                                # installs all four workspaces
npm run build --workspaces                 # tsc for each package
npm test -w reader                         # Appendix A conformance + varint/Morton unit tests
npm test -w compressor                     # synthetic-dataset unit tests + (if built) real-data tests

# Build a small test dataset: 1 country (Netherlands), all 12 provinces
# with real polygons (11 have 0 cities -- Section 7.2 explicitly allows
# that), but only the 187 cities in Zuid-Holland, filtered from the
# already-committed data/nl_cities.geojson. Provinces come from the raw
# osmium export (data-ingest/work/nl-admin.geojson, see "Reproducing"
# above); the country polygon comes from the Natural Earth file already
# used for country resolution elsewhere in this repo.
npx tsx data-ingest/src/prepare-zuid-holland.ts
npx tsx compressor/src/cli.ts data/nl-regions.json data/zuid-holland-cities.geojson \
  data/zuid-holland.bin --regions data/nl-provinces.geojson --countries data/nl-country.geojson \
  --width-exp 6 --height-exp 6 --max-depth 10 --keyframe-exp 13 \
  --attribution "[OpenStreetMap](https://openstreetmap.org/copyright)"

npm test -w compressor                     # now also runs the Zuid-Holland structural + query tests

npx tsx demo/src/server.ts                 # serves data/zuid-holland.bin on :8766
cd demo && npx playwright install chromium && npx playwright test   # click-to-query e2e
```

Both of this phase's known accuracy regressions resolve correctly through
the full JS/TS stack (compressor → `.bin` → reader → demo), the same way
they do through the Python prototype:

```
52.034656, 4.388124   -> Den Haag, not Nootdorp
51.970738, 4.123725   -> Europoort, not Hoek van Holland
```

### Two real bugs found by browser testing

Manually clicking around the demo (not just running the two coordinates
above) surfaced a real gap: a point inside Utrecht -- outside every one of
Zuid-Holland's 187 city polygons, but still genuinely inside the
Netherlands -- resolved to fully `unknown` instead of `country: The
Netherlands, region: Utrecht`. Two separate bugs, found in order:

1. **The compressor never had region or country geometry at all.** Only
   city polygons were ever fed into the spatial index, even though the
   place table already listed all 12 provinces. There was no OSM boundary
   data checked into the repo for that -- `data-ingest/work/nl-admin.geojson`
   (the raw osmium export, gitignored, still present locally from the
   earlier NL extraction) has clean `admin_level=4` province polygons; the
   country polygon comes from the Natural Earth file already used elsewhere
   in this repo. `prepare-zuid-holland.ts` now extracts and simplifies both
   (`@turf/simplify`, same tolerances the Python prototype used:
   ~220m for regions, ~1.1km for the country), and the compressor merges
   them into the same candidate index as cities, keyed by their real place
   ids (Section 7.1) so a chunk's palette can reference any level.
2. **Adding those candidates immediately broke city resolution.** The
   recursion's stopping rule was "stop once *any* touching place fully
   contains the cell." That's fine with cities alone (nothing coarser is
   ever a candidate), but a region polygon trivially fully-contains a cell
   long before that cell has shrunk small enough to fit inside one of its
   much smaller cities -- so the old rule stopped immediately at the
   region, and Den Haag/Europoort briefly started resolving to
   `region: Zuid-Holland, city: null` instead of their actual city. Fixed
   by only stopping once *every* touching place fully contains the cell
   (Section 10's "prefer the smallest" tie-break was already correct, it
   just needed to not fire prematurely): if even one touching candidate's
   boundary still crosses the cell, that's exactly the signal to keep
   subdividing.

### Performance: what a CPU profile actually showed

Region and country polygons cover far more area than 187 city polygons, so
naturally this got slower -- but `--cpu-prof` (`node --cpu-prof --import
tsx/esm ...`) showed the actual bottleneck wasn't depth or polygon count,
it was one specific call: the max-depth ambiguous-cell fallback used
`@turf/intersect` to compute exact overlap area, and Turf v7's polygon
clipping is backed by `BigNumber`-based exact arithmetic for robustness --
~45% of all CPU samples in one profiled build were inside that one
dependency. Since Section 10 only asks for the candidate with the
*largest* area share, not an exact area, that call was replaced with a
cheap 5x5 point-sampling grid (`@turf/boolean-point-in-polygon`, plain
floating-point ray casting) counting which candidate contains the most
sample points -- a ~5x wall-clock speedup with byte-identical output on the
already-working city-only build. `touches()`/`fullyContains()` still go
through the same exact-arithmetic engine (via `@turf/boolean-intersects`/
`@turf/boolean-contains`) and remain the dominant cost after that fix --
replacing those is the next real lever, not yet done at this point in the
project (since fixed by `classifyCell`, see "Known issues and open work"
below).

Current numbers for this dataset (country + 12 provinces + 187 Zuid-Holland
cities): `--max-depth 10` (~600m cells at this grid size) takes about 76
seconds. `--max-depth 12` (~150m) was reachable in ~21s *before* the
containment-rule fix above, but that number was measured against the
buggy, prematurely-truncated recursion -- worth re-measuring once
`touches`/`fullyContains` are also sped up, rather than trusting it as-is.

### Europe-wide build

`data-ingest/src/prepare-europe.ts` reuses `data/eu_cities.geojson` (the
Python prototype's output, still on disk though the script that made it is
gone), pulls region polygons from a streamed pass over the 4.3GB
`data-ingest/work-eu/eu-admin.geojson` (peak RSS ~355MB -- this is exactly
the class of file whose naive full read OOM'd the whole machine earlier in
this project; streaming it with a hand-rolled RS-delimited reader instead
of `JSON.parse`-ing it whole was not optional), and country polygons from
the Natural Earth file already used elsewhere in this repo:

```bash
npx tsx data-ingest/src/prepare-europe.ts
npx tsx compressor/src/cli.ts data/eu-hierarchy.json data/eu-cities-filtered.geojson \
  data/europe.bin --regions data/eu-regions.geojson --countries data/eu-country-polygons.geojson \
  --width-exp 6 --height-exp 6 --max-depth 8 --keyframe-exp 13 \
  --attribution "[OpenStreetMap](https://openstreetmap.org/copyright)" --workers 16
```

Result: **41 countries, 642 regions, 138,106 cities, 2.53MB, 2,531,710
records across 409 of 4096 chunks.** Spot-checked against several major
European cities plus the original Wormerveer/Den Haag pair -- all resolve
correctly (Paris → Île-de-France → Paris, Rome → Lazio → Roma, Warsaw →
województwo mazowieckie → Warszawa, ...), a point mid-Atlantic resolves
fully unknown, and per-query time is single-digit milliseconds.

Two real problems turned up going from ~200 candidates (Zuid-Holland) to
~139,000 (all of Europe), neither of which the small test could have
caught:

1. **A third of all cities (62,339 of 202,154) have no region at all** in
   `eu_cities.geojson`, concentrated almost entirely in three countries:
   Ireland (99.9% of its 50,223 cities), Estonia (100% of 4,650), and
   Portugal (94% of 3,265). Near-total, not edge-case -- those countries
   almost certainly don't tag their primary administrative division as
   `admin_level=4` in OSM the way most of Europe does, the same kind of
   per-country variance the old Python pipeline's city-level admin_level
   auto-detection existed to handle, just never applied to regions. Cities
   without a region can't be grouped into the hierarchy, so they're
   excluded from city-level matching for now (that area still resolves at
   country level; see Dublin above) -- flagged loudly in the script's own
   output rather than silently dropped. Worth fixing properly later by
   porting that per-country auto-detection logic; out of scope for a first
   full-continent pass. (Done at world scale since -- see
   "Ireland/Estonia/Portugal-shaped region gaps" in "Known issues and open
   work" below.)
2. **Region/country polygon vertex count directly drives build time at
   this scale, and Russia is enormous.** At the tolerance the old Python
   prototype used (~1.1km), Russia's simplified polygon was still ~14,800
   vertices, and its bounding box overlaps a huge share of the world's
   chunk grid -- an early attempt at this depth made zero progress in 90+
   seconds. A short profiling harness (`node`'s inspector `Session` API,
   since neither `SIGTERM` nor an internal timer can interrupt a
   synchronous CPU-bound call to check progress) confirmed individual
   chunks in dense areas taking 10-27 seconds each. Simplifying region/
   country polygons ~5x more aggressively (they're fallback layers here,
   not the primary source of precision -- cities keep their own tolerance)
   cut Russia to ~4,500 vertices and made the build tractable: a handful of
   very dense chunks around Germany/Benelux still take tens of seconds
   each, but the whole continent completes.

`--max-depth 8` here (~2.4km cells at this grid size) is deliberately
coarse for a first full-continent pass, matching how the Zuid-Holland test
started at depth 8 before working up to 10. Pushing depth further, and
replacing the remaining `touches()`/`fullyContains()` cost (see above), are
both open follow-ups before this is production-scale. (The `touches`/
`fullyContains` cost is fixed, see "Known issues and open work" below;
pushing depth further worldwide is still blocked on the small-territory
coarse-polygon issue documented there.)

### Worldwide build (`data-ingest/scripts/build-world.sh`)

Europe's pipeline only works because `data/eu_cities.geojson` already
exists -- cities with region and country pre-resolved, produced by the
Python prototype that has since been deleted. No such file exists for any
other continent, so going worldwide meant building that step from scratch
in TypeScript rather than reusing a prepared artifact.

Two things had to be solved that Europe never hit:

1. **Countries split across continent files.** Russia's administrative
   relations live in `europe`, `asia` *and* `russia`; Turkey's in `europe`
   and `asia`. Verified with `osmium` against the real extracts: these are
   not coarse stubs in one file and full detail in another -- each
   continent file carries a complete, full-fidelity copy of whatever part
   of the country falls inside its own clip, with no overlap. Pulling
   Moscow + Yekaterinburg + Novosibirsk out of `russia` yields 33,998
   nodes; Moscow alone out of `europe` is 25,756 and Yekaterinburg alone
   out of `asia` is 4,669, and 25,756 + 4,669 + Novosibirsk's 3,573 is
   exactly 33,998. So the fix is not a per-country priority list, it's just
   **deduplication by relation id across every file**, which handles any
   transcontinental country without naming it. (`osmium export` doesn't
   emit an id by default -- `--add-unique-id type_id` is required, and
   gives `"a16115300"`-style area ids, deterministically derived from the
   relation, not the `"r..."` its docs imply.)
2. **Per-country `admin_level` detection, ported to TypeScript.** The
   3-pass algorithm described in the "Europe scaling test" section above
   (accumulate area by `(country, level)`, take the finest level covering
   >=60% of the country, then gap-fill anything a primary polygon doesn't
   already cover) was Python-only and is now gone. The port keeps its
   behavior exactly, including the case the section above doesn't spell
   out -- when *no* level clears 60%, fall back to whichever has the
   largest share, recovered from `git show
   55c4a6f:scripts/extract_boundaries_europe.py` rather than guessed at.

Memory is bounded by holding only scalars (id, country, level, area,
representative point, bbox) for every candidate during the area-
accumulation pass, and full geometry only for the primary set that
actually survives -- so peak RSS tracks the *output* size, not the corpus.
An RSS guardrail aborts with an actionable message rather than repeating
the whole-machine OOM that this project already hit once.

```bash
data-ingest/scripts/build-world.sh                    # everything in data-ingest/osm/
data-ingest/scripts/build-world.sh australia-oceania-260918   # one continent, end to end
```

Extraction skips any file whose output is already newer than its input, so
swapping one `.osm.pbf` and re-running only re-extracts that one. File
discovery is by glob, not a hardcoded continent list -- dropping in a new
`africa-*.osm.pbf` needs no code change.

Run on `australia-oceania` (30,562 boundary relations): 21 countries get a
primary level, 15,800 primary + 147 gap-filled cities, 14,887 kept after
dropping 5 unnamed and 1,055 with no region. Australia resolves at
`admin_level=9` (gazetted localities -- Sydney, Melbourne and their
suburbs all present), New Zealand at 6 (its real territorial authorities:
Wellington City, Hamilton City, Dunedin City...). The no-region drops are
the same class of gap Europe has in Ireland/Estonia/Portugal: those places
still resolve at country level, and the count is reported per country
rather than silently swallowed.

**The full 8-file worldwide build is done and committed:** `data/world.bin`
(8.3MB), built from `data/world-hierarchy.json`, `data/world-regions.geojson`
and `data/world-country-polygons.geojson`, all also committed --
`data/world-cities-filtered.geojsonseq` (4.0GB) is the only intermediate
output, gitignored like its Europe equivalent.

Ingest deduplicated 922,077 unique relations across all 8 files (29,781
cross-file duplicates dropped -- Russia and Turkey's transcontinental
split, plus every country whose relations simply span more than one
Geofabrik extract), keeping 245,348 cities (2,860 dropped for no name,
76,964 for no region -- Ireland/Estonia/Portugal-shaped gaps as expected,
see the australia-oceania run above) across 239 countries and 2,389
regions. Memory stayed bounded by the country-batching scheme in
`prepare-world.ts`: primaries are loaded and streamed to disk in batches
sized to a per-run RSS ceiling (largest countries first, into the smallest
batch) rather than all at once, which is what actually made a worldwide
run possible after an early attempt measured 115,000 primaries resident at
8.2GB, over the 8GB guardrail described above that exists specifically to
fail fast rather than repeat this project's whole-machine OOM.

The compressor stage was the bottleneck exactly as expected: 1h14m45s
wall clock at `--workers 2`, capped to 16GB resident via `systemd-run
--user --scope -p MemoryMax=16G` (peak RSS 16.2GB, zero swapping). 2,116
of 4,096 chunks produced records; total chunk work was 8,572s, so the two
workers stayed ~96% busy throughout. The slowest individual chunks were
~123s each (sparse, geometry-heavy coastline -- Svalbard/Norway), nowhere
near the multi-minute-per-chunk wall that made Russia's *un*simplified
border look intractable before the segment/rectangle classifier fix
above.

Spot-checked with the reader directly: Moscow, Yekaterinburg and
Novosibirsk (Russia's europe+asia+russia-file split) and Istanbul
(Turkey's europe+asia split) each resolve to their correct region exactly
once -- the relation-id dedup working end to end, not just at the ingest
stage. Tokyo, São Paulo, New York, Sydney, Den Haag, Paris and Nairobi all
resolve correctly to city/region/country; mid-ocean points resolve fully
unknown.

`data/world_no_chunk.bin` is the same build with `--only-chunks ''` -- the
place table alone, no quadtree chunks -- a much smaller way to inspect or
query country/region/city counts without loading the full chunk data. It
used to be committed alongside `world.bin`, and is what actually caught
the 73-countries-with-zero-cities/zero-regions shape (small island
territories, plus the admin_level=4 gap later fixed by
`countryAdminLevels.ts`) before the full build finished -- but it's now
gitignored rather than committed: it goes stale the instant
`world-hierarchy.json`/cities/regions change, and rebuilding it locally
takes seconds (see CLAUDE.md's `--only-chunks` notes), so there's no
reason to carry it as a tracked artifact that can silently drift out of
sync with `world.bin`.

### Known issues in the current worldwide build

See [Known issues and open work](#known-issues-and-open-work) near the end
of this document for the full, current list (this build's issues plus
everything else outstanding across the project) -- kept in one place
rather than scattered next to whichever section a bug was found in.

### Parallel compression (`--workers`)

Every chunk is independent -- `buildChunkRecords` touches the shared
candidate index exactly once, at the very start, then does nothing but
pure array/geometry work on an already-narrowed list. That makes it
embarrassingly parallel, and the machine this was built on has 16 cores
sitting mostly idle during a sequential build. `--workers N` (default:
`os.availableParallelism()`; `--workers 0` keeps the original sequential
path, `--workers 1` runs through the exact same worker-thread code as any
other count but with just one, making it a genuine A/B control rather than
a special case) spreads chunk work across `node:worker_threads`.

Design notes worth keeping in mind if you touch this code: job candidate
arrays are sent to workers via `postMessage` on demand (not written to
temp files -- measured to be ~1% overhead even for the worst chunk, and
files would've meant serializing 426MB up front before any worker could
start); jobs are dispatched worst-first by a cheap coordinate-count cost
estimate, since per-chunk cost is skewed up to 1000x and a naive
round-robin split would strand one worker with every hard chunk; and
candidate array order must survive the trip unchanged; two tie-breaks in
`quadtree.ts` (the smallest-area pick among fully-containing candidates,
and the largest-share pick at max depth) both break ties by
first-in-array-wins, so a sort or a `Set`/`Map` round-trip anywhere in the
handoff would silently change output for ambiguous cells.

**Measured on the Europe build** (same inputs/flags as above, `--workers 0`
vs `--workers 16`, 16-core machine): **34m55s sequential → 8m17s parallel,
a ~4.2x speedup** at 1346% average CPU utilization. Output is
byte-for-byte identical at every worker count tested (0, 1, 3, 16) against
both the Zuid-Holland and Europe datasets -- parallelizing changed nothing
about the result, only how long it takes to get there. 4.2x on 16 cores is
well short of linear, consistent with what's already known about this
workload: a handful of chunks take 10-27 seconds *alone* (a hard floor no
amount of parallelism removes), and 16 threads doing simultaneous heavy
floating-point/allocation work contend for memory bandwidth and cache in
ways a single thread doesn't. Note also that the "34m55s" sequential
number here supersedes the rough "several minutes" estimate in the section
above -- that one was eyeballed from file timestamps across an interleaved
profiling session, never actually measured in isolation; this is the first
time it was.

### Selective chunk builds (`--only-chunks`)

A full-grid build is all-or-nothing, which makes investigating one slow or
wrong area painful: you either wait out the whole world or you don't get
the chunk you care about. `--only-chunks` takes a comma-separated list of
chunk indices and inclusive ranges (`--only-chunks 200`, `--only-chunks
200,300-500`) and compresses only those; every other chunk is written
empty, exactly as if it had no candidates. Nothing before the chunk stage
changes -- the place hierarchy, name blocks and candidate index are all
still built in full -- so a selective build is a strict subset of the real
one, not an approximation of it (the tests assert the selected chunk's
bytes match a full build's, and that sequential and worker-pool paths stay
byte-identical under a selection).

`--only-chunks ''` selects nothing at all, producing a **dictionary-only
file**: every chunk empty, but a complete, readable place table. On the
worldwide inputs that's 77KB in 1.8s, which is enough to serve
name lookups (a search endpoint, say) without paying for the spatial index
at all.

Each chunk is also timed (`buildChunkRecords` + `encodeChunk`, measured
identically in the sequential and worker-thread paths), reported through
`onChunkBuilt` and summarised by the CLI as a total, a mean, and the ten
slowest chunks -- printed as indices you can paste straight back into
`--only-chunks`. Timings deliberately stay out of `BuildStats`, which is
the determinism oracle the byte-identity tests compare with `deepEqual`.
The callback also fires for chunks that produce *no* records, since a
chunk whose bbox catches a huge polygon can burn real time and still
resolve to nothing -- invisible otherwise.

This is worth running even on small datasets. On Zuid-Holland (187
cities, `--max-depth 10`): 36.5s of chunk work across 240 chunks, of
which **chunk 3232 alone is 30.0s** -- 82% of the entire build in one
chunk, with 25,921 of the 40,546 records. The cost was never spread
evenly.

The immediate use is measurement. Building only chunk 1274 (the one
containing Sydney) from the worldwide inputs takes **52 seconds and
produces 36,808 records** -- for comparison, the entire Europe build
produces 2,531,710 records across 409 non-empty chunks, averaging ~6,200
per chunk. One Australian chunk carries 6x the records of an average
European one, because the level the coverage detection picks for Australia
(`admin_level=9`, ~14,700 gazetted localities) tiles the country
edge-to-edge with no gaps, so the quadtree keeps subdividing: almost every
cell has several adjacent full-precision candidates whose boundaries cross
it. That is the actual shape of the worldwide build cost, and it's
per-chunk work, not candidate count -- Europe has ~9x more cities in total.

### How much precision these tolerances cost

`prepare-europe.ts` simplifies region and country polygons aggressively
(0.01 and 0.05) because, when those numbers were picked, vertex count drove
the dominant cost and Russia at full precision made the build intractable.
The segment/rectangle classifier changed that enough to be worth
re-measuring rather than assuming. Europe, 16 workers, everything else
held constant:

| Country tolerance | Russia verts | All 41 countries | Wall clock | Points differing from full precision |
|---|---|---|---|---|
| 0.05 (~5.5km, current) | 4,491 | 12,159 | **33s** | 506 / 361,201 (0.140%) |
| 0.01 (~1.1km, the old Python value) | 14,816 | 41,687 | 1m14s | 111 / 361,201 (0.031%) |
| none | 36,756 | 118,583 | 4m15s | — |

So full-precision country borders are now affordable where they simply
weren't before — the same build under the old predicates would have been
somewhere north of an hour. Every one of the 506 differences is a coastal
or border point (Gibraltar, the Algarve, Sicily, the Turkish border)
flipping between a country and `unknown`, which is exactly what a 5.5km
outline gets wrong. Dropping to 0.01 buys back 78% of that for 1m14s.

**Regions are a different story and should stay simplified.** Unsimplified
they are 7,222,966 vertices against 93,205 — 77x, driven by a handful of
enormous ones (Bretagne alone is 254,929). Measured on six French chunks
via `--only-chunks 3039,3040,3103,3104,3167,3168`: 10.1s of chunk work
simplified against 651.5s unsimplified, a 64x increase that extrapolates
to roughly half an hour for the continent. The return is negative, too --
that build produced *fewer* records (251,242 against 251,786), since the
region layer only ever answers where no city matched, and a sharper
fallback boundary mostly just costs more to compute.

A per-candidate segment index (or clipping each candidate to its chunk
once, the idea deliberately deferred when `--workers` landed) is what
would change this picture; per-ring bounding boxes already skip whole
islands, but Russia's mainland ring is a single ring that no bbox test can
skip.

## Known issues and open work

Everything currently known to be wrong, unfinished, or worth revisiting in
the current (non-historical) system, in one place, instead of scattered
next to whichever section a bug happened to be found in. Format-level
design gaps (not implementation bugs) live separately in
`binary-format.md`'s own [Open Issues](binary-format.md#12-open-issues)
section, since those are spec decisions rather than pipeline work.

### Open

- **Natural Earth's country outlines are too coarse for small
  territories.** Jersey (9km across) is a 47-vertex ring in
  `agent-resources/ne_10m_admin_0_countries.geojson`; Guernsey is 59 --
  confirmed by direct inspection, unmodified by anything in this pipeline
  (`COUNTRY_SIMPLIFY_TOLERANCE` is `0`, so these vertex counts come
  straight from the source file). At `--max-depth 8` (`data/world.bin`)
  this mostly doesn't show: the max-depth tie-break in `quadtree.ts` picks
  *some* winner for an ambiguous leaf cell even when its sample score is
  `0`, as long as one candidate is the sole one still touching that
  branch, which papers over gaps between the crude outline and the real
  coastline. At `--max-depth 11` (`data/world_high_res.bin`, gitignored,
  not committed) subdivision goes fine enough to reach cells the real
  boundary never touches at all, and those correctly resolve to nothing --
  which is what makes the *same* underlying coarse-polygon problem look
  like data loss ("too small in the south", missing cities) instead of
  getting silently smoothed over. Baarle-Hertog/Baarle-Nassau likely
  shares this root cause, compounded by its enclave/exclave topology. Fix
  would mean sourcing small-territory outlines from OSM's own
  `admin_level=2` boundary relations (already extracted for the admin
  pipeline) instead of, or as an override on top of, Natural Earth for
  territories under some area threshold -- not a `quadtree.ts`/`geometry.ts`
  bug, since both builds are classifying the exact same (coarse) polygon
  correctly. Also blocks pushing `--max-depth` further worldwide (see
  "Europe scaling test" below): finer subdivision only exposes this same
  problem more visibly, it doesn't fix it.
- **International/local name pairs aren't populated for countries.**
  Regions and cities now get them: `adminBoundaryIndex.ts` captures OSM's
  `name:en` tag alongside `name` into `nameEn` (on both `CityCandidateMeta`
  and `RegionCandidate`), `prepare-world.ts` carries it into each city
  feature's `nameEn` property and into a per-country `regionNames` map
  (local region name -> international name) on the hierarchy JSON, and
  `compressor/src/placeIds.ts`'s `assembleNameEntry` joins `local|intl`
  into the actual name entry only at the very end, when `nameEntries` is
  built -- the region/city join key (`` `${country} ${region}` ``) stays
  the plain local `name`/`region` string throughout ingest/matching,
  completely unaffected by whether either side has an international name.
  Countries are still English-only: Natural Earth's
  `ne_10m_admin_0_countries.geojson` (the current country source) has no
  local-name field at all -- its `NAME`/`NAME_EN` properties are both
  already the English name (confirmed for `NL`: `NAME` = `NAME_EN` =
  `"Netherlands"`, not `"Nederland"`), so a genuine `Nederland|The
  Netherlands` pair would need country geometry/names to come from OSM's
  own `admin_level=2` relations instead of (or alongside) Natural Earth --
  those relations are already extracted (unfiltered) into
  `data-ingest/work-world/*-admin.geojson` by `extract-boundaries.sh`, but
  discarded by `adminBoundaryIndex.ts`'s `PLAUSIBLE_ADMIN_LEVELS` prefilter
  (levels 4-11 only). This and the item above both want the same new OSM
  `admin_level=2` country source, so they're natural to tackle together.
- **A handful of Slovenian cities land in the wrong synthesized region.**
  Residue of the Voronoi region fallback below: `assignCityRegion` places
  a real OSM city by its `repPoint` (`pointOnFeature`, roughly a bbox
  midpoint), and a large or off-center municipal polygon's `repPoint` can
  end up geometrically closer to a *neighboring* cities500 site's Voronoi
  cell than to its own. Confirmed on Ljubljana (the capital; its own OSM
  polygon spans 14.41-14.76 lon, wide enough that its `repPoint` lands in
  the "Dol pri Ljubljani" cell instead of "Ljubljana") and Puconci (same
  shape, lands in "Grad"). Counted across all 271 Slovenian cities: 2 look
  like real misassignments this way; the other ~95 whose city/region name
  differ are legitimate (an ordinary village correctly inside a
  same-region municipality named after its own, different, seat town).
  Not fixed -- a real fix would need either using each city's own centroid
  instead of `pointOnFeature`, or biasing Voronoi sites by known city
  extent, neither attempted here.
- **Sudan has no city tier, and its zero-region-drop root cause is still
  unexplained.** Khartoum resolves to neither region nor city despite
  `countryAdminLevels.ts` recording 100.5% region coverage -- the same
  unexplained pattern the "Regions with no cities were dropped" fix below
  was supposed to have already covered, not yet distinguished from it.
  Not in `VORONOI_CITY_FALLBACK` yet for that reason: adding a fallback on
  top of an unroot-caused bug risks papering over whichever second issue
  Sudan actually has, the way Slovenia's region gap once masked its city
  tier being fine all along. Coverage is patchy rather than uniformly zero
  everywhere in this class of country: Niamey (Niger) and Nouakchott
  (Mauritania) resolve all the way to city despite their countries' low
  national percentages.
- **Capitals that are themselves a region resolve to a city district.**
  Astana (51.142310, 71.433792) returns `region: Астана, city: Алматы
  ауданы`, and Sana'a returns `region: أمانة العاصمة, city: مديرية
  الثورة`. Kazakhstan's three republican cities and Yemen's capital are
  level-4 regions in OSM, so the only thing below them is the city's own
  districts. No config level fixes that: there's no tier where the city
  appears as a city. Aden is the same pattern one level down (its
  city boundary is the only level-5 feature in Yemen). Yemen more
  broadly: level 6 (districts, 99.5%) splits the larger cities while being
  about right for rural areas, and no single level fits both.
  Germany has two of its own: Berlin (52.520008, 13.404954) and Hamburg
  (53.551086, 9.993682) are city-states with only one OSM admin relation,
  at `admin_level=4` -- same level as every other German Land -- so they
  resolve to `region: Berlin` / `region: Hamburg`, `city: -`. Unlike
  Bremen (see "Resolved"), confirmed there is no second, lower-level
  relation for either city anywhere in the German extract -- nothing to
  gap-fill in. Tashkent is the same pattern: fixing Uzbekistan's region
  level (see "Resolved") means it now returns `region: Toshkent shahri,
  city: Chilonzor Tumani` (a real Tashkent district) instead of no city
  at all -- an improvement, but the capital itself only exists as the
  level-4 relation `region` already resolves to, confirmed by scanning
  every "Toshkent"/"Tashkent"-named relation in the extract, so no city
  tier can ever name the capital itself the way it names every other
  Uzbek city.
- **Towns mapped only as place points can't be returned.** Shire (14.083301,
  38.281860) and Yebokile (10.447974, 37.896309) in Ethiopia have no
  boundary relation in OSM -- the whole of Ethiopia has two polygons
  finer than level 6 -- so the best a polygon lookup can give there is the
  zone (`Semien Mi'irabawi Zone`, `East Gojjam`). A fix would mean adding
  `place=*` nodes as a nearest-point fallback, which is a design change
  rather than a level pick.
- **Wales and Northern Ireland resolve to sub-town units.** With GB's
  level-10 primary, central Cardiff returns `city: Castle` (a Welsh
  community) and central Belfast returns `Town Parks` (a townland) --
  both finer than the town. Found while verifying the GB fix below, not
  yet investigated.
- **Brazil: major cities missing despite 66.6% city coverage.** Neither
  São Paulo nor Rio de Janeiro (the city, not the state) resolve --
  `lookup` at each city's own coordinates returns `city: -`. 66.6%
  coverage nationally apparently doesn't guarantee the largest metros are
  among the covered candidates; not yet investigated further.
- **`place=city/town/village` was evaluated as an alternative to
  `admin_level` matching, and rejected for geometry -- but is a real
  signal worth using differently.** The idea: instead of picking one
  `admin_level` per country, filter OSM for whatever's tagged
  `place=city`/`town`/`village` and use those boundaries directly.
  Tested on the Netherlands extract (`osmium tags-filter ... place=city,town,village`,
  via `Dockerfile.tools`, same as the boundary extraction already does):
  8,492 of 8,624 matches (98.5%) are bare nodes -- a single label point,
  no polygon at all, i.e. exactly the nearest-labeled-point approach this
  whole project exists to replace (see "Why nearest-point is wrong"). The
  131 that do carry a polygon are tagged `boundary=place` with no
  `admin_level`, and are informal settlement-extent outlines drawn
  separately from the real administrative boundaries already in use, not
  a richer version of the same geometry. So `place=*` can't replace
  `admin_level` as the geometry source. What it *can* do: disambiguate
  which existing `admin_level` relation is "the real city" when a country
  has more than one plausible candidate at different levels for the same
  settlement -- this is exactly how Bremen's fix was found (its
  `admin_level=6` relation, not the `admin_level=4` Land, carries
  `place=city`; see "Resolved"). Cross-referencing `place=city/town/village`
  tags onto the existing boundary corpus (already extracted, no new OSM
  pull needed) as a tie-break/confirmation signal, rather than a
  standalone geometry source, is the version of this idea worth pursuing
  later.

### Resolved

- **Uzbekistan and Laos's region tier was a district level, not a
  province level.** Both picked up `region: [6]` from the generated
  table, because `region`'s candidate-level scan only ever measures
  levels a country's own entry already lists (`selectRegionLevels` in
  `adminLevelDetection.ts`, gated by `isRegionLevel` in
  `adminBoundaryIndex.ts`) -- with only level 6 listed, it trivially won
  by being the sole candidate in range, not by beating a real province
  level. Uzbekistan's level 6 is 204 tumani/shahri (districts/cities);
  Laos's is 148 muang (districts) -- both roughly the size the "Some
  region tiers look finer than a province" entry above flagged as
  suspicious for Afghanistan before its own fix. Measured directly
  against the real OSM extract (`asia-260918-admin.geojson`): level 4 is
  Uzbekistan's 13 viloyats (62.9% coverage) and Laos's 18 provinces
  (100.7%), matching each country's actual top-level administrative
  geography. `region: [4]` for both now resolves e.g. Samarkand's region
  to `Samarqand Viloyati` and Vientiane's to `Vientiane Prefecture`
  instead of a district name.

  Freeing level 6 from region duty also gave both countries a real city
  tier for the first time: `city` had previously been forced onto a
  near-empty level purely because 6 was already claimed (Uzbekistan
  landed on level 8 at 1.3% coverage, Laos on level 7 at 0.2%). With
  region moved to 4, `city: [6]` covers 99.9%/100.8% with real district
  names -- Samarkand resolves to `city: Samarqand shahri`, Pakse to
  `ເມືອງປາກເຊ` (Pak Sé District) -- so this is a bigger fix than the
  region-granularity framing suggests: both countries went from almost
  no city tier at all to one covering effectively the whole country. The
  one gap this doesn't close is each capital resolving to one of its own
  districts rather than to itself (see "Capitals that are themselves a
  region resolve to a city district" above) -- same root cause as
  Berlin/Hamburg, not fixable by a level choice.

- **Libya, Egypt, Chad and Eritrea had no city tier -- fixed with a
  Voronoi fallback synthesized from GeoNames, not an OSM admin_level.**
  Tripoli, Cairo, N'Djamena and Asmara all resolved to `city: -`: these
  four countries have a genuine, confirmed absence of city-tier OSM
  administrative *polygons* (`countryAdminLevels.ts` records 0-0.7% city
  coverage), so no `admin_level` choice could ever fix them -- unlike
  every other country-level fix in this section, which was always a
  matter of picking the *right* level.

  Fixed instead by synthesizing city polygons from `cities500.txt`
  (GeoNames' populated-places export, already vendored in
  `agent-resources/`) via a Voronoi diagram: `voronoiFallback.ts`'s
  `buildCityFallback` takes a country's cities500 points as Voronoi
  sites (`d3-delaunay`, clipped first to a bounding box then to the
  country's own real outline with `@turf/intersect`, since `d3-delaunay`
  only clips to a rectangle) and gives every point in the country a
  city, following local point density the way a real settlement layer
  would -- dense near towns, large in empty country. A synthesized city
  still resolves to its real region: `prepare-world.ts` routes it through
  the exact same `assignCityRegion`/`emitCity` path a real OSM candidate
  uses, rather than hardcoding one.

  Deliberately a real tessellation, not a fixed-radius buffer around each
  point: buffers overlap in dense areas and leave gaps in sparse ones, so
  a point between two buffers would fall through to the country/region
  instead of resolving to its nearest city -- precisely the
  "nearest-labeled-point is wrong" failure mode this whole project
  exists to fix (see "Why nearest-point is wrong"). A Voronoi cell has no
  gaps or overlaps by construction. Every cities500 point in the country
  becomes a site, unfiltered by population -- matches this format's
  existing city granularity elsewhere (real OSM city polygons aren't
  population-filtered either), so a point near a small town resolves to
  that town rather than a distant, filtered-in major city.

  Explicit opt-in only (`VORONOI_CITY_FALLBACK`, a hand-reviewed
  `Set<string>` in `countryAdminLevels.ts`), same philosophy as
  `COUNTRY_ADMIN_LEVELS` itself: a country is added only after its OSM
  city coverage is confirmed unfixable by a level change, never
  automatically just because a build's coverage happens to come out low.
  Sudan is a confirmed same-shape case but isn't listed yet -- see the
  "Open" entry above for why. Verified end-to-end on a scoped Africa
  build: Tripoli, N'Djamena and Asmara now resolve to their own name;
  Cairo's exact GeoNames coordinate does too (a nearby but distinct
  coordinate resolved to Būlāq Abū al 'Ilā, a real, separate Cairo
  district also present in cities500 -- expected Voronoi nearest-site
  behavior, not a bug).

- **Slovenia had zero regions (and so zero cities) -- fixed with the
  same Voronoi machinery, region half.** `SI: { region: [], city: [8] }`
  -- city coverage was already fine (101.9%, real municipalities: Bled,
  Solčava, Mežica confirmed present in the source extract), but there was
  no usable region candidate at all, so every Slovenian city was dropped
  by `emitCity`'s "no region -> drop the city too" rule (confirmed: Bled
  and Maribor, Slovenia's 2nd-largest city, were both entirely absent
  from `data/world.bin`). Slovenia's nearest thing to a regional tier is
  OSM `admin_level=7` ("Upravna Enota"), but that's only 17.6%
  coverage -- not a full tessellation, so no `region` level choice would
  have cleanly fixed this the way e.g. Ireland's `admin_level=6` counties
  did for the same class of bug.

  Fixed by `voronoiFallback.ts`'s `buildRegionFallback`: groups a
  country's cities500 points by GeoNames admin1 code (the same
  `${countryCode}.${admin1Code}` join key `admin1CodesASCII.txt` itself
  uses -- read purely for display names here, since it has no
  coordinates in this repo), computes one Voronoi diagram over every
  point in the country together (not one per group -- that would leave
  gaps/overlaps at a shared group boundary), then `@turf/union`s each
  group's individual cells into one region polygon. Slovenia's 602
  cities500 points fall into exactly 212 distinct admin1 codes, matching
  `admin1CodesASCII.txt`'s own 212 real Slovenian municipalities exactly;
  the 212 synthesized region polygons' combined area matches the
  country's own area exactly (both ~20,277 km²), confirming no gaps or
  overlaps. Runs before `finalRegions`/`regionIndex` are built, since
  every downstream region assignment (real OSM cities, the region-
  override routing, and the city Voronoi fallback) depends on it already
  being complete.

  Opt-in via `VORONOI_REGION_FALLBACK`, same philosophy as
  `VORONOI_CITY_FALLBACK`. Verified end-to-end on a scoped Europe build:
  Ljubljana's real OSM city polygon now resolves to a real region (though
  not always the *correct* one -- see "Open" above), and Maribor and Bled
  both resolve fully correctly at region and city level.

- **Ethiopia, Afghanistan, Saudi Arabia, Taiwan and the UK used the wrong
  city (and in some cases region) level.** Verified on a scoped Africa+
  Asia+Europe build, before -> after:
  - Ethiopia: region was the zone tier and city the woreda tier (12.6%
    coverage), so most of the country had no city. Now region 4 / city 5:
    Shire -> `Tigray / Semien Mi'irabawi Zone`, Yebokile -> `Amhara /
    East Gojjam`, Addis Ababa -> `Addis Ababa / Addis Ababa`.
  - Afghanistan: region was districts (384 of them) and city the Kabul-
    only nahia tier (0.6%). Now region 4 / city 5: Kunduz ->
    `Kunduz Province / Kunduz District`, Kabul -> `Kabul Province /
    Kabul Municipality`.
  - Saudi Arabia: city was level 10, splitting Riyadh into hundreds of
    neighbourhoods (Thulaim). Now region 4 / city 6: Riyadh ->
    `Riyadh Region / Riyadh Governorate`, Jeddah -> `Makkah Region /
    Jeddah Governorate`.
  - Taiwan: city was level 9 (7,545 villages). Now `[7, 8]`: townships
    primary, districts gap-filled -- Taipei -> `Taipei City / Xinyi
    District`, Kaohsiung -> `Kaohsiung City / Xinxing District`.
  - UK: city was level 10 (civil parishes) only, leaving London (51.507674,
    -0.130119), unitary towns and nearly all of Scotland without a city.
    Now `[6, 8, 10]`: parishes primary, districts/boroughs and unitary
    authorities/Scottish council areas gap-filled -- London -> `City of
    Westminster`, Reading -> `Reading`, Brighton -> `Brighton and Hove`,
    Kinross (56.128332, -3.306370) -> `Fife`, Edinburgh -> `City of
    Edinburgh`. Parished towns are unchanged (Guildford, Cambridge,
    Malvern). Spot-checked that no two-tier county leaks into the city
    slot: Worcestershire gets added but loses to the smaller district or
    parish wherever one exists (Worcester, Redditch, Kidderminster).

- **Bremen (the city) resolved to `city: -`.** Germany's 3 city-states
  are OSM `admin_level=4`, the same level as every other Land, so they
  lost the city slot to the region tier -- Bremen (53.079296, 8.801694)
  returned `region: Bremen, city: -`. Unlike Berlin and Hamburg (still
  open, see above), Bremen has a second, `place=city`-tagged relation at
  `admin_level=6` for the city itself, distinct from the Land polygon.
  `DE: { city: [8, 6] }` gap-fills it in: Bremen now resolves to
  `city: Bremen`. Verified the gap-fill doesn't leak a Landkreis name
  into normal cities elsewhere (Munich, Cologne, Frankfurt, Hannover all
  unchanged, still resolving via the level-8 primary).

- **Regions with no cities were dropped from the build (Libya, Egypt,
  Chad, Sudan, and 110 other countries).** Tripoli, Cairo, N'Djamena and
  Khartoum all resolved to `region: -` even though
  `data/world-regions.geojson` had their region polygons (Libya 23, Egypt
  27, Chad 23, Sudan 18). Root cause: `prepare-world.ts` built each
  country's hierarchy region list *only* from regions that received at
  least one emitted city, and the compressor only builds regions the
  hierarchy lists -- so a country with no city tier (Libya, Egypt) lost
  every region, Chad kept only `Ouaddaï` (the one region holding its 5
  cities), and Sudan lost Khartoum State plus five eastern states.
  Worldwide, 2,142 of 6,041 region polygons across 114 countries were
  missing, 22 of those countries ending up with zero regions (Eswatini,
  Fiji, Seychelles, Vanuatu, ...). Fixed by seeding the hierarchy from
  every region polygon; `binary-format.md` Section 7.2 already allows a
  region with zero cities. Verified on an Africa-only scoped build: all
  four capitals now resolve to their correct region.

- **Canada resolved at regional-district grain, not city.** Terrace, BC
  used to resolve to `Regional District of Kitimat-Stikine` instead of
  `Terrace`; same root cause as the US county case below -- level 6 (regional
  district, 66.2% coverage) auto-won the area vote over level 8 (real
  municipality names -- Terrace, Toronto, Vancouver, Montreal, Winnipeg
  all confirmed at level 8, only 31.4% national coverage). Measured
  against GeoNames' cities500 Canadian entries (3,298 places) with a
  scoped North-America-only test build: level 8 fuzzy-name-matches 31.3%
  (1,032/3,298) vs. level 6's 14.8% (487/3,298) -- roughly 2.1x better,
  though both numbers are far lower than the US's equivalent fix (64.0%),
  since Canada's incorporated-place coverage is thinner nationally than
  the US's. Most of the level-8 "misses" inspected are not really wrong --
  GeoNames lists neighborhoods (Abbottsfield, Aberdeen, Agincourt North)
  that correctly resolve to their containing city (Beverly, Kamloops,
  Scarborough), a finer grain than this format targets, not a bug.
  `COUNTRY_ADMIN_LEVELS['CA']` now overrides to level 8, same as the US
  fix below.

- **US resolved at county grain, not city.** Seattle (47.602922,
  -122.331390) used to resolve to `country: United States of America,
  region: Washington, city: King County` -- correct in that county is
  genuinely the finest OSM `admin_level` that fully tessellates the US
  (>=60%-coverage auto-detection picked level 6 at 103.0% coverage over
  level 8's 10.7%, since unincorporated land is common), but useless as a
  "city" answer: nobody looks up a point expecting a county name.
  `COUNTRY_ADMIN_LEVELS['US']` now overrides the auto-pick to level 8
  (incorporated places) despite its lower coverage -- measured against
  GeoNames' cities500 US entries (21,785 places), level 8 fuzzy-name-
  matches 64.0% of them vs. county's 4.3%. Uncovered (unincorporated)
  points gap-fill to region instead of showing a wrong county name, which
  is a strict improvement over the old behavior (100% of those points
  used to show a technically-correct-but-misleading county name).

  **New York resolved at region grain, not city -- fixed by a per-region
  override, not a country-wide level.** Manhattan, Brooklyn, the Bronx and
  Albany still returned `city: null` after the level-8 fix above: New
  York's real municipal tier is OSM `admin_level=7` (towns), not the
  nationally-correct 8 (villages, only 2.1% coverage in NY vs. towns'
  92.8%). `COUNTRY_ADMIN_LEVELS` couldn't express "level 8 everywhere
  except New York, where it's 7" -- only one level per *country*. Fixed
  by adding `overrides?: Record<string, number[]>` to
  `CountryAdminLevels`, keyed by region name (`US: { ..., overrides: {
  "New York": [8, 7] } }`): a region listed here ignores the country's
  own `city` level and coverage vote entirely, using its own
  `[primary, ...gapFill]` list instead -- the first level is that
  region's primary unconditionally, later levels gap-fill only within
  that region, on top of its own primary, never the country's.

  Two flatter designs were tried first and both caused real, measured
  regressions, which is why the final shape is `[primary, ...gapFill]`
  specifically, not a plain level list:
  - A country-wide `US: { city: [7, 8] }` gap-fill (no region scoping at
    all) fixed NY but made the *whole country* worse: 399 fewer correct
    cities500 matches nationally (63.95% -> 62.12%). Cause: a large
    level-7 township can out-vote a real, smaller level-8 town it
    geographically contains at their shared boundary cells --
    `buildChunkRecords`'s max-depth tie-break picks whichever candidate
    covers the larger *share* of an ambiguous leaf cell, and nothing in
    `pruneAncestors` treats "geographically nested inside" as exclusive
    the way the hierarchy's own city-inside-region ancestry is. Confirmed
    on Wrightsville, AR (5.5 km^2): a boundary cell inside both it and the
    1,120 km^2 Big Rock Township it sits in resolved to the township once
    township became a candidate there too, even though a real,
    correctly-covering Wrightsville primary already existed.
  - A single-level `overrides: { "New York": [7] }` (region-scoped, but
    still just one level) avoided that -- Arkansas was untouched, since
    `detectGapFill` now excludes a candidate whose level is *some*
    region's override but not its own region's. But it broke New York
    *internally*: the state has its own real two-tier structure, villages
    (level 8) inside towns (level 7), and dropping level 8 as NY's own
    primary meant its ~550 villages lost to their containing town by the
    identical coverage-share mechanism, just scoped to NY (Village of
    Akron -> Town of Newstead, Village of Ardsley -> Town of Greenburgh,
    ...) -- still a net loss nationally (-80) versus the plain baseline.

  `overrides: { "New York": [8, 7] }` fixes both: level 8 (villages) is
  NY's own primary, so it never competes against level 7 for a cell it
  already covers; level 7 only gap-fills the towns with no covering
  village (Manhattan, Brooklyn, the Bronx, Albany, and every other town
  never split into a smaller incorporated village). Net result on the
  same 21,785-place cities500 US run: 63.88% (13,917 matches) vs. the
  plain-level-8 baseline's 63.95% (13,931) -- effectively a wash on raw
  count (-14), but a real quality improvement: NYC's boroughs and Albany
  now resolve correctly, at the cost of a small number of NY villages
  still losing to their town at a shared boundary cell (Akron, Ardsley,
  and similar -- the same finite-quadtree-resolution imprecision the
  "Natural Earth's country outlines are too coarse" entry above
  describes, not a routing bug: confirmed each such village's own
  representative point does resolve correctly, only some of its edge
  cells don't). Fixing that residue would need actual geometry-precision
  work (a real ancestor/containment relationship between two same-tier
  candidates, or higher `--max-depth`), out of scope for this fix.

- **Ireland/Estonia/Portugal-shaped region gaps.** Previously documented
  (and, before that, in `prepare-europe.ts`/the deleted Python prototype)
  as an accepted OSM data-tagging quirk -- see "Europe scaling test"
  below, point 1, for where this was first written up as a Python-era
  limitation "worth fixing properly later." It turned out to be a real
  bug: `REGION_LEVEL` was hardcoded to `admin_level=4`, and
  `prepare-world.ts`'s `emitCity` drops a city *entirely* (not just its
  region) when no region polygon covers it. A worldwide audit found **45
  countries with zero `admin_level=4` candidates at all**, silently losing
  100% of their cities to this -- Ireland alone lost 54,361 city
  candidates (Limerick, 52.660975, -8.634567, among them), because OSM
  tags Ireland's counties at `admin_level=6`, not 4.

  The first fix picked each country's region level algorithmically from a
  single shared range (`REGION_CANDIDATE_LEVELS = [4, 5, 6]` worldwide,
  largest-area-share wins). That approach itself had a real bug -- level 3
  briefly in that range broke France, since OSM tags a "France
  métropolitaine" + 5-overseas-territory grouping at `admin_level=3` (6
  near-country blobs, one ~96% of the mainland, outvoting France's real
  18-région level-4 layer) -- and a hard limitation: North Macedonia's real
  municipality tier sits at `admin_level=7`, and widening the shared range
  to reach it risked colliding with countries like Latvia whose *city*
  tier is genuinely at 7. A shared range meant every country was
  implicitly voting on the same candidate pool.

  Replaced with `data-ingest/src/lib/countryAdminLevels.ts`: a per-country
  `Record<code, { region: number[]; city: number[] }>`, generated from the
  same real-corpus area data the algorithm used, then hand-reviewed.
  Selection logic (`selectRegionLevels`/`selectPrimaryLevels` in
  `adminLevelDetection.ts`) now only ever scans the levels a country's own
  table row lists -- correcting one country's row can never again change
  another's result, since they're independent dictionary entries, not
  shared range membership. `data-ingest/test/adminLevelDetection.test.ts`
  asserts every entry's `region`/`city` lists are disjoint, across the
  whole real table, not just hand-picked fixtures. One hand-reviewed
  override on top of the generated defaults so far: North Macedonia's only
  level-4/5/6 candidate is "Град Скопје" (City of Skopje, 2.3% coverage,
  not a real region tier) -- set to `region: []`; its city tier (level 8,
  98.8% coverage) already resolved correctly and needed no change.

  Validated first against the real worldwide corpus (Pass 1/1.5/2 only):
  Iceland resolves 8 regions + 61 cities (previously 0 and 0), Ireland 26
  regions + 50,599 primary cities, Estonia 15 regions + 4,685 cities;
  France/Netherlands/Germany/Angola/Egypt/Russia/US/Canada all confirmed
  unchanged. As a side effect, Pass 1 also collects far less now --
  301,103 city candidates and 6,081 region matches worldwide, versus
  760,866 and 56,805 under the shared-range version -- since a level is
  only ever stored as a candidate for a country whose own table row
  actually lists it, not for every country in a shared range.

  **Rebuilt and committed** (`data/world.bin`, `info` command): 239
  countries, 3,899 regions (was 2,595), 294,914 cities (was 252,721) --
  matching the dry-run numbers above exactly.
- **The `touches()`/`fullyContains()` exact-arithmetic bottleneck.**
  First identified in "Performance: what a CPU profile actually showed"
  below as the dominant remaining cost after replacing `@turf/intersect`,
  and called out again in "Europe scaling test" below as an open
  follow-up. Fixed by `geometry.ts`'s `classifyCell` (see this repo's
  `CLAUDE.md`), a segment/rectangle classifier (Liang-Barsky clipping)
  that replaces both `@turf/boolean-contains` and
  `@turf/boolean-intersects` without exact-arithmetic polygon algebra --
  tested against densely-sampled ground truth, not against turf, since
  turf is what was being replaced for giving wrong answers on multi-part
  polygons at country/region scale.
- **`searchPlaces` (the secondary Immich API shape from "Goal: replacing
  Immich's reverse geocoding" above).** Addressed via a trigram search
  index (`build-search-index` CLI command, attached with
  `CGeoDataReader.useSearchIndex()` / the `--index` flag for `search`),
  conforming to `binary-format.md` Appendix B. The coordinate per result
  comes from `CGeoDataReader.locate()`, backed by a place location index
  (`build-locate-index`, `binary-format.md` Appendix C) that turns a
  ~1.6s scan of every chunk into a sub-millisecond read.

## Historical record: the Python prototype

Everything below describes `scripts/` and `webapp/`, the Python
prototype that established which technique actually works, along with
the `.bin` files it produced. None of that code or data is in the tree
any more -- it was removed once the JS/TS implementation above
superseded it. It is kept here because the measurements are what
justify the current design, and re-deriving them would mean rebuilding
the prototype. Read it as a record of what was run, not as
instructions you can follow or files you can open.

### TL;DR results

| Approach | On-disk size (NL only) | Accuracy vs. ground truth | Query speed |
|---|---|---|---|
| A. Nearest labeled point (how Immich / the existing system works) | 55 KiB | 26–46% | ~14–21us |
| B. Exact point-in-polygon | 41.5 MiB (uncompressed GeoJSON) | 100% (*is* ground truth) | ~24–41us |
| C. Adaptive Morton grid + exact fallback | 0.60 MiB + fallback data | 100% | ~6us (interior), ~39us (border-adjacent) |
| D. Adaptive grid, resolved at build time (self-contained) | 0.54–0.60 MiB, nothing else needed | ~97% (exact away from borders) | ~7us (interior) |

Both target coordinates from the brief resolve correctly with B, C, and D,
and incorrectly with A:

```
52.48878991537549, 4.794346918807473  (expected: Wormerveer)
  A nearest-point -> Zaandijk
  B exact polygon -> Wormerveer
  C adaptive grid -> Wormerveer
  D adaptive grid -> Wormerveer

52.034656091402674, 4.388124124642494  (expected: Den Haag)
  A nearest-point -> Ypenburg
  B exact polygon -> Den Haag
  C adaptive grid -> Den Haag
  D adaptive grid -> Den Haag
```

### The four approaches

#### A. Nearest labeled point
`scripts/approach_a_nearest_point.py` — a 3D unit-sphere KD-tree over
`existing_data.csv` filtered to NL (1,616 points), replicating the existing
system's (and Immich's) `ll_to_earth`/`earth_distance` nearest-neighbor
design. Included purely as the baseline to demonstrate the problem.

#### B. Exact point-in-polygon
`scripts/approach_b_polygon.py` — an STRtree over the real city polygons,
`.contains()` / `.intersects()` at query time. This is accuracy ground
truth; every other approach is graded against it. Costs 41.5MB as
uncompressed GeoJSON for NL alone (simplifying to a 10m tolerance shrinks
that to ~5.2MB — still real polygon math per query, just less of it).

#### C. Adaptive Morton/Z-order grid + exact fallback
`scripts/build_grid_index.py` / `scripts/query_grid.py` — the intended
"compact, no pointer-chasing" design: recursively subdivide a world-aligned
quad grid over the NL bounding box. A cell stops recursing as soon as it's
*uniform* (no city touches it, or exactly one city fully contains it) —
most of the country's area resolves this way within a handful of levels.
Every leaf is flattened into one array sorted by Morton code, so a query is
one `bisect` call, no tree traversal. (The exact on-disk byte layout is
described separately below, since it applies to C and D alike.)

**What didn't work, and why:** the original design (see the note in the
brief) pushes every ambiguous cell down to a fixed 10m floor and classifies
it there. We built that first (`GRID_MAX_DEPTH=22`, written at the time to
`data/nl_grid_d22_naive_reference.bin` — 135MB) and it lost to
the 112MB budget it was supposed to beat. Dutch woonplaats boundaries follow
canals, have enclaves, and pack many small localities tightly together, so
"ambiguous" cells are common well below the 1km scale — forcing all of them
to a uniform 10m floor produces 17.7M leaf records.

The fix actually matches the brief's own design better: cap recursion at a
much shallower depth (18, ~370m×300m cells) and mark a cell that's still
ambiguous at the cap as `BOUNDARY` rather than subdividing further. A
`BOUNDARY` leaf carries no geometry — at query time, the ~3% of queries
(measured on random interior points) that land in one fall back to the
exact polygon lookup (approach B). This gives *exact*, not 10m-quantized,
answers for boundary queries, and doesn't require tuning the depth against
the precision target at all: depth only trades off file size against how
often the (still fully correct) slow path fires.

One real bug worth noting: the first working version of `make_record()`
padded a shallow cell's code with a `1` bit at the cell's *midpoint*
(an S2-style sentinel), which seemed right from memory but actually breaks
the invariant binary search depends on — a shallow cell's stored code must
be ≤ every point inside it, which plain zero-padding (code = cell start)
guarantees and midpoint-padding doesn't. It silently misclassified any
query in the first half of an ambiguous cell (e.g. the Den Haag test point)
by falling through to `None`. Fixed by zero-padding; see the comment in
`compute_code()`.

#### D. Adaptive grid, resolved at build time (no fallback data needed)

Same recursive build as C, but controlled by `GRID_BOUNDARY_FILL`: instead
of storing a `BOUNDARY` sentinel for an ambiguous cap-depth cell and
deferring to real polygon math at query time, pick a winner for it *at
build time*, from `cand` — the real candidate cities whose polygons
actually touch that specific cell, never the whole country — and bake that
city id straight into the record like any uniform cell. Three variants,
each writing its own file so they never clobber each other or the
sentinel/approach-C build:

- `nl_grid_d_random.bin` — `random.choice(cand)`
- `nl_grid_d_nearest.bin` — deterministic: whichever candidate's
  polygon is closest to the cell center (same spirit as approach A, just
  scoped to real local candidates instead of the whole country)
- `nl_grid_d_coverage.bin` — deterministic: whichever candidate
  covers the largest share of the cell's area (the demo's default "D")

(Those three outputs, and the naive reference above, have since been
deleted along with the Python code that produced them. The comparison
they settled is what mattered, and it's recorded here.)

The result is a **fully self-contained file**: no `BOUNDARY` records exist
in it at all, so `query_grid.py` needs no polygon fallback data at query
time, ever. The cost is precision: any query landing in a cell that was
ambiguous at the cap depth gets whichever locally-plausible neighbor won
that cell at build time, not necessarily the true one. The tile overlay
(below) makes this directly visible: D is pixel-identical to C in every
uniform interior region, and only near a real border does it start mixing
in the (real, neighboring) candidate colors — a jagged noisy seam, not the
totally-unrelated speckle a country-wide random pick would produce.

### Compact on-disk format

Both grid families (C and D) share the same on-disk encoding, "LG02"
(`build_grid_index.py` writes it, `query_grid.py` reads it). Naively
packing each leaf as one 8-byte record (44-bit Morton code + 5-bit depth +
15-bit payload) gave a 7.4MB file. Two changes got that down to ~0.5-0.6MB
— an ~12-14x reduction — without changing what's stored, just how:

1. **Split into columns.** Instead of one array of interleaved
   `(code, depth, payload)` records, store three separate streams: all the
   codes, then all the depths, then all the payloads. Same bytes, just
   grouped by field instead of by record — this alone lets a general
   compressor find much more repetition (codes next to codes, not
   interleaved with unrelated depth/payload bytes).
2. **Delta-encode the (already sorted) codes as varints.** Records are
   sorted by Morton code, so consecutive codes are close together —
   storing each one as *how much bigger than the previous one* instead of
   its absolute 44-bit value turns most of them into 1-2 byte varints
   instead of a fixed 8 bytes. This step alone shrinks the raw code stream
   from 7.6MB to under 1MB, before any general-purpose compression is even
   applied.

The whole columnar blob (delta-varint codes + depths + payloads) is then
zlib-compressed as one unit. Measured on approach C's output (
954,497 records):

| Stage | Size |
|---|---|
| original interleaved 8-byte records | 7,744,895 bytes |
| columnar split, delta-varint codes, uncompressed | 3,824,888 bytes |
| ...then zlib level 9 | **632,143 bytes** |

We also benchmarked gzip/zstd/brotli against three layouts (interleaved,
columnar, columnar+delta-varint) — see git history for the exact numbers.
The short version: delta-varint does most of the work regardless of which
general-purpose compressor sits on top (zlib: 523KB, zstd -19: 427KB,
brotli -q11: 423KB, on just the records blob). zstd/brotli do edge out
zlib by 10-20%, but brotli in particular is dramatically slower to
*compress* (compression is a one-time build step, so that alone isn't
disqualifying) — the real reason we picked plain zlib is the JS-portability
constraint above: it's a zero-dependency built-in in both Node.js
(`zlib.inflateSync`) and browsers (`DecompressionStream('deflate')`),
where zstd/brotli would need a native addon or wasm dependency for a ~15%
size difference that delta-varint had already mostly captured anyway.

**The cost isn't compression, it's decoding.** Decompression itself is
fast (zlib: a few ms). Turning the varint bytes back into absolute code
values is a plain Python loop today and takes **~150-170ms for ~954K
records** — a real but one-time cost paid once at process startup, not per
query. (A numpy- or TypedArray-vectorized varint decoder would cut this
significantly if it mattered; not done here since it doesn't gate anything
in this PoC.)

### Benchmark

```
python3 scripts/benchmark.py
```
samples 300 random interior points and 300 points jittered ~1m from a real
city border (the adversarial case), grades each approach against approach B,
and times all three:

```
=== On-disk size ===
  A (nearest-point, existing-style):          54.9 KiB
  B (full-precision polygons, geojson):        41.54 MiB
  C (adaptive Morton grid, binary):            0.60 MiB
    + fallback polygons needed for boundary cells (reuses B's 41.54 MiB, or a simplified subset)
  (existing production system, worldwide):     112 MiB

=== Accuracy: random interior points (n=300) ===
  A nearest-point: 137/300 agree with ground truth (45.7%)
  C adaptive grid : 300/300 agree with ground truth (100.0%)
    (grid needed exact fallback for 10/300 of these)

=== Accuracy: points within ~1m of a city border (n=300) ===
  A nearest-point: 76/300 agree with ground truth (25.3%)
  C adaptive grid : 300/300 agree with ground truth (100.0%)
    (grid needed exact fallback for 300/300 of these)

=== Query throughput: realistic mix, mostly interior (n=300) ===
  A nearest-point: 14.4us/query
  B exact polygon : 24.3us/query
  C adaptive grid : 6.4us/query

=== Query throughput: adversarial, all within ~1m of a border (n=300) ===
  A nearest-point: 14.0us/query
  B exact polygon : 30.7us/query
  C adaptive grid : 38.5us/query
```

On a realistic query mix, the grid is both the smallest *and* the fastest
option — it beats exact polygon lookup because ~97% of queries never touch
Shapely at all. It only loses on raw speed in the adversarial all-boundary
case, where every query pays the fallback's full polygon-lookup cost plus
its own grid lookup on top. (`benchmark.py` currently only covers A/B/C;
D isn't wired into it yet, but is covered qualitatively by the tile overlay
and the accuracy discussion in the D section above.)

### Extending beyond the Netherlands

- The grid is already world-aligned (lon ∈ [-180,180), lat ∈ [-90,90)), so
  codes stay globally consistent — other countries can be added without
  re-encoding NL's records, just by seeding recursion from their bounding
  boxes.
- `extract_boundaries.py` assumes NL's admin_level convention
  (10=city, 8=municipality, 4=province). Other countries use different
  admin_levels for equivalent granularity and would need their own mapping.
- The current fallback (approach C) ships the *entire* polygon dataset for
  the boundary minority. A tighter version would store, per boundary leaf,
  just the handful of edge segments actually relevant to that cell (closer
  to the edge-list design in the original brief) instead of the whole
  polygon — worth doing if the fallback dataset's size becomes the
  bottleneck at country/continent scale. Approach D sidesteps this
  entirely by not needing a fallback dataset at all, at a small accuracy
  cost near borders.
- Still Python throughout, and still not what Immich would actually load
  (Immich runs Node.js). The JS/TS port covers a new, formally-specified
  format (`binary-format.md`, "CGEODATA") rather than these exact `.bin`
  files -- see [The CGEODATA format and its JavaScript/TypeScript
  implementation](#the-cgeodata-format-and-its-javascripttypescript-implementation).

### Europe scaling test

Ran the same pipeline against all of Europe (`europe-latest.osm.pbf`,
Geofabrik) to see where it actually breaks, using `admin_level=8`
uniformly as a "city" proxy across every country (NL's own
admin_level=10/8/4 build is untouched — this is a separate, deliberately
coarser probe: `scripts/extract_boundaries_europe.py`,
`GRID_CITIES_PATH=data/eu_cities.geojson GRID_MAX_DEPTH=10
python3 scripts/build_grid_index.py`). It found four real problems, all
now fixed:

1. **The build OOM'd the entire machine session**, not just the Python
   process. Root cause: ~123 country-level (`admin_level=2`) OSM relations
   at full precision include some extremely detailed coastlines (Norway,
   Croatia...), and accumulating those alongside 152,165 city polygons in
   memory at once spiked well past available RAM. Fixed by simplifying
   geometry on load, before anything accumulates (city: ~55m tolerance,
   region: ~220m, country: ~1.1km — coarse, but this is a containment test
   for the region/country *label*, not the precision-critical grid).
   Restarted the build under a `systemd-run --user --scope -p
   MemoryMax=...` cgroup afterward so a repeat would only kill that scope,
   not the session.
2. **The payload field overflowed.** It was 2 bytes (uint16, max 65,535) —
   fine for NL's 2,521 cities, a hard crash (`struct.error`) once Europe's
   152,165 cities needed indices past that. Widened to 3 bytes (up to
   16,777,214 cities) in both `build_grid_index.py` and `query_grid.py`;
   bumped the on-disk format to "LG04" so an old 2-byte-payload file can
   never be silently misread.
3. **The city table, not the spatial index, dominates file size at this
   scale.** The compact delta-varint/zlib encoding only ever applied to
   the grid records — the city table (id/name/municipality/region/country
   strings) was still written raw. At NL's 2,521 cities that was a
   rounding error; at Europe's 152,165 it was **7.42MB out of a 7.42MB
   file (99.94%)**, while the actual (compressed) spatial index was just
   4.5KB. Compressing the city table too (bumped to "LG05") cut the whole
   file to **1.65MB** — a 4.5x reduction from fixing the part that was
   actually never a bottleneck at NL's scale.
4. **Country resolution needed a fallback, and the fallback itself needed
   a fix.** France's own `admin_level=2` OSM relation doesn't assemble
   into a valid polygon in a Europe-only extract — it references overseas
   department members that a geographic clip cuts away, breaking
   multipolygon assembly entirely (a known OSM-data quirk, not a bug
   here). Added a fallback to Natural Earth's country polygons
   (`agent-resources/ne_10m_admin_0_countries.geojson` — the same dataset
   Immich itself uses for `naturalearth_countries`), which dropped
   `missing_country` from 47,200 to 69 (30% → 0.05%). Then hit a second,
   independent quirk: Natural Earth's `ISO_A2` field is literally the
   string `"-99"` for France specifically (a long-documented NE artifact
   for a few disputed/edge cases) — fixed by preferring `ISO_A2_EH`
   ("everywhere, including disputed") over `ISO_A2`.

**The gap that was left "known, not fixed" turned out to be much bigger
than it looked.** Berlin resolving to `None` was flagged above as a
narrow German-city-state quirk. Visually inspecting the tile overlay
across the rest of Europe showed the same failure mode — `B: no city` —
recurring in Germany (Oberhausen, Münster), the UK (Wiltshire), Bosnia
(Tuzla), Poland, and Latvia: a single hardcoded `admin_level=8` isn't
just imprecise for some countries, it's flatly the wrong level for many
of them, and worse, it can be wrong *within* a country too:

- **Germany's ~107 "kreisfreie Städte"** (independent cities — Oberhausen,
  Münster, Berlin, Hamburg...) are tagged `admin_level=6`, not 8, because
  they're simultaneously their own county; ordinary towns are 8. These
  aren't alternatives to pick between — they're *complementary*: level 8
  alone covers ~96% of Germany's area but silently omits exactly the
  cities most likely to matter.
- **The UK** only has a matching boundary at `admin_level=10` in some
  areas; **Latvia's** municipalities are `admin_level=7`; several
  countries mix levels for genuinely different things (a settlement
  polygon at one level, its containing municipality at another).

A single per-country constant doesn't capture "two complementary levels
that are both correct for different places within the same country," so
`extract_boundaries_europe.py` now auto-detects coverage in three passes
instead of one:

1. **Pass 1** accumulates polygon area by `(country, admin_level)` across
   every candidate level (5 through 11), country resolved against Natural
   Earth. (An earlier attempt included any level covering ≥3% of a
   country's area as "supplementary," which seemed like a natural fix for
   the kreisfreie-Stadt case — it backfired: Germany's `admin_level=5`
   ("Regierungsbezirk," a *region*) also has high area coverage, simply
   because it's the union of everything below it. Raw area share can't
   tell a genuine standalone leaf apart from a coarse parent container.)
2. **Pass 2** picks one *primary* level per country — the finest level
   whose own area already covers ≥60% of the country — and keeps every
   relation at that level. This alone reproduces the original single-level
   behavior (Germany: 8, Latvia: 8, UK: 10, Poland: 7 — i.e. gmina, not 8).
3. **Pass 3** re-scans once more for relations at *other* levels, and adds
   one only if nothing kept so far covers its location: a query against
   the pass-2 result at that relation's own representative point. An
   ordinary Kreis's point falls inside one of its own child Gemeinden
   (already covered → skipped, correctly excluded as a redundant
   container); a kreisfreie Stadt's point falls inside nothing at all
   (genuine gap → added). This is the actual test that distinguishes a
   leaf from a container that the area-share heuristic couldn't.

This turned the 152,165 single-level cities into 195,530 primary +
gap-filled cities, all now resolving correctly — but it also introduced
a new kind of overlap: in the small number of countries with genuinely
nested complementary levels (Bosnia's cantons and municipalities), a
coarse gap-filled relation can end up geometrically containing an
already-correct finer one. `build_grid_index.py`'s cell classification
picked whichever fully-containing polygon its spatial index happened to
return first, with no preference for the more specific one — fixed by
preferring the smallest-area polygon whenever several fully contain the
same cell. That resolves the common case, but not the narrower one where
a grid cell's boundary happens to sit inside the coarse polygon without
also being fully inside the fine one at the built depth — recursion
already stops once *any* single polygon fully contains a cell, so it
doesn't force itself deeper just because a smaller candidate is nearby
but not (yet, at this depth) a clean fully-containing match. Tuzla is
exactly this case: approach B (exact polygon, no grid involved) correctly
returns the municipality, while C/D's grid currently returns the
containing canton — right country, one level too coarse. Known, not
chased further this round; forcing recursion to prefer the smallest
candidate in `cand` rather than the first fully-containing one would fix
it, at the cost of recursing deeper through every such overlap zone.

The grid was also rebuilt at `MAX_DEPTH=14` (~1.2–1.6km cells) instead of
the original `10` (~25km) — still nowhere near NL's ~300m, but a
substantial precision jump that stayed cheap (205s to build, 3.57MB) once
the coverage fix was in place.

**Numbers, end to end (current build):**

| Stage | Time | Peak memory | Result |
|---|---|---|---|
| Filter `europe-latest.osm.pbf` (35GB) for boundaries | 5m00s | ~2GB | 478MB pbf, 370,644 relations |
| Export to GeoJSON | 1m23s | — | 4.36GB, 419,697 features |
| Extract + resolve region/country, 3-pass coverage detection | 11m52s | ~2.5GB | 313MB `eu_cities.geojson`, 202,154 cities |
| Build grid, `MAX_DEPTH=14` (~1.2–1.6km cells) | 3m26s | — | 2,539,977 leaf records |
| **Total on-disk (grid + compressed city table)** | | | **3.57MB** |

202,154 cities is **80x** NL's 2,521. Correctness spot-checked against
every location from this round's bug reports (Germany x2, England,
Bosnia, Poland, Latvia) plus the original NL regression pair: all resolve
to the right country now, and all but Tuzla (see above) to the right
city too.

### Interactive demo

`webapp/` was the Python version of this demo, since deleted along with the
rest of `scripts/`/`webapp/` (see the top of this document) -- its
`python3 webapp/server.py` command no longer works. Kept here as a record
of what the visual A/B/C/D comparison looked like, since it's what actually
made the accuracy differences between approaches obvious rather than just
numbers in a table:

- **Click anywhere** in the Netherlands — a popup showed what each of
  approaches A/B/C/D resolved that point to, with a match/differs badge
  against B (ground truth) and a per-query timing breakdown.
- **Tile overlay** rendered any of the four approaches as a Leaflet tile
  layer: each pixel block was one query, colored by hashing the resolved
  city's id to a hue. A rendered as a scatter of clean Voronoi-cell blobs
  that ignored real borders entirely; B and C rendered identically (jagged
  borders that actually followed the polygons); D matched C everywhere
  except a jagged seam right along every border, where its build-time
  tradeoff showed up directly.

The current, working demo is `demo/` (Node.js/TypeScript) -- see
[The CGEODATA format and its JavaScript/TypeScript
implementation](#the-cgeodata-format-and-its-javascripttypescript-implementation)
below for how to run it.
