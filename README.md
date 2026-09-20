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
searchPlaces(query)       : { search: string } -> { id, name, latitude, longitude, admin1Name, admin2Name, countryCode }[]  -- secondary, not yet addressed
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
replacing those is the next real lever, not yet done.

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
   full-continent pass.
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
both open follow-ups before this is production-scale.

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

**Not yet done:** a full 8-file worldwide build. The data-ingest stage is
fast (~11s for australia-oceania), but the compressor stage is the
bottleneck at this scale -- see `--only-chunks` below for the measurement
and why.

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
