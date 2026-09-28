# Data pipeline stages

This documents the `data/` directory layout and file dependency graph
across the three build pipelines (Zuid-Holland, Europe, World), so it
doesn't need to be re-derived from scratch next time it comes up. It
reflects the repo as of the `data/` restructuring into numbered stages
(2026-09-28).

## tl;dr

`data/` is organized into four numbered stages, each stage's script
reading only from earlier stages:

```
data/00-raw/          external downloads + the two orphan Python-prototype
                       outputs (see "Orphan inputs" below) -- nothing here
                       is produced by any script in data/01-extracted/ or later
data/01-extracted/    osmium-exported admin boundaries
data/02-resolved/     resolved hierarchy + geometry (per-pipeline: nl/eu/world)
data/03-final/        the final .bin files + reader sidecar indexes
```

The pipeline is **strictly linear, no cycles** — confirmed by tracing
every `prepare-*.ts`/`extract-boundaries.sh`/compressor-CLI input and
output path; nothing in an earlier stage ever reads a later stage's
output. Two structural quirks survive the restructuring and are
documented below rather than fixed, since fixing them is a separate,
larger decision:

1. `data/00-raw/orphan/` holds two files (`nl_cities.geojson`,
   `eu_cities.geojson`) that look like mid-pipeline output but are
   actually **irreplaceable raw input** from a deleted Python prototype —
   nothing in the current repo can regenerate them. See "Orphan inputs"
   below.
2. Only the World pipeline has a shell wrapper
   (`data-ingest/scripts/build-world.sh`). Zuid-Holland and Europe exist
   only as manual commands documented in `README.md`.

## Stage diagram (current)

```
data/00-raw/
├── osm/                     Geofabrik continent extracts (*.osm.pbf)
│                            download: scripts/download-osm.sh
├── geonames/                cities500.txt, admin1CodesASCII.txt
│                            download: scripts/download-geonames-naturalearth.sh
├── natural-earth/           ne_10m_admin_0_countries.geojson
│                            download: scripts/download-geonames-naturalearth.sh
└── orphan/                  nl_cities.geojson, eu_cities.geojson --
                              NOT downloadable, see "Orphan inputs" below
        (all of data/00-raw/ is gitignored except orphan/, which is committed
        -- see "Gitignore quick reference")

        │ Dockerfile.tools (repo root) + osmium, via
        │ data-ingest/scripts/extract-boundaries.sh (World, scripted)
        │ or a manual docker command (NL/EU, see README's "Reproducing")
        ▼
data/01-extracted/           osmium-exported admin boundaries (gitignored)
├── world/*-admin.{osm.pbf,geojson}   scripted (extract-boundaries.sh)
├── nl/nl-admin.{osm.pbf,geojson}     manual (README's "Reproducing" section)
└── eu/eu-admin.{osm.pbf,geojson}     LEGACY -- not reproducible by any
                                       current script (extract-boundaries.sh
                                       only targets world/); also holds two
                                       unused leftover experiment files,
                                       countries.geojson and france-only.*

        │ prepare-zuid-holland.ts / prepare-europe.ts / prepare-world.ts
        ▼
data/02-resolved/             resolved hierarchy + geometry, per pipeline
├── nl/{regions.json, zuid-holland-cities.geojson, provinces.geojson, country.geojson}   committed
├── eu/{hierarchy.json, regions.geojson, country-polygons.geojson}                        committed
├── eu/cities-filtered.geojson                                                            gitignored (327MB)
├── world/{hierarchy.json, regions.geojson, country-polygons.geojson}                     committed
└── world/cities-filtered.geojsonseq                                                      gitignored (4.4GB)

        │ compressor/src/cli.ts (cgeodata-compress)
        ▼
data/03-final/                 final .bin (all three primary outputs committed)
├── zuid-holland.bin           committed
├── europe.bin                 committed
├── world.bin                  committed
├── world_high_res.bin         gitignored, on-demand exploratory build
└── world_no_chunk.bin         gitignored, on-demand (deliberately
                                un-committed -- goes stale instantly)

        │ reader/src/cli.ts (build-search-index / build-locate-index)
        ▼
data/03-final/ (sidecars)      optional, gitignored, reader-only -- never
                                consumed by data-ingest or compressor
├── world.search-index.bin
└── world.locate-index.bin

CONSUMERS (read-only, not part of the build):
├── demo/src/server.ts, demo/playwright.config.ts   default to data/03-final/zuid-holland.bin
└── compressor/test/zuid-holland*.test.ts           skip if the .bin is absent

OUTSIDE ALL PIPELINES:
└── data/03-final/appendix-a-example.bin   hand-extracted from binary-format.md's
                                            own Appendix A hex dump (commit 1f38d134),
                                            a reader/ fixture, not pipeline output.
```

## Download scripts

`data-ingest/scripts/download-geonames-naturalearth.sh` fetches the two
GeoNames files and Natural Earth's country outlines into
`data/00-raw/{geonames,natural-earth}/`. `data-ingest/scripts/download-osm.sh`
fetches every OSM continent extract from Geofabrik into `data/00-raw/osm/`.
Both:

- write atomically (download to `<dest>.part`, `mv` into place, so a
  killed download never leaves a corrupt file);
- are conditional (`lib/download.sh`'s `download_file` stores the
  server's ETag in a `<dest>.etag` sidecar and sends `If-None-Match` on
  the next run, so re-running either script when nothing changed costs
  one small request per file instead of re-downloading gigabytes).

