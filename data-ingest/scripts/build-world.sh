#!/usr/bin/env bash
# The "swap files, run scripts, get new bin files" entry point: extracts
# boundary relations from every data-ingest/osm/*.osm.pbf (skipping any
# already up to date), merges+resolves them into the compressor's input
# shapes, then builds data/world.bin. Positional args pass through to
# extract-boundaries.sh's subset filter, so e.g.
#   scripts/build-world.sh australia-oceania-260918
# does a scoped end-to-end run against just one continent (see README's
# staged-verification notes) -- a bare `build-world.sh` after adding or
# replacing a file in data-ingest/osm/ is the full worldwide rebuild.
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo root

data-ingest/scripts/extract-boundaries.sh "$@"
# --max-old-space-size raises V8's heap above its ~4GB default so RSS can
# actually reach adminLevelDetection.ts's 8GB guardrail and fail fast with
# an actionable message, instead of V8 OOM-killing the process first (as
# happened before this flag was added -- the guardrail's ceiling was above
# what the heap could ever grow to). Scoped to this one command via
# NODE_OPTIONS prefix so it doesn't leak into the compressor CLI step below.
NODE_OPTIONS="--max-old-space-size=9216" npx tsx data-ingest/src/prepare-world.ts
npx tsx compressor/src/cli.ts data/world-hierarchy.json data/world-cities-filtered.geojsonseq \
  data/world.bin --regions data/world-regions.geojson --countries data/world-country-polygons.geojson \
  --width-exp 6 --height-exp 6 --max-depth 8 --keyframe-exp 7 \
  --attribution "[OpenStreetMap](https://openstreetmap.org/copyright)" --workers "$(nproc)"
