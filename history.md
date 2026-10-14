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
  unrelated countries; see "Ireland/Estonia/Portugal-shaped region gaps"
  under "Issues fixed along the way" below, and [countries.md](countries.md).


## Development log of the TypeScript implementation

The notes below used to live in the README. They are the story of how the
current implementation got here: bugs found by clicking around the demo,
what a CPU profile showed, how the builds scaled from the Netherlands to
Europe to the planet, and what was measured along the way. Read them for the
reasoning behind a design choice; they are not instructions. Numbers are
from the build they were measured on and several are superseded (each says
so where it knows). File and script names in them may no longer exist.

### Where the test datasets come from

This originally involved extracting
`data/01-extracted/nl/nl-admin.geojson` via Docker/osmium so
`prepare-zuid-holland.ts` could build the Zuid-Holland/Europe test
datasets from it plus the Python prototype's `nl_cities.geojson`/
`eu_cities.geojson`. Both scripts (`prepare-zuid-holland.ts`,
`prepare-europe.ts`) were deleted (2026-09-28) once
`data-ingest/src/filter-by-scope.ts` made them redundant: the worldwide
pipeline's own per-country `admin_level` resolution already covers the
Netherlands and Europe more accurately than either script did (see
`data-ingest/PIPELINE-STAGES.md` for the investigation), so `zuid-holland.bin`
and `europe.bin` are now built by filtering the worldwide pipeline's
already-resolved output down to a country or continent, not by a separate
extraction pass. No Docker/osmium step is needed for either dataset any
more (`make netherlands` and `make europe`).

### Two real bugs found by browser testing

Manually clicking around the demo (not just running the two coordinates
above) surfaced a real gap: a point inside Utrecht -- outside every one of
Zuid-Holland's 187 city polygons, but still genuinely inside the
Netherlands -- resolved to fully `unknown` instead of `country: The
Netherlands, region: Utrecht`. Two separate bugs, found in order:

1. **The compressor never had region or country geometry at all.** Only
   city polygons were ever fed into the spatial index, even though the
   place table already listed all 12 provinces. There was no OSM boundary
   data checked into the repo for that -- `data/01-extracted/nl/nl-admin.geojson`
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
project (since fixed by `classifyCell`, see "Issues fixed along the way"
below).

Current numbers for this dataset (country + 12 provinces + 187 Zuid-Holland
cities): `--max-depth 10` (~600m cells at this grid size) takes about 76
seconds. `--max-depth 12` (~150m) was reachable in ~21s *before* the
containment-rule fix above, but that number was measured against the
buggy, prematurely-truncated recursion -- worth re-measuring once
`touches`/`fullyContains` are also sped up, rather than trusting it as-is.

### Europe-wide build

The build below (41 countries, 642 regions, 138,106
cities) was produced by `prepare-europe.ts` from
`data/00-raw/orphan/eu_cities.geojson` (the Python prototype's output)
plus a streamed pass over `data/01-extracted/eu/eu-admin.geojson`.
`prepare-europe.ts` was deleted (2026-09-28) in favor of
`data-ingest/src/filter-by-scope.ts --only-continent Europe`, which
filters the worldwide pipeline's own already-resolved output instead (see
`data-ingest/PIPELINE-STAGES.md`) -- the current `data/03-final/europe.bin`
covers 51 countries (Natural Earth's `CONTINENT == "Europe"`, a
different, and differently-bounded, set than `eu_cities.geojson`'s
Geofabrik-extract-shaped coverage) and 183,970 cities, not the numbers
measured below. The bugs this section documents (region-drop in Ireland/
Estonia/Portugal, admin_level variance) were specific to that now-deleted
pipeline's approach and were independently rediscovered and fixed,
differently, by the worldwide pipeline's own per-country
`COUNTRY_ADMIN_LEVELS` table -- kept as the record of how that variance problem was first found.

