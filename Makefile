.PHONY: world europe netherlands world-high-res
world: data/03-final/world.bin
world-high-res: data/03-final/world-high-res.bin \
	data/03-final/world-high-res.locate-index.bin \
	data/03-final/world-high-res.search-index.bin \
	data/03-final/world-high-res.checks.json
europe: data/03-final/europe.bin
netherlands: data/03-final/zuid-holland.bin

# A failed or interrupted recipe leaves no half-written output behind for
# the next run to mistake for an up-to-date one.
.DELETE_ON_ERROR:

# Without this, `make <name>.search-index.bin` builds <name>.locate-index.bin
# as an intermediate file of the pattern rule chain and deletes it again
# afterwards, leaving a search index ranked by area and no locate index to go
# with it. Secondary files are kept, and (unlike .PRECIOUS, which would also
# keep a half-written one) still deleted by .DELETE_ON_ERROR when their recipe
# fails. A pattern as prerequisite (`.SECONDARY: %.locate-index.bin`) is
# ignored by make; the bare form is the portable one.
.SECONDARY:

# --- Compressing a resolved dataset into a final .bin ----------------------
#
# Every .bin is one compressor run over data/02-resolved/$(SOURCE)/. A target
# sets what differs from the defaults below as target-specific variables:
#   SOURCE          data/02-resolved/ directory to read (required)
#   GRID_EXP        a 2^GRID_EXP x 2^GRID_EXP grid of chunks
#   MAX_DEPTH       quadtree depth within a chunk. Cells are
#                   360 / 2^(GRID_EXP + MAX_DEPTH) degrees wide, so trading a
#                   depth level for a grid exponent keeps the resolution:
#                   smaller chunks make a cold tile decode less, for a
#                   slightly larger file.
#   KEYFRAME_EXP    2^KEYFRAME_EXP names per name block
#   ATTRIBUTION     quoted, as it goes on the command line
#   COMPRESS_ENV    environment for the run, e.g. a bigger heap
#   COMPRESS_FLAGS  any other compressor options
GRID_EXP = 6
MAX_DEPTH = 8
KEYFRAME_EXP = 13
# Every dataset is built from the same pipeline (Europe and the Netherlands
# are filtered from the worldwide one), so every one credits all its sources.
ATTRIBUTION = "City boundaries from [OpenStreetMap](https://openstreetmap.org/copyright), [Geonames](https://www.geonames.org/), CC BY 4.0 & [Natural Earth](https://www.naturalearthdata.com/) "

WORLD_BINS := data/03-final/world.bin data/03-final/world-high-res.bin
FINAL_BINS := $(WORLD_BINS) data/03-final/europe.bin data/03-final/zuid-holland.bin

$(WORLD_BINS): SOURCE = world
$(WORLD_BINS): KEYFRAME_EXP = 7
$(WORLD_BINS): COMPRESS_ENV = NODE_OPTIONS="--max-old-space-size=24576"
data/03-final/world-high-res.bin: GRID_EXP = 7
data/03-final/world-high-res.bin: MAX_DEPTH = 10

data/03-final/europe.bin: SOURCE = eu
data/03-final/europe.bin: COMPRESS_FLAGS = --workers 6

data/03-final/zuid-holland.bin: SOURCE = nl
data/03-final/zuid-holland.bin: MAX_DEPTH = 10

COMPRESS_INPUTS = \
	data/02-resolved/$(SOURCE)/hierarchy.json \
	data/02-resolved/$(SOURCE)/cities-filtered.geojsonseq
COMPRESS_OPTIONS = \
	--regions data/02-resolved/$(SOURCE)/regions.geojsonseq \
	--countries data/02-resolved/$(SOURCE)/country-polygons.geojson \
	--width-exp $(GRID_EXP) \
	--height-exp $(GRID_EXP) \
	--max-depth $(MAX_DEPTH) \
	--keyframe-exp $(KEYFRAME_EXP) \
	--attribution $(ATTRIBUTION) \
	$(COMPRESS_FLAGS)

# $$(SOURCE) is expanded a second time, per target, so each .bin depends on
# its own source directory's output.
.SECONDEXPANSION:
$(FINAL_BINS): %: %.args data/02-resolved/$$(SOURCE)/cities-filtered.geojsonseq | node_modules
	$(COMPRESS_ENV) node compressor/src/cli.ts $(COMPRESS_INPUTS) $@ $(COMPRESS_OPTIONS)
	@# A sidecar index from the previous build no longer matches, and the
	@# reader refuses to search with a stale one.
	rm -f $(@:.bin=.search-index.bin) $(@:.bin=.locate-index.bin) $(@:.bin=.checks.json)

