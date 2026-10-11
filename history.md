# History: what the Python prototype taught us

Before the TypeScript implementation there was a Python prototype
(`scripts/` and `webapp/`, plus the `.bin` files it produced). It compared
four ways of answering "which city is this coordinate in?" on the
Netherlands, then scaled the winner to all of Europe to see where it broke.
The code and data are deleted, because the TypeScript packages
([`reader/`](reader/), [`compressor/`](compressor/),
[`data-ingest/`](data-ingest/), [`demo/`](demo/)) superseded them. This file
keeps what the prototype *established*, since those measurements are why the
current design looks the way it does and re-deriving them would mean
rebuilding the prototype.

You do not need any of this to use the project. It is background for anyone
who wonders "why a grid and not polygons?", "why zlib?", or "why does the
admin level differ per country?". The current system is described in the
[README](README.md), the format in [reader/binary-format.md](reader/binary-format.md).

## The four approaches

All four were graded against the same Netherlands data (OSM `woonplaats`
polygons, 2,521 cities), with approach B as ground truth.

| | Approach | What it does |
|---|---|---|
| A | **Nearest labeled point** | A KD-tree over one lat/lon point per place (1,616 for NL): what Immich and the system it replaces do. The baseline, included to demonstrate the problem. |
| B | **Exact point-in-polygon** | An STRtree over the real polygons; `contains()` at query time. Ground truth, and the thing everything else is measured against. |
| C | **Adaptive Morton grid, with polygon fallback** | Recursively subdivide a world-aligned quad grid; stop as soon as a cell is *uniform* (no city touches it, or exactly one city fully contains it). Store the leaves sorted by Morton (Z-order) code, so a query is one binary search. A cell still ambiguous at the depth cap is marked `BOUNDARY`, and queries landing in one fall back to approach B. |
| D | **Adaptive grid, resolved at build time** | Same grid as C, but an ambiguous cap-depth cell gets a winner picked *at build time* from the cities that actually touch that cell, and the city id is stored like any other leaf. No fallback data is needed at query time. |

D's winner rule was tried three ways: random, nearest polygon to the cell
centre, and the candidate covering the largest share of the cell. Largest
share was the keeper, and it is still the max-depth tie-break in
`compressor/src/quadtree.ts`.

### Results (Netherlands)

| Approach | On-disk size | Accuracy vs. ground truth | Query speed |
|---|---|---|---|
| A. Nearest labeled point | 55 KiB | 26–46% | ~14–21 µs |
| B. Exact point-in-polygon | 41.5 MiB (uncompressed GeoJSON) | 100% (it *is* the ground truth) | ~24–41 µs |
| C. Grid + exact fallback | 0.60 MiB + fallback data | 100% | ~6 µs interior, ~39 µs border-adjacent |
| D. Grid, self-contained | 0.54–0.60 MiB, nothing else | ~97% (exact away from borders) | ~7 µs interior |

The existing production system stored 112 MiB worldwide. Two coordinates
from the original brief, which A got wrong and B/C/D got right:

```
52.488789, 4.794346  expected Wormerveer   A said Zaandijk
52.034656, 4.388124  expected Den Haag     A said Ypenburg
```

The benchmark sampled 300 random interior points and 300 points jittered ~1 m
from a real city border (the adversarial case):

| | Interior points | Points ~1 m from a border |
|---|---|---|
| A, agreement with B | 45.7% | 25.3% |
| C, agreement with B | 100% (fallback needed for 10/300) | 100% (fallback needed for 300/300) |
| A / B / C, time per query | 14.4 / 24.3 / 6.4 µs | 14.0 / 30.7 / 38.5 µs |

On a realistic mix the grid was both the smallest and the fastest, because
~97% of queries never touch polygon geometry. It only lost on speed in the
adversarial all-boundary case, where every query pays for the fallback plus
its own grid lookup.

## What we learned

### 1. Nearest-point is wrong, by a lot

Right only 26–46% of the time against real boundaries, and worst exactly
where it matters, near borders (25% within a metre of one). Cities are not
points: a big city's label point can be nearer to a neighbour's border than
its own. This is the founding motivation, and the README's "Why
nearest-point is wrong" is the short version.

### 2. A grid beats polygon tests on size *and* speed

