# loc-to-city

Proof of concept: resolving a GPS coordinate to a city/region/country,
scoped to the Netherlands, using real OpenStreetMap administrative
boundaries instead of nearest-point lookup. Four techniques are built and
benchmarked against each other on the same data.

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
loops with no library requirement either way. The actual JS port hasn't
been done yet.

## TL;DR results

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

## The four approaches

### A. Nearest labeled point
`scripts/approach_a_nearest_point.py` — a 3D unit-sphere KD-tree over
`existing_data.csv` filtered to NL (1,616 points), replicating the existing
system's (and Immich's) `ll_to_earth`/`earth_distance` nearest-neighbor
design. Included purely as the baseline to demonstrate the problem.

### B. Exact point-in-polygon
`scripts/approach_b_polygon.py` — an STRtree over the real city polygons,
`.contains()` / `.intersects()` at query time. This is accuracy ground
truth; every other approach is graded against it. Costs 41.5MB as
uncompressed GeoJSON for NL alone (simplifying to a 10m tolerance shrinks
that to ~5.2MB — still real polygon math per query, just less of it).

### C. Adaptive Morton/Z-order grid + exact fallback
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
it there. We built that first (`GRID_MAX_DEPTH=22`, `data/
nl_grid_d22_naive_reference.bin`, gitignored — it's 135MB) and it lost to
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

### D. Adaptive grid, resolved at build time (no fallback data needed)

Same recursive build as C, but controlled by `GRID_BOUNDARY_FILL`: instead
of storing a `BOUNDARY` sentinel for an ambiguous cap-depth cell and
deferring to real polygon math at query time, pick a winner for it *at
build time*, from `cand` — the real candidate cities whose polygons
actually touch that specific cell, never the whole country — and bake that
city id straight into the record like any uniform cell. Three variants,
each writing its own file so they never clobber each other or the
sentinel/approach-C build:

- `data/nl_grid_d_random.bin` — `random.choice(cand)`
- `data/nl_grid_d_nearest.bin` — deterministic: whichever candidate's
  polygon is closest to the cell center (same spirit as approach A, just
  scoped to real local candidates instead of the whole country)
- `data/nl_grid_d_coverage.bin` — deterministic: whichever candidate
  covers the largest share of the cell's area (the demo's default "D")

The result is a **fully self-contained file**: no `BOUNDARY` records exist
in it at all, so `query_grid.py` needs no polygon fallback data at query
time, ever. The cost is precision: any query landing in a cell that was
ambiguous at the cap depth gets whichever locally-plausible neighbor won
that cell at build time, not necessarily the true one. The tile overlay
(below) makes this directly visible: D is pixel-identical to C in every
uniform interior region, and only near a real border does it start mixing
in the (real, neighboring) candidate colors — a jagged noisy seam, not the
totally-unrelated speckle a country-wide random pick would produce.

## Compact on-disk format

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
zlib-compressed as one unit. Measured on `data/nl_grid.bin` (approach C,
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

## Benchmark

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

## Extending beyond the Netherlands

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
- Still Python throughout; the JS port called for in the
  [Goal](#goal-replacing-immichs-reverse-geocoding) section above hasn't
  been started yet.

## Europe scaling test

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

## Interactive demo

```bash
python3 webapp/server.py       # loads all four indexes once, serves on :8765
```

Open <http://127.0.0.1:8765>.

- **Click anywhere** in the Netherlands — a popup shows what each of
  approaches A/B/C/D resolves that point to, with a match/differs badge
  against B (ground truth) and a per-query timing breakdown. Buttons for
  the two example coordinates from the brief are built in.
- **Tile overlay** (top-right panel) renders any of the four approaches as
  a Leaflet tile layer: each pixel block is one query, colored by hashing
  the resolved city's id to a hue (`oklch(0.7463 0.1213 <hue>)` or
  `hsl(<hue> 70.2% 46.52%)`, `webapp/colors.py`). This is a fast way to
  *see* correctness rather than sample it: A renders as a scatter of clean
  Voronoi-cell blobs that ignore real borders entirely; B and C render
  identically (jagged borders that actually follow the polygons); D
  matches C everywhere except a jagged seam right along every border —
  built only from the real neighboring candidates for that cell, not a
  country-wide random pick — where its build-time tradeoff shows up
  directly. The "resolution" select controls the pixel block size per
  query (1 = sharp but slow — up to 65k queries per tile; 64 = fast but
  blocky) — coarser settings also make the grid's actual cell size visible
  as real blockiness, not just a rendering artifact. Even the demo's
  default 300m-ish cell resolution (well short of the original 10m target)
  already looks unmistakably closer to the real boundaries than approach
  A's Voronoi blobs.

## Reproducing

Requires Docker (for `osmium-tool` + `gdal`, used once to extract boundary
relations from the `.osm.pbf`) and Python 3 with `shapely` and `numpy`.

```bash
docker build -t loc2city-tools -f Dockerfile.tools .
curl -L -o data/netherlands-latest.osm.pbf \
  https://download.geofabrik.de/europe/netherlands-latest.osm.pbf

docker run --rm -v "$PWD:/work" loc2city-tools bash -c "
  osmium tags-filter data/netherlands-latest.osm.pbf r/boundary=administrative \
    -o data/work/nl-admin.osm.pbf --overwrite -f pbf &&
  osmium export data/work/nl-admin.osm.pbf -o data/work/nl-admin.geojson \
    --overwrite -f geojsonseq --geometry-types=polygon,multipolygon
"

python3 scripts/extract_boundaries.py     # -> data/nl_cities.geojson
python3 scripts/build_grid_index.py       # -> data/nl_grid.bin              (approach C; GRID_MAX_DEPTH env var, default 18)
GRID_BOUNDARY_FILL=random   python3 scripts/build_grid_index.py  # -> data/nl_grid_d_random.bin   (approach D)
GRID_BOUNDARY_FILL=nearest  python3 scripts/build_grid_index.py  # -> data/nl_grid_d_nearest.bin  (approach D, deterministic variant)
GRID_BOUNDARY_FILL=coverage python3 scripts/build_grid_index.py  # -> data/nl_grid_d_coverage.bin (approach D, area-coverage variant)
python3 scripts/benchmark.py              # compares approaches A/B/C
python3 webapp/server.py                  # interactive demo, all four approaches
```
