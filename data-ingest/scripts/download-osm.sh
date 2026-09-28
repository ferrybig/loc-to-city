#!/usr/bin/env bash
# Downloads every OSM continent extract (plus the Netherlands country
# extract used by the Zuid-Holland pipeline) from Geofabrik, pinned to the
# most recent first-of-month snapshot rather than "-latest" or today's
# exact date. Geofabrik only retains a rolling ~10 days of dated daily
# snapshots -- a fixed historical date like "africa-260918.osm.pbf" stops
# being fetchable once that window passes -- but first-of-month snapshots
# are kept indefinitely (confirmed: 260101 through 260901 are all still
# present as of 260928, for both continents and sub-regions like
# Netherlands). Using *last* month's 1st rather than the current month's
# avoids a race in the first few days of a new month, before this month's
# snapshot has necessarily been cut yet. This makes the pinned date
# durably re-fetchable (re-running this script for the same month yields
# the exact same bytes, verifiable by ETag) while still refreshing to a
# newer snapshot automatically once a new month has passed.
#
# Netherlands is the one exception, kept on "-latest": its filename is
# hardcoded elsewhere (extract-boundaries.sh's EXCLUDE, README's manual
# docker command both reference "netherlands-latest.osm.pbf" literally),
# and it's a small, manually-run, one-off pipeline rather than the
# multi-hour worldwide build, so exact-snapshot reproducibility matters
# far less there.
#
# Usage:
#   scripts/download-osm.sh                 # every region below
#   scripts/download-osm.sh europe russia    # a subset, by region key
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root
source data-ingest/scripts/lib/download.sh

OSM_DIR="data/00-raw/osm"
SNAPSHOT_DATE="$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%y%m01)"

# region key -> Geofabrik path (relative to https://download.geofabrik.de/),
# with {DATE} substituted for the pinned first-of-month snapshot.
declare -A REGIONS=(
  [africa]="africa-{DATE}.osm.pbf"
  [antarctica]="antarctica-{DATE}.osm.pbf"
  [asia]="asia-{DATE}.osm.pbf"
  [australia-oceania]="australia-oceania-{DATE}.osm.pbf"
  [central-america]="central-america-{DATE}.osm.pbf"
  [europe]="europe-{DATE}.osm.pbf"
  [north-america]="north-america-{DATE}.osm.pbf"
  [russia]="russia-{DATE}.osm.pbf"
  [south-america]="south-america-{DATE}.osm.pbf"
  [netherlands]="europe/netherlands-latest.osm.pbf"
)

if [ "$#" -gt 0 ]; then
  keys=("$@")
else
  keys=("${!REGIONS[@]}")
fi

for key in "${keys[@]}"; do
  path="${REGIONS[$key]:-}"
  if [ -z "$path" ]; then
    echo "unknown region: $key (known: ${!REGIONS[*]})" >&2
    exit 1
  fi
  path="${path/\{DATE\}/$SNAPSHOT_DATE}"

  if [ "$key" = "netherlands" ]; then
    dest="$OSM_DIR/netherlands-latest.osm.pbf"
  else
    dest="$OSM_DIR/${key}-${SNAPSHOT_DATE}.osm.pbf"
  fi
  # download_file returns 2 for "304 Not Modified" -- not a failure, just
  # nothing to do for this region; only a real error (1) should stop the loop.
  download_file "https://download.geofabrik.de/$path" "$dest" || [ "$?" = 2 ]
done

echo "done. Existing differently-dated files in $OSM_DIR are left in place --"
echo "remove them manually once you've confirmed the new ones extract cleanly."
