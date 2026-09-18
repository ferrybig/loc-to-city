# loc-to-city

Proof of concept: resolving a GPS coordinate to a city/municipality/region/country,
scoped to the Netherlands, using real OpenStreetMap administrative boundaries
instead of nearest-point lookup. Three techniques are built and benchmarked
against each other on the same data.

**Target precision:** 10m or better. **Constraint:** size matters — the
existing production system stores one lat/lon point per place (double
precision, "nanometer precision" the source data doesn't need) and costs
112MB worldwide.

## TL;DR results

| Approach | On-disk size (NL only) | Accuracy vs. ground truth | Query speed |
|---|---|---|---|
| A. Nearest labeled point (how the existing system works) | 55 KiB | 26–46% | ~20us |
| B. Exact point-in-polygon | 41.5 MiB (uncompressed GeoJSON) | 100% (*is* ground truth) | ~40us |
| C. Adaptive Morton grid + exact fallback | 7.4 MiB + fallback data | 100% | ~11us (interior), ~59us (border-adjacent) |

Both target coordinates from the brief resolve correctly with B and C, and
incorrectly with A:

```
52.48878991537549, 4.794346918807473  (expected: Wormerveer)
  A nearest-point -> Zaandijk
  B exact polygon -> Wormerveer
  C adaptive grid -> Wormerveer

52.034656091402674, 4.388124124642494  (expected: Den Haag)
  A nearest-point -> Ypenburg
  B exact polygon -> Den Haag
  C adaptive grid -> Den Haag
```

## Why nearest-point is wrong

The existing system (`existing_data.sql` / `existing_data.csv`) stores one
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

## The three approaches

### A. Nearest labeled point
`scripts/approach_a_nearest_point.py` — a 3D unit-sphere KD-tree over
`existing_data.csv` filtered to NL (1,616 points), replicating the existing
system's `ll_to_earth` nearest-neighbor design. Included purely as the
baseline to demonstrate the problem.

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
Every leaf is flattened into one sorted array of fixed-width `uint64`
records (Morton code | depth | payload), so a query is one `bisect` call,
no tree traversal.

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
answers for boundary queries, keeps the grid itself at 7.4MB, and — unlike
the naive version — doesn't require tuning the depth against the precision
target at all: depth only trades off file size against how often the
(still fully correct) slow path fires.

One real bug worth noting: the first working version of `make_record()`
padded a shallow cell's code with a `1` bit at the cell's *midpoint*
(an S2-style sentinel), which seemed right from memory but actually breaks
the invariant binary search depends on — a shallow cell's stored code must
be ≤ every point inside it, which plain zero-padding (code = cell start)
guarantees and midpoint-padding doesn't. It silently misclassified any
query in the first half of an ambiguous cell (e.g. the Den Haag test point)
by falling through to `None`. Fixed by zero-padding; see the comment in
`make_record()`.

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
  C (adaptive Morton grid, binary):            7.39 MiB
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
  A nearest-point: 21.4us/query
  B exact polygon : 41.4us/query
  C adaptive grid : 10.7us/query

=== Query throughput: adversarial, all within ~1m of a border (n=300) ===
  A nearest-point: 18.8us/query
  B exact polygon : 44.0us/query
  C adaptive grid : 58.6us/query
```

On a realistic query mix, the grid is both the smallest *and* the fastest
option — it beats exact polygon lookup because ~97% of queries never touch
Shapely at all. It only loses on raw speed in the adversarial all-boundary
case, where every query pays the fallback's full polygon-lookup cost plus
its own grid lookup on top.

## Extending beyond the Netherlands

- The grid is already world-aligned (lon ∈ [-180,180), lat ∈ [-90,90)), so
  codes stay globally consistent — other countries can be added without
  re-encoding NL's records, just by seeding recursion from their bounding
  boxes.
- `extract_boundaries.py` assumes NL's admin_level convention
  (10=city, 8=municipality, 4=province). Other countries use different
  admin_levels for equivalent granularity and would need their own mapping.
- The current fallback ships the *entire* polygon dataset for the boundary
  minority. A tighter version would store, per boundary leaf, just the
  handful of edge segments actually relevant to that cell (closer to the
  edge-list design in the original brief) instead of the whole polygon —
  worth doing if the fallback dataset's size becomes the bottleneck at
  country/continent scale.

### D. Adaptive grid, resolved at build time (no fallback data needed)

Same recursive build as C (`build_grid_index.py`), but controlled by
`GRID_BOUNDARY_FILL`: instead of storing a `BOUNDARY` sentinel for an
ambiguous cap-depth cell and deferring to real polygon math at query time,
pick a winner for it *at build time*, from `cand` — the real candidate
cities whose polygons actually touch that specific cell, never the whole
country — and bake that city id straight into the record like any uniform
cell. Two variants, `data/nl_grid_d_random.bin` (`random.choice(cand)`)
and `data/nl_grid_d_nearest.bin` (whichever candidate's polygon is closest
to the cell center — deterministic, same spirit as approach A but scoped
to real local candidates instead of the whole country). Both are exactly
7.4MB, identical in size to C, since it's the same leaf structure with a
different payload.

The result is a **fully self-contained file**: no `BOUNDARY` records exist
in it at all, so `query_grid.py` needs no polygon fallback data at query
time, ever — just the 7.4MB grid. The cost is precision: any query
landing in a cell that was ambiguous at the cap depth gets whichever
locally-plausible neighbor won that cell at build time, not necessarily
the true one. The tile overlay (below) makes this directly visible: D is
pixel-identical to C in every uniform interior region, and only near a
real border does it start mixing in the (real, neighboring) candidate
colors — a jagged noisy seam, not the totally-unrelated speckle an
across-the-whole-country random pick would produce.

## Interactive demo

```bash
python3 webapp/server.py       # loads all three indexes once, serves on :8765
```

Open <http://127.0.0.1:8765>.

- **Click anywhere** in the Netherlands — a popup shows what each of
  approaches A/B/C resolves that point to, with a match/differs badge
  against B (ground truth) and a per-query timing breakdown. Buttons for
  the two example coordinates from the brief are built in.
- **Tile overlay** (top-right panel) renders any of the four approaches as
  a Leaflet tile layer: each pixel block is one query, colored by hashing
  the resolved city's id to a hue (`oklch(0.7463 0.1213 <hue>)` or
  `hsl(<hue> 70.2% 46.52%)`, `webapp/colors.py`). This is a fast way to
  *see* correctness rather than sample it: A renders as a scatter of clean
  Voronoi-cell blobs that ignore real borders entirely; B and C render
  identically (jagged borders that actually follow the polygons); D
  matches C everywhere except a jagged, coverage based seam right along every
  border — built only from the real neighboring candidates for that
  cell, not a country-wide random pick — where its build-time tradeoff
  shows up directly. The "resolution"
  select controls the pixel block size per query (1 = sharp but slow —
  up to 65k queries per tile; 64 = fast but blocky) — coarser settings
  also make the grid's actual cell size visible as real blockiness, not
  just a rendering artifact.

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
python3 scripts/build_grid_index.py       # -> data/nl_grid.bin (approach C; GRID_MAX_DEPTH env var, default 18)
GRID_BOUNDARY_FILL=random  python3 scripts/build_grid_index.py  # -> data/nl_grid_d_random.bin  (approach D)
GRID_BOUNDARY_FILL=nearest python3 scripts/build_grid_index.py  # -> data/nl_grid_d_nearest.bin (approach D, deterministic variant)
python3 scripts/benchmark.py              # compares approaches A/B/C
python3 webapp/server.py                  # interactive demo, all four approaches
```
