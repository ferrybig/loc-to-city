#!/usr/bin/env bash
# Filters every .osm.pbf in data/00-raw/osm/ (normally just
# planet-latest.osm.pbf) down to boundary=administrative relations and
# exports them to GeoJSON Text Sequence, via the loc2city-tools Docker image
# (osmium-tool). boundary=census relations go to a file of their own,
# <base>-census.geojson, with relation areas only (`area_tags: false`): the
# closed ways osmium pulls in as their members would otherwise become
# candidates (a US "Town Limits" way at admin_level=8). Pass 1 reads census
# relations only for a country with `regionBoundary: "census"` (Slovenia's
# statistical regions). Skips an output already newer than its input, so
# re-running after swapping in an updated planet file only redoes that
# file -- see README's "Reproducing" section.
#
# Usage:
#   scripts/extract-boundaries.sh                  # every *.osm.pbf
#   scripts/extract-boundaries.sh planet-latest     # a subset, by basename
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

OSM_DIR="data/00-raw/osm"
WORK_DIR="data/01-extracted/world"

mkdir -p "$WORK_DIR"

shopt -s nullglob
if [ "$#" -gt 0 ]; then
  targets=()
  for name in "$@"; do
    targets+=("$OSM_DIR/$name.osm.pbf")
  done
else
  targets=("$OSM_DIR"/*.osm.pbf)
fi

for pbf in "${targets[@]}"; do
  if [ ! -f "$pbf" ]; then
    echo "skip: $pbf not found" >&2
    continue
  fi
  base="$(basename "$pbf" .osm.pbf)"

  for kind in admin census; do
    out_pbf="$WORK_DIR/${base}-${kind}.osm.pbf"
    out_geojson="$WORK_DIR/${base}-${kind}.geojson"
    if [ -f "$out_geojson" ] && [ "$out_geojson" -nt "$pbf" ]; then
      echo "skip $base $kind (up to date)"
      continue
    fi
    if [ "$kind" = admin ]; then
      filter=r/boundary=administrative
      config=
    else
      filter=r/boundary=census
      config="-c data-ingest/scripts/census-export.json"
    fi

    echo "extracting $base $kind..."
    docker run --rm -v "$PWD:/work" -w /work loc2city-tools bash -c "
      osmium tags-filter '$pbf' $filter \
        -o '$out_pbf' --overwrite -f pbf &&
      osmium export '$out_pbf' $config -o '$out_geojson' \
        --overwrite -f geojsonseq --geometry-types=polygon,multipolygon \
        --add-unique-id type_id
    "
  done
done