`download-osm.sh` pins every continent to the most recent first-of-month
Geofabrik snapshot rather than `-latest` or today's exact date — Geofabrik
only retains a rolling ~10 days of daily snapshots (a fixed historical
date like `africa-260918.osm.pbf` stops being fetchable once that window
passes) but keeps first-of-month snapshots indefinitely. It uses *last*
month's 1st specifically, to avoid a race in the first few days of a new
month before that month's snapshot has necessarily been cut. Netherlands
is the one exception, kept on `-latest`, since its filename is hardcoded
elsewhere (`extract-boundaries.sh`'s `EXCLUDE`, README's manual docker
command) and it's a small, manually-run pipeline where exact-snapshot
reproducibility matters far less than for the multi-hour worldwide build.

Neither script is wired into `build-world.sh` for the OSM download --
that's an intentionally separate, explicit step (currently ~85GB, hours
to fetch), not something that should happen silently as a side effect of
every build.

## Orphan inputs: `data/00-raw/orphan/{nl,eu}_cities.geojson`

These were produced by `scripts/extract_boundaries.py` /
`scripts/extract_boundaries_europe.py` — the deleted Python prototype
(see README's "Historical record" section and this repo's `CLAUDE.md`,
which explicitly forbids resurrecting `scripts/`/`webapp/`). Nothing in
the current TypeScript pipeline regenerates them; despite living in
`data/00-raw/` alongside downloadable inputs, there is no download script
or extraction step that produces them from scratch. If they are ever
lost, the Zuid-Holland and Europe pipelines (`prepare-zuid-holland.ts`,
`prepare-europe.ts`) cannot be rebuilt until a replacement is written.
Full detail in `data/00-raw/orphan/README.md`.

Traced further: `nl_cities.geojson` is OSM `admin_level=10` ("woonplaats")
data, spatially resolved to its containing municipality/province — see
README.md's "Data source" section. This is **exactly** what
`countryAdminLevels.ts` already lists for the Netherlands today
(`NL: { region: [4], city: [10] }`), and exactly what `prepare-world.ts`'s
generic per-country resolution already does for all 239 countries.
Spot-checked: `data/03-final/world.bin` already resolves NL at least as
well as `zuid-holland.bin` does (e.g. Utrecht gets a real city name,
`Achterveld`, in `world.bin`, where `zuid-holland.bin` has no city data
there at all — it's scoped to Zuid-Holland province's 187 cities only).
`eu_cities.geojson` looks like the same idea at European scale (202k
features, same id/municipality/region/country shape).

This means the Zuid-Holland and Europe pipelines' *raw data problem* may
already be solved by the World pipeline — but retiring them (or replacing
their inputs with something derived from World's own extracts) is a
separate, larger decision than this restructuring's scope, since
Zuid-Holland and Europe currently serve as the fast, small-scale
iteration fixtures the worldwide build is too slow/heavy for (`CLAUDE.md`:
"prefer the Zuid-Holland or Europe build when iterating on compressor
logic"). Not acted on here — flagged for a future decision.

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

Root `.gitignore`:

```
data/00-raw/osm/               gitignored (downloadable)
data/00-raw/geonames/           gitignored (downloadable)
data/00-raw/natural-earth/       gitignored (downloadable)
data/00-raw/orphan/             COMMITTED -- not downloadable, see above
data/01-extracted/              gitignored (all of it)
data/02-resolved/eu/cities-filtered.geojson       gitignored (327MB)
data/02-resolved/world/cities-filtered.geojsonseq  gitignored (4.4GB)
(everything else in data/02-resolved/ is committed)
data/03-final/{world_high_res,world_no_chunk}.bin   gitignored, on-demand
data/03-final/world.{search,locate}-index.bin       gitignored, on-demand
(zuid-holland.bin, europe.bin, world.bin, appendix-a-example.bin are committed)

agent-resources/                gitignored (whole dir -- reference material)
data/search-index/  *.pbf  *.pbf.part  .venv/  __pycache__/  *.pyc
node_modules/  dist/  playwright-report/  test-results/  cgeodata-demo.tar.gz
```

## Hardcoded path constants

No script here takes a `--input-dir`/`--output-dir` flag; every stage
boundary is a literal path constant, so a future move means editing all
of these together by hand:

- `data-ingest/scripts/extract-boundaries.sh` — `OSM_DIR`, `WORK_DIR`
- `data-ingest/scripts/download-osm.sh` — `OSM_DIR`, the `REGIONS` map
- `data-ingest/scripts/download-geonames-naturalearth.sh` — `RAW_DIR`
- `data-ingest/src/prepare-zuid-holland.ts` — `CITIES_SOURCE`,
  `PROVINCES_SOURCE`, `COUNTRIES_SOURCE`, `HIERARCHY_OUT`, `CITIES_OUT`,
  `PROVINCES_OUT`, `COUNTRY_OUT`
- `data-ingest/src/prepare-europe.ts` — same shape
- `data-ingest/src/prepare-world.ts` — `WORK_DIR`, `COUNTRIES_SOURCE`,
  `CITIES500_SOURCE`, `ADMIN1_CODES_SOURCE`, `HIERARCHY_OUT`, `CITIES_OUT`,
  `REGIONS_OUT`, `COUNTRIES_OUT`
- `demo/src/server.ts`, `demo/playwright.config.ts` — default/test `.bin` path
- `build-world-on-remote-machine.sh` — `REQUIRED_DATA_FILES`, rsync
  excludes, the remote compressor invocation