The original build ran `prepare-europe.ts` and then the compressor CLI
with `--max-depth 8` and 16 workers. (`make europe` builds the current
`europe.bin` instead.)

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
`fullyContains` cost is fixed, see "Issues fixed along the way" below;
pushing depth further worldwide is still blocked on the small-territory
coarse-polygon issue documented in countries.md.)

### Worldwide build (`make world`)

Everything in this section up to the numbers was written when `data/00-raw/osm/` held one `.osm.pbf` per continent (Geofabrik
extracts), each fed through `data-ingest/scripts/build-world.sh`. Both have
since been replaced: `data/00-raw/osm/` now holds a single whole-planet
`planet-latest.osm.pbf` (`data-ingest/scripts/download-osm.sh`, see
`data-ingest/PIPELINE-STAGES.md`), and `build-world.sh` was deleted in
favor of the root `Makefile`'s `make world` target, which chains the same
steps (download → Docker-based extraction → `prepare-world.ts` →
compressor) and skips whatever's already up to date. The cross-file
relation-id dedup and per-country admin-level detection this section
describes are unaffected by that change -- a single planet file still goes
through the same merge/dedup/detection logic, it just never has more than
one file to merge in the first place.

At the time this section was written, Europe's pipeline only worked
because `data/eu_cities.geojson` already existed -- cities with region and
country pre-resolved, produced by the Python prototype that has since
been deleted. No such file existed for any other continent, so going
worldwide meant building that step from scratch in TypeScript rather than
reusing a prepared artifact. (That TypeScript resolution -- Pass 1/1.5/2
below -- has since become the *only* pipeline for Europe too, see
"Europe-wide build" above.)

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
   3-pass algorithm described in [the section above](#one-admin-level-per-country-is-wrong-so-is-one-per-continent)
   (accumulate area by `(country, level)`, take the finest level covering
   >=60% of the country, then gap-fill anything a primary polygon doesn't
   already cover) was Python-only and is now gone. The port keeps its
   behavior exactly, including the case the section above doesn't spell
   out -- when *no* level clears 60%, fall back to whichever has the
   largest share, recovered from `git show
   55c4a6f:scripts/extract_boundaries_europe.py` rather than guessed at.

Memory is bounded by holding only scalars (id, country, level, area,
representative point, bbox) for every candidate during the area-
accumulation pass, and no city geometry after it: primaries are streamed
from the corpus one at a time, tested against an index of the gap-fill
candidates' points, and written out as the geometry text osmium produced
-- so peak RSS tracks the candidate *count*, not the corpus or the output.
On a 640MB DE/FR/NL benchmark corpus that took a run from 45s wall / 76s
CPU / 1.3GB peak RSS (the earlier batched, geometry-holding design) to
18s / 22s / 0.5GB, with byte-identical output.

Run on `australia-oceania` (30,562 boundary relations, back when that was
its own extract file): 21 countries get a
primary level, 15,800 primary + 147 gap-filled cities, 14,887 kept after
dropping 5 unnamed and 1,055 with no region. Australia resolves at
`admin_level=9` (gazetted localities -- Sydney, Melbourne and their
suburbs all present), New Zealand at 6 (its real territorial authorities:
Wellington City, Hamilton City, Dunedin City...). The no-region drops are
the same class of gap Europe has in Ireland/Estonia/Portugal: those places
still resolve at country level, and the count is reported per country
rather than silently swallowed.

**The full 8-file worldwide build works end to end**, producing
`data/03-final/world.bin` from `data/02-resolved/world/hierarchy.json`,
`regions.geojson`, and `country-polygons.geojson`. As of the 2026-09-28
history rewrite, none of `data/` is committed to git any more except
`data/03-final/appendix-a-example.bin`
(see `data-ingest/PIPELINE-STAGES.md`) -- `world.bin` and its inputs,
including the 4.0GB `cities-filtered.geojsonseq`, are all local,
reproducible build output, rebuilt via `make world` rather than tracked in
git.

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
fail fast rather than repeat this project's whole-machine OOM. (Batching
and that guardrail have since been replaced by streaming primaries without
holding their geometry at all -- see the memory note above.)

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

