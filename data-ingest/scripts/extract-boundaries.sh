#!/usr/bin/env bash
# Filters every .osm.pbf in data-ingest/osm/ down to boundary=administrative
# relations and exports them to GeoJSON Text Sequence, via the
# loc2city-tools Docker image (osmium-tool). Skips a file whose output is
# already newer than its input, so re-running after swapping in a new/
# updated continent extract only redoes that one file -- see README's
# "Reproducing" section.
#
# Usage:
#   scripts/extract-boundaries.sh                  # every *.osm.pbf except netherlands
#   scripts/extract-boundaries.sh europe-latest russia-260918   # a subset, by basename
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

OSM_DIR="data-ingest/osm"
WORK_DIR="data-ingest/work-world"
EXCLUDE="netherlands-latest.osm.pbf"

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
  if [ "$(basename "$pbf")" = "$EXCLUDE" ]; then
    echo "skip $base (excluded: not part of the worldwide build)"
    continue
  fi

  admin_pbf="$WORK_DIR/${base}-admin.osm.pbf"
  admin_geojson="$WORK_DIR/${base}-admin.geojson"
  if [ -f "$admin_geojson" ] && [ "$admin_geojson" -nt "$pbf" ]; then
    echo "skip $base (up to date)"
    continue
  fi

  echo "extracting $base..."
  docker run --rm -v "$PWD:/work" -w /work loc2city-tools bash -c "
    osmium tags-filter '$pbf' r/boundary=administrative \
      -o '$admin_pbf' --overwrite -f pbf &&
    osmium export '$admin_pbf' -o '$admin_geojson' \
      --overwrite -f geojsonseq --geometry-types=polygon,multipolygon \
      --add-unique-id type_id
  "
done