Interior cells are decided without any geometry, so the common query is a
binary search over a few hundred thousand integers. The polygon data is only
needed to *build* the grid, never to query it, which is why the format ships
without any geometry (approach D's insight, adopted by CGEODATA).

### 3. Do not push every ambiguous cell to the precision floor

The first design subdivided every ambiguous cell down to a fixed ~10 m floor
(depth 22). It produced 17.7M leaf records and a 135 MB file, which lost to
the 112 MB budget it was meant to beat. Dutch boundaries follow canals, have
enclaves and pack many small localities tightly, so ambiguous cells are
common well below the 1 km scale.

The fix was to cap recursion much shallower (depth 18, ~370 m × 300 m cells)
and resolve what is still ambiguous there. Depth then only trades file size
against how often the slow or approximate path is taken; it does not need
tuning against the precision target. CGEODATA keeps this shape:
`--max-depth` caps the quadtree, and `quadtree.ts` resolves max-depth cells
by largest share.

### 4. A Morton-code bug worth remembering

The first working `make_record()` padded a shallow cell's code with a `1` bit
at the cell's midpoint (an S2-style sentinel). That seems right from memory
but breaks the invariant binary search depends on: a shallow cell's stored
code must be ≤ every point inside it. Plain zero-padding (code = cell start)
guarantees that; midpoint padding silently misclassified queries in the first
half of an ambiguous cell (the Den Haag test point fell through to `None`).

### 5. Columnar layout and delta varints did most of the compression

Packing each leaf as one 8-byte record (44-bit Morton code, 5-bit depth,
15-bit payload) gave 7.4 MB. Two changes took it to ~0.6 MB without storing
anything different:

1. **Split into columns:** all codes, then all depths, then all payloads, so a
   general compressor sees repetition instead of interleaved unrelated bytes.
2. **Delta-encode the sorted codes as varints:** consecutive Morton codes are
   close, so most become 1–2 bytes instead of a fixed 8. That alone shrank the
   code stream from 7.6 MB to under 1 MB.

On 954,497 records: 7,744,895 bytes interleaved, 3,824,888 columnar with
delta varints, **632,143 bytes** after zlib level 9. This is the encoding
`reader/binary-format.md` generalises (Morton-ordered records, varints,
per-chunk deflate).

### 6. zlib, because it is built in everywhere

On the records blob alone: zlib 523 KB, zstd -19 427 KB, brotli -q11 423 KB.
zstd and brotli win by 10–20% (brotli is also much slower to compress, though
that is a one-time cost), but delta varints had already captured most of the
gain, and zlib is a zero-dependency built-in in both Node.js
(`zlib.inflateSync`) and browsers (`DecompressionStream('deflate')`). Immich
runs Node.js, so a native addon or wasm blob for ~15% was not worth it.

### 7. The cost is decoding, not decompression

Inflating was a few milliseconds. Turning varint bytes back into absolute
codes was a plain Python loop at ~150–170 ms for ~954K records: a one-time
startup cost, not a per-query one. This foreshadowed the reader's design:
split the world into independently-decompressible chunks so a lookup decodes
only the one it needs.

### 8. Seeing the output beats reading a table

The prototype's demo had a click-to-query popup showing each approach's
answer, and a Leaflet tile overlay that coloured each pixel block by a hash
of the resolved city id. A rendered as a scatter of Voronoi-cell blobs that
ignore real borders. B and C rendered identically, with jagged borders that
follow the polygons. D matched C everywhere except a jagged seam along every
border, which is exactly its build-time tradeoff. That made the accuracy
differences obvious in a way the numbers had not, and it is why `demo/`
exists (and why odd-looking tiles are how most of
[countries.md](countries.md) was found).

## What scaling to Europe taught us

The same pipeline was run on all of Europe (a 35 GB `europe-latest.osm.pbf`),
using `admin_level=8` everywhere as a crude "city" proxy. It found four
problems, all fixed:

1. **Memory.** The build OOM'd the whole machine session, not just the
   process. About 123 country-level relations at full precision (Norway,
   Croatia, ...) plus 152,165 city polygons, all held at once, went far past
   available RAM. Fix: simplify geometry on load, before anything
   accumulates, and run the build in a `systemd-run --user --scope -p
   MemoryMax=...` cgroup so a repeat kills only that scope. The same lesson
   shaped the current pipeline: `prepare-world.ts` never holds city geometry,
   and CLAUDE.md recommends the cgroup for big builds.
2. **A field too narrow.** The 2-byte payload (max 65,535) was fine for NL's
   2,521 cities and crashed on Europe's 152,165. Widened to 3 bytes, and the
   file format version was bumped so an old file can never be silently
   misread. CGEODATA's sidecar indexes record a kind and version for the
   same reason.
3. **The name table, not the index, dominates size.** At NL's scale the
   compressed spatial index and the raw city strings were comparable. At
   Europe's, the strings were 7.42 MB of a 7.42 MB file (99.94%) while the
   compressed index was 4.5 KB. Compressing the table too brought the file to
   1.65 MB, 4.5× smaller, by fixing the part that had never looked like a
   bottleneck. CGEODATA's name blocks (keyframe-compressed, resolved by id)
   follow the same lesson.
4. **Country resolution needs a fallback, and the fallback needs a fix.**
   France's own `admin_level=2` relation does not assemble in a Europe-only
   extract (a geographic clip cuts away overseas members and breaks the
   multipolygon). Falling back to Natural Earth's country polygons cut
   `missing_country` from 47,200 to 69 (30% to 0.05%). Then Natural Earth's
   `ISO_A2` turned out to be the literal string `"-99"` for France, and
   `ISO_A2_EH` ("everywhere, including disputed") is the field to use.
   Natural Earth remains the country source today; its `-99` territories and
   coarse outlines are still a source of bugs (see
   [countries.md](countries.md)).

### One admin level per country is wrong; so is one per continent

Berlin resolved to nothing, which looked like a narrow German quirk. The tile
overlay showed the same "no city" failure in Germany (Oberhausen, Münster),
the UK (Wiltshire), Bosnia (Tuzla), Poland and Latvia. A hardcoded
`admin_level=8` is not just imprecise, it is the wrong level for many
countries, and sometimes wrong *within* one:

- Germany's ~107 *kreisfreie Städte* (independent cities, which are their own
  county) are `admin_level=6`, ordinary towns are 8. They are complementary:
  level 8 alone covers ~96% of Germany's area yet omits exactly the cities
  most likely to matter.