`data/03-final/world_no_chunk.bin` is the same build with `--only-chunks ''` -- the
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
start), with each candidate's geometry packed into one `Float64Array`
(`packGeometry`) -- cloned as nested GeoJSON it stopped being cheap once
chunk work got faster, 37s of a 128s single-worker benchmark build, 4s
packed; jobs are dispatched worst-first by a cheap coordinate-count cost
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

(Since done, 2026-10-08: `boundaryContact` now walks only the y-bands of a
ring that the cell spans, reusing the band index the ray cast already had;
candidates travel to workers as packed `Float64Array`s instead of GeoJSON;
and the max-depth tie-break casts each sample row's rays together. On a
synthetic benchmark -- Natural Earth 10m countries at full precision,
admin-1 regions simplified at 0.01, 5,290 Voronoi cities averaging ~720
vertices, `--max-depth 8`, 4 workers -- chunk work went from 622s to 28s,
wall clock from 171s to 10s and peak RSS from 1.26GB to 0.61GB, with
byte-identical output. The numbers in this section predate that and are
worth re-measuring, the region tolerance especially.)

(Since done, 2026-10-13: regions are no longer simplified at all. The
1.1 km tolerance turned small region parts into slivers and dropped the
cities on them, Campione d'Italia among ~480 others; countries.md's
"Simplified region polygons" has the measurement.)


### Issues fixed along the way

