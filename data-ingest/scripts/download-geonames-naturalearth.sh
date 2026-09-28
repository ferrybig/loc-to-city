#!/usr/bin/env bash
# Downloads the two small, non-OSM raw inputs every pipeline reads:
# GeoNames' populated-places export (cities500, used by prepare-world.ts's
# Voronoi fallback -- see README's "Libya, Egypt, Chad and Eritrea" /
# "Slovenia" entries) and its admin1 code->name table (display names
# only, no coordinates), plus Natural Earth's country outlines (the
# country-polygon source for all three pipelines). Idempotent and safe to
# re-run: each file is only re-downloaded if the server says it changed
# (see lib/download.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
source data-ingest/scripts/lib/download.sh

RAW_DIR="data/00-raw"

# download_file returns 2 for "304 Not Modified, nothing changed" -- fine
# for these two, whose sole side effect is the file existing.
download_file \
  "https://download.geonames.org/export/dump/admin1CodesASCII.txt" \
  "$RAW_DIR/geonames/admin1CodesASCII.txt" || [ "$?" = 2 ]

download_file \
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson" \
  "$RAW_DIR/natural-earth/ne_10m_admin_0_countries.geojson" || [ "$?" = 2 ]

# cities500.zip must be re-unzipped whenever it's freshly downloaded --
# gated on download_file's exit status (0 = wrote a new file), not on
# mtime, since dest's mtime is unreliable here (any other file touch could
# make ZIP look newer than TXT without cities500.zip's actual contents
# having changed).
ZIP="$RAW_DIR/geonames/cities500.zip"
TXT="$RAW_DIR/geonames/cities500.txt"
zip_status=0
download_file "https://download.geonames.org/export/dump/cities500.zip" "$ZIP" || zip_status=$?
if [ "$zip_status" != "0" ] && [ "$zip_status" != "2" ]; then
  exit 1
fi
if [ "$zip_status" = "0" ] || [ ! -f "$TXT" ]; then
  echo "unzipping $ZIP..."
  unzip -o "$ZIP" -d "$RAW_DIR/geonames/" cities500.txt
fi

echo "done."