- The UK only has a matching boundary at `admin_level=10` in some areas;
  Latvia's municipalities are 7; several countries use different levels for
  a settlement polygon and its containing municipality.

So the prototype auto-detected coverage in three passes, which the
TypeScript port kept (`data-ingest/src/lib/adminLevelDetection.ts`):

1. **Accumulate** polygon area by `(country, admin_level)` for levels 5–11.
   An earlier attempt to treat any level covering ≥3% as "supplementary"
   backfired: Germany's `admin_level=5` (a *region*) has high coverage simply
   because it is the union of everything below it. Raw area share cannot tell
   a standalone leaf from a coarse parent container.
2. **Pick a primary level** per country: the finest level that alone covers
   ≥60%. That reproduced the single-level behaviour (Germany 8, Latvia 8,
   UK 10, Poland 7).
3. **Gap-fill:** re-scan relations at other levels and add one only if
   nothing already kept covers its representative point. An ordinary Kreis's
   point falls inside one of its own child Gemeinden (covered, skipped as a
   redundant container); a kreisfreie Stadt's falls inside nothing (a genuine
   gap, added). That is the test that tells a leaf from a container.

This turned 152,165 single-level cities into 195,530 primary plus gap-filled
ones. It also introduced overlaps where complementary levels nest (Bosnia's
cantons and municipalities): a coarse gap-filled relation could contain an
already-correct finer one, and the grid picked whichever fully-containing
polygon its index returned first. Preferring the smallest-area polygon fixed
the common case. It left Tuzla, where the cell sits inside the canton without
being fully inside the municipality at the built depth, and recursion stops
once *any* polygon fully contains a cell. Exact lookup returned the
municipality while the grid returned the canton, right country but one level
too coarse. Forcing recursion down to the smallest candidate would fix it at
the cost of recursing deeper through every overlap zone. The same
trade-off, and the "a large candidate can out-vote a smaller one it contains
at shared boundary cells" mechanism, came back in the US/New York work
([countries.md](countries.md#united-states-of-america-us)).

Rebuilt at `MAX_DEPTH=14` (~1.2–1.6 km cells; the original was 10, ~25 km),
once the coverage fix was in, it stayed cheap:

| Stage | Time | Peak memory | Result |
|---|---|---|---|
| Filter the 35 GB pbf for boundaries | 5m00s | ~2 GB | 478 MB pbf, 370,644 relations |
| Export to GeoJSON | 1m23s | n/a | 4.36 GB, 419,697 features |
| Extract, resolve region/country, 3-pass detection | 11m52s | ~2.5 GB | 313 MB, 202,154 cities |
| Build the grid, depth 14 | 3m26s | n/a | 2,539,977 leaf records |
| **Total on disk (grid + compressed names)** | | | **3.57 MB** |

202,154 cities is 80× NL's 2,521. Spot checks of every bug-report location
(Germany ×2, England, Bosnia, Poland, Latvia) plus the original NL pair all
resolved to the right country, and all but Tuzla to the right city.

## What was deliberately not carried over

- **Python.** Immich runs Node.js, so the reader had to be JavaScript with no
  dependencies. CGEODATA is a new, formally specified format rather than a
  port of the prototype's "LG02"–"LG05" files.
- **The polygon fallback (approach C).** It shipped the entire polygon dataset
  for the ~3% boundary minority. A tighter version would store only the
  relevant edge segments per boundary leaf, but approach D avoids the whole
  problem at a small accuracy cost near borders, and the current format takes
  that deal.
- **One shared admin-level range.** The per-country table
  (`COUNTRY_ADMIN_LEVELS`) replaced it once a shared range proved to couple
  unrelated countries; see the README's "Known issues" and
  [countries.md](countries.md).
