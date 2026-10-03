.PHONY: world europe netherlands
world: data/03-final/world.bin
europe: data/03-final/europe.bin
netherlands: data/03-final/zuid-holland.bin

data/03-final/world.bin: node_modules data/02-resolved/world/cities-filtered.geojsonseq
	NODE_OPTIONS="--max-old-space-size=24576" \
	node compressor/src/cli.ts \
		data/02-resolved/world/hierarchy.json \
		data/02-resolved/world/cities-filtered.geojsonseq \
		data/03-final/world.bin \
		--regions data/02-resolved/world/regions.geojson \
		--countries data/02-resolved/world/country-polygons.geojson \
		--width-exp 6 \
		--height-exp 6 \
		--max-depth 8 \
		--keyframe-exp 7 \
		--attribution "City boundaries from [OpenStreetMap](https://openstreetmap.org/copyright), [Geonames](https://www.geonames.org/), CC BY 4.0 & [Natural Earth](https://www.naturalearthdata.com/) "

data/03-final/europe.bin: node_modules data/02-resolved/eu/cities-filtered.geojsonseq
	node compressor/src/cli.ts \
		data/02-resolved/eu/hierarchy.json \
		data/02-resolved/eu/cities-filtered.geojsonseq \
		data/03-final/europe.bin \
		--regions data/02-resolved/eu/regions.geojson \
		--countries data/02-resolved/eu/country-polygons.geojson \
		--width-exp 6 \
		--height-exp 6 \
		--max-depth 8 \
		--keyframe-exp 13 \
		--attribution "[OpenStreetMap](https://openstreetmap.org/copyright)" \
		--workers 6

data/02-resolved/eu/cities-filtered.geojsonseq: node_modules data/02-resolved/world/cities-filtered.geojsonseq
	node data-ingest/src/filter-by-scope.ts --only-continent Europe --out-dir data/02-resolved/eu

data/03-final/zuid-holland.bin: node_modules data/02-resolved/nl/cities-filtered.geojsonseq
	node compressor/src/cli.ts \
		data/02-resolved/nl/hierarchy.json \
		data/02-resolved/nl/cities-filtered.geojsonseq \
		data/03-final/zuid-holland.bin \
		--regions data/02-resolved/nl/regions.geojson \
		--countries data/02-resolved/nl/country-polygons.geojson \
		--width-exp 6 \
		--height-exp 6 \
		--max-depth 10 \
		--keyframe-exp 13 \
		--attribution "[OpenStreetMap](https://openstreetmap.org/copyright)"

data/02-resolved/nl/cities-filtered.geojsonseq: node_modules data/02-resolved/world/cities-filtered.geojsonseq
	node data-ingest/src/filter-by-scope.ts --only-country NL --out-dir data/02-resolved/nl

data/02-resolved/world/cities-filtered.geojsonseq: node_modules data/01-extracted/world/planet-latest-admin.geojson data/00-raw/geonames/cities500.txt data/00-raw/geonames/admin1CodesASCII.txt data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson
	NODE_OPTIONS="--max-old-space-size=9216" \
	node data-ingest/src/prepare-world.ts

data/01-extracted/world/planet-latest-admin.geojson: data/00-raw/osm/planet-latest.osm.pbf .docker-image-stamp
	data-ingest/scripts/extract-boundaries.sh

.PHONY: extract
extract: data/01-extracted/world/planet-latest-admin.geojson

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