# <name>.bin.args records the settings <name>.bin was built with, rewritten
# only when they change. Make compares timestamps, not recipes, so without
# it a changed setting would leave the old .bin looking up to date. Built
# as a prerequisite of its .bin, it sees that target's variables.
%.bin.args: FORCE
	@echo '$(COMPRESS_ENV) $(COMPRESS_INPUTS) $(COMPRESS_OPTIONS)' | cmp -s - $@ \
		|| echo '$(COMPRESS_ENV) $(COMPRESS_INPUTS) $(COMPRESS_OPTIONS)' > $@

.PHONY: FORCE
FORCE:

# node_modules is an order-only prerequisite (after the `|`) everywhere: make
# still runs `npm install` first when package.json or the lockfile changed, but
# a newer node_modules no longer makes a target out of date. As a normal
# prerequisite it did: any `npm install` made every stage look stale, and the
# next `make` restarted the worldwide resolve. What a stage really depends on
# is the code it runs, which is listed per rule below only where a rebuild is
# cheap (the sidecars). The resolve and the .bin deliberately do not depend on
# data-ingest/ or compressor/ sources: after changing those, remove the output
# you want rebuilt, so that an edit never starts a long build by itself.
READER_SRC := $(shell find reader/src -name '*.ts')

# Sidecar indexes the reader (and so the demo) picks up next to a .bin, e.g.
# `make data/03-final/world-high-res.search-index.bin`. The search index
# comes after the locate index: build-search-index ranks its short-query
# table by area when a locate index is next to the .bin, as the reader then
# ranks searches, and the reader only uses a table ranked its own way.
%.search-index.bin: %.bin %.locate-index.bin $(READER_SRC) | node_modules
	node reader/src/cli.ts build-search-index $< --output $@

%.locate-index.bin: %.bin $(READER_SRC) | node_modules
	node reader/src/cli.ts build-locate-index $< --output $@

# The spot-checks of verify/ run against a .bin, written for the demo's map
# markers (it picks the file up next to the .bin it serves). A failing check
# is a result, not an error: the export still succeeds (`npm test -w verify`
# is the gate).
%.checks.json: %.bin $(READER_SRC) $(wildcard verify/src/*.ts) | node_modules
	node verify/src/export.ts $< --out $@

data/02-resolved/eu/cities-filtered.geojsonseq: data/02-resolved/world/cities-filtered.geojsonseq | node_modules
	node data-ingest/src/filter-by-scope.ts --only-continent Europe --out-dir data/02-resolved/eu

data/02-resolved/nl/cities-filtered.geojsonseq: data/02-resolved/world/cities-filtered.geojsonseq | node_modules
	node data-ingest/src/filter-by-scope.ts --only-country NL --out-dir data/02-resolved/nl

data/02-resolved/world/cities-filtered.geojsonseq: data/01-extracted/world/planet-latest-admin.geojson data/01-extracted/world/planet-latest-census.geojson data/00-raw/geonames/cities500.txt data/00-raw/geonames/admin1CodesASCII.txt data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson | node_modules
	NODE_OPTIONS="--max-old-space-size=9216" \
	node data-ingest/src/prepare-world.ts

data/01-extracted/world/planet-latest-admin.geojson data/01-extracted/world/planet-latest-census.geojson &: data/00-raw/osm/planet-latest.osm.pbf .docker-image-stamp
	data-ingest/scripts/extract-boundaries.sh

.PHONY: extract
extract: data/01-extracted/world/planet-latest-admin.geojson data/01-extracted/world/planet-latest-census.geojson

.docker-image-stamp: Dockerfile.tools
	docker build -t loc2city-tools -f Dockerfile.tools .
	@touch .docker-image-stamp

.PHONY: docker-image
docker-image: .docker-image-stamp

.PHONY: download
download: data/00-raw/osm/planet-latest.osm.pbf data/00-raw/geonames/cities500.txt data/00-raw/geonames/admin1CodesASCII.txt data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson

data/00-raw/geonames/cities500.txt data/00-raw/geonames/admin1CodesASCII.txt data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson &:
	data-ingest/scripts/download-geonames-naturalearth.sh

data/00-raw/osm/planet-latest.osm.pbf:
	data-ingest/scripts/download-osm.sh

.PHONY: npmi
npmi:
	npm install
	@touch node_modules

node_modules: package.json package-lock.json
	npm install
	@touch node_modules
