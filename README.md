# loc-to-city

Resolving a GPS coordinate to a city/region/country from real
OpenStreetMap administrative boundaries, instead of the nearest-labeled-
point lookup that gets it wrong near every border.

**The working system is [reader/, compressor/, data-ingest/ and
demo/](#the-cgeodata-format-and-its-javascripttypescript-implementation)**
-- a from-scratch JavaScript/TypeScript implementation of CGEODATA (the
binary format specified in `reader/binary-format.md`), since JavaScript is what
Immich, the actual target, runs.

This README describes the system as it stands. A Python prototype came
first: four competing techniques benchmarked against each other, which is
where the format and the algorithms came from. Its code is deleted, but what
it taught us is written up in [history.md](history.md). Per-country
results and known-wrong places live in [countries.md](countries.md).

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
searchPlaces(query)       : { search: string } -> { id, name, latitude, longitude, admin1Name, admin2Name, countryCode }[]  -- secondary; addressed since, see history.md
```

Five real-world examples of where the current nearest-point approach gets
it wrong (the same failure mode as in "Why nearest-point is wrong" below, just more of them):

```
52.488789, 4.794346  should resolve to Wormerveer, not Zaandijk
52.034656, 4.388124  should resolve to Den Haag, not Nootdorp
51.970738, 4.123725  should resolve to Europoort, not Hoek van Holland
52.333399, 5.237517  should resolve to Almere, not Huizen
52.131565, 5.277514  should resolve to Soest, not Soesterberg
```

The interactive demo's tile overlay (below) makes the size of this
disagreement directly visible, including a good reminder that "correct"
isn't always what you'd eyeball on a map: 52.683459, 5.295410 (open water
off Enkhuizen) genuinely resolves to **Lelystad**, whose municipal boundary
includes most of the surrounding IJsselmeer and Markermeer. Any lookup that
tests which polygon contains the point agrees on this; only a
nearest-labeled-point lookup disagrees. Details in
[countries.md](countries.md#netherlands-nl).

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
index at all. Binary search (what the grid-based format actually does) sits at the
opposite end: excellent CPU, but it's inherently random-access, so it needs
the *entire* decoded dataset resident in memory — there's no way to binary
search a compressed or line-oriented stream directly. That's exactly why
the compact on-disk format (see [history.md](history.md#5-columnar-layout-and-delta-varints-did-most-of-the-compression)
and [reader/binary-format.md](reader/binary-format.md)) works the way
it does: the compact *at-rest* representation only has to survive being
decompressed once, at load time, into that in-memory random-access
structure — disk footprint and query-time memory/CPU are genuinely
separate axes, not a single dial.

**Hard constraint on the final solution:** it needs to run from
JavaScript, since that's what Immich's server (`immich-server`, Node.js)
actually runs. The on-disk format and algorithms are chosen with that in
mind: zlib (not zstd/brotli) because both Node's `zlib` module and the
browser `DecompressionStream` API support it natively with no extra
dependency; varint decoding and binary search are both trivial loops with
no library requirement either way. See [The CGEODATA format and its
JavaScript/TypeScript
implementation](#the-cgeodata-format-and-its-javascripttypescript-implementation)
below, and [history.md](history.md) for the measurements behind these
choices.

## Why nearest-point is wrong

The existing system — and Immich's `geodata_places`, which is the same
design — stores one
`(lat, lon)` per named place and answers "what city is this?" with a
nearest-neighbor search. Cities aren't points — they're irregular polygons —
so "nearest labeled point" and "which polygon actually contains this
location" frequently disagree, especially near any border (which is exactly
where geotagged photos often land). The Python prototype reproduced this
behavior against the NL subset of the existing dataset and got only 26–46%
agreement with the real boundaries (see [history.md](history.md)).

## Data source

Netherlands has excellent open boundary data: OSM carries `admin_level=10`
("woonplaats") boundaries sourced directly from BAG (the Dutch government's
address/buildings register — `source=BAG`, `ref:woonplaatscode=<official
code>`). These are survey-grade, sub-municipality polygons — exactly
"city/town" granularity, not just the 342 municipalities. 2,521 of them
cover the country. `admin_level=8` (municipality) and `admin_level=4`
(province) give the region/country hierarchy.

`data-ingest/` extracts these relations with osmium and resolves, for each
city polygon, its containing region and country (see
`data-ingest/PIPELINE-STAGES.md`); the Netherlands is the reference dataset
(`zuid-holland.bin`) the rest of the pipeline is checked against. For every
other country, which `admin_level` is the right one is the hard part, and is
recorded in [countries.md](countries.md).

## The CGEODATA format and its JavaScript/TypeScript implementation

[history.md](history.md) covers the Python prototype that found and fixed the
real problems. `reader/binary-format.md` specifies the actual result:
CGEODATA, a from-scratch binary format (not the same bytes as the Python
`.bin` files)
designed from the start to be readable with zero runtime dependencies in
Node.js and browsers -- the hard constraint from the
[Goal](#goal-replacing-immichs-reverse-geocoding) section. It keeps the
adaptive Morton-grid idea from the prototype's approach D (grid cells resolved
at build time), adds a "meta chunk" layer that
shards the world into independently-decompressible pieces so a lookup never
has to touch more than a small, bounded part of the file, and stores the
place hierarchy (country → region → city) as delta-coded counts plus
keyframe-compressed name blocks so names can be recovered by id without
decompressing the whole list. Read `reader/binary-format.md` for the actual spec;
this section just covers the code that implements it.

Four npm workspaces, all TypeScript:

- **`reader/`** — the format's reference reader. Zero runtime dependencies
  (only Node's built-in `zlib`), matching the spec's own constraint. Tested
  against `reader/binary-format.md`'s Appendix A worked example byte-for-byte, not
  just self-consistency with the compressor below.
- **`compressor/`** — turns a GeoJSON of city polygons, region polygons,
  and a country polygon, plus a small place-hierarchy JSON, into a `.bin`
  file. Free to use real dependencies (`@turf/*` for polygon math, `rbush`
  for the candidate spatial index), since it's a build-time tool, not
  something Immich would load. Exposes its own types
  (`CityProperties`/`HierarchyCountry`/...) as a package, so `data-ingest`
  can import them instead of reaching into its `src/`.
- **`data-ingest/`** — owns everything OSM-shaped: the scripts that turn
  raw `.osm.pbf` extracts (`data/00-raw/osm/`, gitignored) and osmium's
  exported intermediate GeoJSON (`data/01-extracted/`, also gitignored)
  into whatever a specific compressor run needs. `prepare-world.ts` does
  the real per-country resolution once, worldwide;
  `filter-by-scope.ts --only-country`/`--only-continent` filters its
  output down to a smaller scope (the Zuid-Holland and Europe test
  datasets are both built this way now, not by their own separate
  resolution pass). See `data-ingest/PIPELINE-STAGES.md` for the full
  `data/` directory layout and file dependency graph. Its outputs land in
  `data/02-resolved/`, which is what you point the compressor at.
- **`demo/`** — a click-to-query Leaflet page plus a grid tile overlay, the
  JS/TS successor to the deleted Python prototype's demo, but for one
  format with one lookup path instead of comparing four approaches. It
  serves its own copy of Leaflet, so only the OSM base map is fetched from
  elsewhere.


## Getting started

```bash
npm install                                # installs all four workspaces
npm run build --workspaces                 # tsc for each package
npm test -w reader                         # Appendix A conformance + unit tests
npm test -w compressor                     # synthetic-dataset tests (+ real-data tests if the .bin files exist)

make netherlands    # data/03-final/zuid-holland.bin: the Netherlands, all 12 provinces
make europe         # data/03-final/europe.bin
make world          # the planet: download, extract, resolve, compress; skips what is up to date

node demo/src/server.ts                    # serves data/03-final/zuid-holland.bin on :8766
npm test -w demo                           # unit tests (no dataset needed)
cd demo && npx playwright install chromium && npx playwright test   # click-to-query e2e (needs zuid-holland.bin)
```

`make netherlands` and `make europe` filter the worldwide pipeline's
already-resolved output, so they build the worldwide data first if it is
missing, which is slow from scratch (the planet download, osmium extraction
and `prepare-world.ts`; the compressor step alone is about a minute with
`--workers 16`). `data-ingest/PIPELINE-STAGES.md` has the full `data/`
layout and what each stage reads and writes. The compressor CLI
(`node compressor/src/cli.ts`) also takes `--workers N` to spread chunk work
across threads (output is byte-identical at every count) and `--only-chunks`
to build just a few chunks while investigating an area.

## Documentation

- [reader/README.md](reader/README.md): using the reader from Node.js or a
  browser, search, sidecar indexes, the CLI.
- [reader/binary-format.md](reader/binary-format.md): the CGEODATA
  specification.
- [countries.md](countries.md): per-country results, config choices and
  known-wrong places.
- [data-ingest/PIPELINE-STAGES.md](data-ingest/PIPELINE-STAGES.md): the
  `data/` directory and build stages.
- [history.md](history.md): the Python prototype's lessons, and the
  development log of this implementation (bugs, profiles, build
  measurements, fixed issues).

## Known issues and open work

Everything currently known to be wrong, unfinished, or worth revisiting
that is not specific to one country. Format-level
design gaps (not implementation bugs) live separately in
`reader/binary-format.md`'s own [Open Issues](reader/binary-format.md#12-open-issues)
section, since those are spec decisions rather than pipeline work.

**Per-country issues, config choices and their measurements live in
[countries.md](countries.md)**, one section per country, with
`*(open)*`, `*(unsolvable)*`, `*(human error)*` and `*(false positive)*`
markers to search for. What is left here is the cross-cutting pipeline,
format and search work.

### Open

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
  `data/01-extracted/world/*-admin.geojson` by `extract-boundaries.sh`, but
  discarded by `adminBoundaryIndex.ts`'s `PLAUSIBLE_ADMIN_LEVELS` prefilter
  (levels 4-11 only). This and countries.md's "Natural Earth's outlines
  are too coarse" and "Border artifacts" items all want the same new OSM
  `admin_level=2` country source, so they're natural to tackle together.
- **Search ranks equal matches by area, which is size, not fame.** With
  a locate index, `search({ sort: true })` breaks ties by area
  (`reader/binary-format.md` Appendix B.5.1, see history.md's "Issues fixed along the way"), which
  ranks the intended place first for paris, dublin, berlin, moscow,
  hamburg, vienna, utrecht, groningen and luxembourg on
  `data/03-final/world-e7-d10.bin`. Area can't fix:
  - **portland**: Portland parish, Jamaica (area byte 15), beats
    Portland, Oregon (14).
  - **amst**: "Amsterdam - Vriesland", Guyana, beats Amsterdam, a
    large polygon winning a substring tie.
  - **Paris, France vs Paris, Maine**: 11.7 vs 11.6 in log2 cells, too
    close to call.
  - Cells count for more at high latitude (Appendix C.3).

  Population (an OSM `population` tag, else a GeoNames cities500 point
  whose name matches the polygon's) fixed portland and amst in a scratch
  experiment. The name match is needed because "Central Coast"'s point
  lands in a suburb called Springfield. It was rejected for now: it means
  plumbing through data-ingest and the compressor and a `.bin` format
  change, and it demotes places GeoNames misspells or lacks. Some misses
  are name data, not ranking:
  - **athens**: Athens, Greece is "Municipality of Athens" (local
    "Δήμος Αθηναίων"), so it only reaches the whole-word tier.
  - **london**: the UK has no "London" place, only its boroughs.
  - **nederland**: the country is named "Netherlands" only, with no
    local name (see the international/local name pairs entry above).

Fixed issues, with what was measured, are in [history.md](history.md#issues-fixed-along-the-way).
