# Data pipeline stages

This documents the `data/` directory layout and file dependency graph
across the three build datasets (Zuid-Holland, Europe, World), so it
doesn't need to be re-derived from scratch next time it comes up. It
reflects the repo as of a full history rewrite (`git filter-repo`) that
dropped every generated `data/` artifact from git tracking, keeping only
documentation and the one hand-crafted spec fixture (2026-09-28).

## tl;dr

**Almost nothing under `data/` is tracked in git any more.** Every stage
is a local, reproducible build artifact -- raw downloads, osmium
extractions, resolved hierarchy/geometry, and all three `.bin` files are
gitignored. The only tracked file under `data/` is
`data/03-final/appendix-a-example.bin` (a hand-extracted `reader/binary-format.md`
spec fixture, not pipeline output). A fresh clone has an essentially
empty `data/` and must run the download + build scripts to populate it.

```
data/00-raw/          external downloads (including the ~80GB
                       planet-latest.osm.pbf)
data/01-extracted/    osmium-exported admin boundaries (World only, now)
data/02-resolved/     resolved hierarchy + geometry (per dataset: nl/eu/world)
data/03-final/        the final .bin files + reader sidecar indexes
```

**There is now only one real resolution pipeline: `prepare-world.ts`.**
It resolves the whole world's per-country region/city hierarchy once, into
`data/02-resolved/world/`. Both smaller test datasets are built by
filtering that already-resolved output down to a scope, not by a separate
extraction + resolution pass:

```
data/01-extracted/world/*-admin.geojson
        │ prepare-world.ts (full per-country admin_level resolution,
        │   already correct for every country -- see countryAdminLevels.ts)
        ▼
data/02-resolved/world/{hierarchy.json, regions.geojsonseq,
                        country-polygons.geojson, cities-filtered.geojsonseq}
        │ filter-by-scope.ts --only-country NL
        │              --out-dir data/02-resolved/nl
        │ filter-by-scope.ts --only-continent Europe
        │              --out-dir data/02-resolved/eu
        ▼
data/02-resolved/{nl,eu}/{hierarchy.json, regions.geojsonseq,
                          country-polygons.geojson, cities-filtered.geojson[seq]}
        │ compressor/src/cli.ts (cgeodata-compress), same for all three
        ▼
data/03-final/{zuid-holland,europe,world}.bin
```

The pipeline is **strictly linear, no cycles**.

## Why `prepare-zuid-holland.ts`/`prepare-europe.ts` were deleted

Both scripts existed because the Zuid-Holland/Europe test datasets used
to come from the deleted Python prototype's own output
(`nl_cities.geojson`, `eu_cities.geojson`) rather than from
`prepare-world.ts`'s worldwide resolution. Investigating why
`eu_cities.geojson` (313MB, gitignored, un-backed-up) couldn't be replaced surfaced that it didn't need to be: both
files are OSM `admin_level=10`-equivalent data resolved per-country, and
`prepare-world.ts`'s own per-country `COUNTRY_ADMIN_LEVELS` resolution
already does the same job, more accurately, for every country in the
world (confirmed: `data/03-final/world.bin`'s NL data resolves real
cities in every Dutch province, where the old Zuid-Holland fixture only
ever had cities in Zuid-Holland itself — see
`compressor/test/zuid-holland.test.ts`'s "every province has real cities"
test). Both prototype files have since been deleted (`eu_cities.geojson`
with `prepare-europe.ts`, `nl_cities.geojson` on 2026-10-14); neither
was recoverable from git, and nothing in the current pipeline can
regenerate them.

`data-ingest/src/filter-by-scope.ts` replaces both scripts with one tool:
given `--only-country <CODE[,CODE...]>` or `--only-continent <name>`
(Natural Earth's `CONTINENT` field, e.g. `"Europe"` — 51 countries,
different from `eu_cities.geojson`'s old Geofabrik-extract-shaped
coverage, which included Turkey/Cyprus), it filters
`data/02-resolved/world/*` down to that scope and writes the same four
file shapes the compressor CLI already expects. This deleted the "0
cities outside Zuid-Holland" property of the old fixture (see the test
file above) — Section 7.2's "a region MAY have 0 cities" rule is still
exercised, just by `compressor/test/build.test.ts`'s synthetic fixture
instead of a real-world one.