- **Search ranked equal matches by id, and had no `<place>, <region>`
  queries.** Immich's integration found "berlin" put Berlin, Germany at
  rank 14 behind thirteen US Berlins. The locate index (now kind 2
  version 1) stores an area byte per place: `1 + floor(4 × log2(cells))`
  of its subtree's cells, computed exactly. With one attached, a sorted
  search ranks by Appendix B.5.1's area order:
  1. folded tier;
  2. country first;
  3. rank area;
  4. spelling bonus;
  5. city before region;
  6. id.

  A region's rank area is that of its largest city with the same local
  name, so the province of Utrecht follows the city of Utrecht while
  city-state regions (Berlin, Vienna) rank by their own size.
  `areaTieBreak` (`"auto"`, `true`, `false`; CLI `--area-tie-break`)
  chooses. `"auto"` deliberately makes a sidecar's presence change the
  order (never the set) of results. The alternative, computing areas
  from the chunks when no index is there, costs 5-10 s, and sidecars
  are meant to be built wherever the `.bin` is used. The search index
  (now kind 1 version 3) records in `relevance_rule` which order its
  short-query table was built in. A reader only uses that table when it
  ranks the same way, since a live scan of a 1-2 character query costs
  ~0.6 s against ~0.12 s from the table. A table in area order is bound
  to the chunks by Appendix C.4's prefix checksum. Queries with commas
  (Appendix B.13) read both as a whole name ("Stormont, Dundas and
  Glengarry Counties") and as a head plus ancestors, nearest first:
  "Paris, Texas" and "Springfield, Illinois, United States" each give
  exactly one result.

- **Search had no diacritic folding, and ranked city above country even
  when the query was a country's own name.** Fixed in two parts, both in
  `reader/src/relevance.ts` and specified in `reader/binary-format.md` Appendix
  B.2/B.5/B.6/B.9 (search-index format bumped to kind 1 version 2, since
  the short-query table's stored contents depend on the exact relevance
  rule and nothing in the file format itself records which rule built
  it): (1) matching and ranking now compare the diacritic-folded form of
  names (`foldDiacritics` -- NFD, strip combining marks, lowercase;
  distinct from the trigram index's own, heavier `foldSymbols` folding,
  which also buckets digits/punctuation together and would be too loose
  for deciding match quality), so `search data/03-final/world.bin
  munchen` now finds München -- verified on the real worldwide dataset,
  not just the spec's synthetic example; a query whose own spelling
  reaches a tier without folding still ranks above one that needed
  folding to reach the same tier (an "exact spelling bonus"), so typing
  a name's diacritics correctly is rewarded, not required. (2)
  `LEVEL_BONUS` now favors an exact country match over a same-quality
  city or region (country `3`, city `2`, region `1` -- only country
  jumps the queue; a plain three-way reversal was tried first and
  rejected, since it would also rank an exact match on a *region*
  (Antwerpen the province) above an identically-named *city* (Antwerp),
  which is backwards for the far more common case of searching a city's
  own name).

  One real correctness bug was found and fixed during implementation,
  not anticipated going in: the short-query table precomputes a ranking
  per *folded* 1-2-character key (e.g. `e`), but the exact spelling bonus
  depends on the query's own, possibly different, unfolded spelling
  (`e`, `é`, and `ë` all fold to the same key but don't all earn the same
  field the same bonus) -- so a reader now only answers a short query
  from the table when the query's own folded form already equals its
  plain lowercase form (no diacritic of its own to fold), falling back
  to a live scan otherwise (Appendix B.12's `ë` query walks through why
  trusting the table there would have given a wrong answer). Caught by
  the project's own index-vs-no-index agreement test suite, not
  discovered by hand.

  The specific `Nederland` example that motivated this fix doesn't yet
  show the improvement on the real worldwide dataset: Natural Earth's
  `ne_10m_admin_0_countries.geojson`, the current country source, has no
  local-name field at all, so the Netherlands' only stored name is the
  English `Netherlands` -- see "International/local name pairs aren't
  populated for countries" above, a separate, already-known data gap
  this fix doesn't touch. Confirmed directly: `search world.bin
  Nederland --sort` still returns a Dutch *city* literally named
  Nederland first, because the country has no `Nederland` field to match
  against at all, exact-match bonus or not.

- **Regions with no cities were dropped from the build (Libya, Egypt,
  Chad, Sudan, and 110 other countries).** Tripoli, Cairo, N'Djamena and
  Khartoum all resolved to `region: -` even though
  `data/02-resolved/world/regions.geojson` had their region polygons (Libya 23, Egypt
  27, Chad 23, Sudan 18). Root cause: `prepare-world.ts` built each
  country's hierarchy region list *only* from regions that received at
  least one emitted city, and the compressor only builds regions the
  hierarchy lists -- so a country with no city tier (Libya, Egypt) lost
  every region, Chad kept only `Ouaddaï` (the one region holding its 5
  cities), and Sudan lost Khartoum State plus five eastern states.
  Worldwide, 2,142 of 6,041 region polygons across 114 countries were
  missing, 22 of those countries ending up with zero regions (Eswatini,
  Fiji, Seychelles, Vanuatu, ...). Fixed by seeding the hierarchy from
  every region polygon; `reader/binary-format.md` Section 7.2 already allows a
  region with zero cities. Verified on an Africa-only scoped build: all
  four capitals now resolve to their correct region.

- **Ireland/Estonia/Portugal-shaped region gaps.** Previously documented
  (and, before that, in `prepare-europe.ts`/the deleted Python prototype)
  as an accepted OSM data-tagging quirk, first written up in the Python
  prototype's Europe scaling test as a limitation "worth fixing properly
  later." It turned out to be a real
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

  **Rebuilt and committed** (`data/03-final/world.bin`, `info` command): 239
  countries, 3,899 regions (was 2,595), 294,914 cities (was 252,721) --
  matching the dry-run numbers above exactly.
- **The `touches()`/`fullyContains()` exact-arithmetic bottleneck.**
  First identified in "Performance: what a CPU profile actually showed"
  below as the dominant remaining cost after replacing `@turf/intersect`,
  and called out again in the Python prototype's Europe scaling test as
  an open follow-up. Fixed by `geometry.ts`'s `classifyCell` (see this repo's
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
  conforming to `reader/binary-format.md` Appendix B. The coordinate per result
  comes from `CGeoDataReader.locate()`, backed by a place location index
  (`build-locate-index`, `reader/binary-format.md` Appendix C) that turns a
  ~1.6s scan of every chunk into a sub-millisecond read.
