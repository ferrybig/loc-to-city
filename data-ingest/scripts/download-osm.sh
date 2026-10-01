#!/usr/bin/env bash
# Downloads the whole planet as a single .osm.pbf, per
# https://wiki.openstreetmap.org/wiki/Planet.osm#Downloading -- replaces the
# old per-continent Geofabrik extracts (~85GB combined) plus the separate
# Netherlands-only extract with one canonical file (~80GB) that needs no
# per-region bookkeeping. Idempotent and safe to re-run: only re-downloaded
# if the server says it changed (see lib/download.sh). (A Netherlands-
# specific solution is being revisited separately now that the full planet
# file is the single source of truth.)
#
# Usage:
#   scripts/download-osm.sh
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
source data-ingest/scripts/lib/download.sh

OSM_DIR="data/00-raw/osm"

download_file \
  "https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf" \
  "$OSM_DIR/planet-latest.osm.pbf" || [ "$?" = 2 ]

echo "done."