## Stage diagram (current)

```
data/00-raw/
├── osm/                     planet-latest.osm.pbf (whole-planet extract,
│                            ~80GB over HTTPS from planet.openstreetmap.org)
│                            download: scripts/download-osm.sh
├── geonames/                cities500.txt, admin1CodesASCII.txt
│                            download: scripts/download-geonames-naturalearth.sh
└── natural-earth/           ne_10m_admin_0_countries.geojson
                             download: scripts/download-geonames-naturalearth.sh
        (all of data/00-raw/ is gitignored -- see "Gitignore quick reference")

        │ Dockerfile.tools (repo root) + osmium, via
        │ data-ingest/scripts/extract-boundaries.sh
        ▼
data/01-extracted/           osmium-exported admin boundaries (gitignored)
└── world/*-admin.{osm.pbf,geojson}   the only stage-1 output any current
                                       script reads (extract-boundaries.sh
                                       always targets world/)

    (data/01-extracted/nl/, data/01-extracted/eu/ may still exist on disk
    locally -- nothing deletes old gitignored files automatically -- but
    nothing reads them any more; safe to remove)

        │ prepare-world.ts
        ▼
data/02-resolved/world/       gitignored, entirely local build output
├── hierarchy.json
├── regions.geojsonseq           (763MB, unsimplified)
├── country-polygons.geojson
├── cities-filtered.geojsonseq   (4.4GB)
└── duplicate-cities.tsv         (cities with byte-identical geometry,
                                  for reporting; nothing reads it)

        │ filter-by-scope.ts --only-country NL / --only-continent Europe
        ▼
data/02-resolved/{nl,eu}/     gitignored, entirely local build output
├── hierarchy.json
├── regions.geojsonseq
├── country-polygons.geojson
├── nl/cities-filtered.geojson       (38MB)
└── eu/cities-filtered.geojsonseq    (2.1GB)

        │ compressor/src/cli.ts (cgeodata-compress)
        ▼
data/03-final/                 gitignored, entirely local build output --
                                see appendix-a-example.bin below, the one
                                exception
├── zuid-holland.bin
├── europe.bin
├── world.bin
├── world_high_res.bin         on-demand exploratory build
└── world_no_chunk.bin         on-demand (deliberately never committed --
                                goes stale instantly)

        │ reader/src/cli.ts (build-search-index / build-locate-index)
        ▼
data/03-final/ (sidecars)      optional, gitignored, reader-only -- never
                                consumed by data-ingest or compressor
├── world.search-index.bin
├── world.locate-index.bin
└── world.checks.json              spot-checks run against the .bin (verify/src/export.ts),
                                   which the demo draws as markers; the Docker build
                                   makes it from the shipped .bin

CONSUMERS (read-only, not part of the build):
├── demo/src/server.ts, demo/playwright.config.ts   default to data/03-final/zuid-holland.bin
├── compressor/test/zuid-holland*.test.ts           skip if the .bin is absent
└── verify/test/world-queries.test.ts               the worldwide .bin (world-high-res.bin, else
                                                    world.bin); skip if absent

OUTSIDE ALL PIPELINES:
└── data/03-final/appendix-a-example.bin   hand-extracted from reader/binary-format.md's
                                            own Appendix A hex dump (commit 1f38d134),
                                            a reader/ fixture, not pipeline output.
```

## Download scripts

`data-ingest/scripts/download-geonames-naturalearth.sh` fetches the two
GeoNames files and Natural Earth's country outlines into
`data/00-raw/{geonames,natural-earth}/`, writing atomically (download to
`<dest>.part`, `mv` into place) and conditionally (`lib/download.sh`'s
`download_file` stores the server's ETag in a `<dest>.etag` sidecar and
sends `If-None-Match` on the next run, so re-running when nothing changed
costs one small request per file instead of re-downloading gigabytes).

`data-ingest/scripts/download-osm.sh` fetches the whole planet as a single
`planet-latest.osm.pbf` from
https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf into
`data/00-raw/osm/`, replacing the old per-continent Geofabrik extracts (and
the separate Netherlands-only extract) with one canonical, always-current
file. It goes through the same `lib/download.sh` helper, so it is atomic
and ETag-conditional exactly like the GeoNames/Natural Earth fetch above:
re-running it when the planet file hasn't been re-cut costs one small
request instead of ~80GB. (OSM's own download page recommends BitTorrent
or a mirror for a file this size; a torrent client would handle its own
resume and integrity checking and would not need `lib/download.sh` at all,
but that is not what this script does today.)

Both scripts are reachable from the root `Makefile` as file rules, so
`make world` *will* fetch the planet file if it is missing -- there is no
guard against that. The ~80GB, multi-hour download is still meant to be an
explicit, visible step, so run `make download` (or `download-osm.sh`) on
purpose and confirm it finished before kicking off a `make world` on a
machine that doesn't already have the input.

## `agent-resources/`

Kept separate from `data/00-raw/` on purpose: it now holds only
non-pipeline reference/research material (`agent-research.md`, a vendored
mirror of Immich's own repo under `immich/`, a small Docker reference
under `base-images/`) that no build script reads — not another kind of
raw input. The two actually-used GeoNames/Natural Earth files that used
to live here moved into `data/00-raw/geonames/` and
`data/00-raw/natural-earth/`; two confirmed-dead files
(`countryInfo.txt`, `admin2Codes.txt` — vendored alongside the used files
but never read by any code in `data-ingest/`, `compressor/`, `reader/`,
or `demo/`) and the redundant `cities500.zip` (only the unzipped
`cities500.txt` was ever read) were dropped rather than carried forward.

## Gitignore quick reference

`data/*` is gitignored wholesale; only one path is explicitly
un-ignored (root `.gitignore`, see its own comments for the exact
negation-pattern mechanics):

```
data/03-final/appendix-a-example.bin COMMITTED (reader/binary-format.md spec fixture)

(everything else under data/ is gitignored, including all of
 data/02-resolved/ -- dropped from git entirely by the 2026-09-28 history
 rewrite, having been briefly re-committed after that rewrite, then
 removed again once it was confirmed it isn't actually needed in git)

agent-resources/                gitignored (whole dir -- reference material)
data/search-index/  *.pbf  *.pbf.part  .venv/  __pycache__/  *.pyc
node_modules/  dist/  playwright-report/  test-results/  cgeodata-demo.tar.gz
```

## Hardcoded path constants

No script here takes a `--input-dir`/`--output-dir` flag (except
`filter-by-scope.ts`'s own `--out-dir`); every other stage boundary is a
literal path constant, so a future move means editing all of these
together by hand:

- `data-ingest/scripts/extract-boundaries.sh` — `OSM_DIR`, `WORK_DIR`
- `data-ingest/scripts/download-osm.sh` — `OSM_DIR`
- `data-ingest/scripts/download-geonames-naturalearth.sh` — `RAW_DIR`
- `data-ingest/src/prepare-world.ts` — `WORK_DIR`, `COUNTRIES_SOURCE`,
  `CITIES500_SOURCE`, `ADMIN1_CODES_SOURCE`, `HIERARCHY_OUT`, `CITIES_OUT`,
  `REGIONS_OUT`, `COUNTRIES_OUT`
- `data-ingest/src/filter-by-scope.ts` — `WORLD_DIR` (its four `*_SOURCE`
  constants), `NATURAL_EARTH_SOURCE`; `--out-dir` is the one genuinely
  parameterized path in this whole pipeline
- `demo/src/server.ts`, `demo/playwright.config.ts` — default/test `.bin` path
- `build-world-on-remote-machine.sh` — `REQUIRED_DATA_FILES`, rsync
  excludes, the remote compressor invocation
