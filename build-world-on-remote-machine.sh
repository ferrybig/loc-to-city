#!/usr/bin/env bash
# Builds data/03-final/world.bin on the Windows machine at REMOTE_HOST,
# which has more RAM/cores than this box but no Docker -- so this script
# only handles the compressor stage (plain Node, no Docker needed; Node
# >=26 strips the compressor's TypeScript source natively at import time,
# no separate build or transpiler dependency required).
# The data-ingest stage (extract-boundaries.sh + prepare-world.ts) still
# has to run HERE first: extraction needs the loc2city-tools Docker
# image, and prepare-world.ts consumes its output directly. Run that
# locally, then run this script to sync + build on the remote box.
#
# Usage:
#   node data-ingest/src/prepare-world.ts   # local, produces data/02-resolved/world/hierarchy.json etc.
#   ./build-world-on-remote-machine.sh                    # full worldwide build, default workers
#   ./build-world-on-remote-machine.sh --only-chunks 1     # scoped test build (verifies the pipeline works)
#   ./build-world-on-remote-machine.sh --only-chunks ''    # place-table-only build (seconds, no chunks)
#
# Any extra arguments are forwarded verbatim to the compressor CLI on the
# remote machine, after the fixed flags below.
#
# Everything below was actually run and fixed against the real remote
# machine on 2026-09-24, not guessed -- see the three Gotchas this script
# works around, each hit and confirmed live:
#
#   1. cwrsync.cmd (the template dropped by the cwRsync installer) is NOT
#      a working passthrough wrapper -- it ignores its arguments and
#      always runs `rsync --version` / `ssh -V`, corrupting rsync's binary
#      protocol stream ("protocol version mismatch -- is your shell
#      clean?"). The real binary is next to it, at ...\Programs\bin\rsync.exe.
#   2. `npm install` on Windows throws a hard, opaque error
#      ("UNKNOWN: unknown error, lstat ... dist/cli.js", errno -4094) when
#      creating a `.bin` shim for a workspace package whose `bin` target
#      (compressor/reader's dist/cli.js) doesn't exist yet -- unlike
#      POSIX, which just creates a dangling link. `--no-bin-links` skips
#      shim creation for every package (including tsc's own), so this
#      script invokes tsc by its real dist path instead of relying on a
#      PATH-injected shim.
#   3. Deeper problem, independent of (2): even with the shim issue
#      solved, requiring `@loc-to-city/reader` from `compressor` throws
#      "the path cannot be traversed because it contains an untrusted
#      junction point" -- npm workspaces are *always* linked via Windows
#      directory junctions (confirmed `--install-links` does not change
#      this for actual workspaces, only for `file:`-style local deps), and
#      this particular machine's junction-traversal trust setting blocks
#      reading through them (plausibly an SSH/non-interactive logon
#      session restriction; untested whether an interactive session would
#      differ). Worked around by building `reader` first, then replacing
#      its junction with a real `robocopy` of the already-built directory
#      -- `compressor` itself never needs prebuilding since Node >=26
#      strips its TypeScript source directly at import time.
set -euo pipefail
cd "$(dirname "$0")"

REMOTE_HOST="fernando@192.168.2.8"
# Two spellings of the same directory: rsync's remote side needs the
# cygwin /cygdrive form (cwRsync is a cygwin build); cmd.exe commands over
# ssh need the native Windows form.
REMOTE_DIR_CYGWIN="/cygdrive/c/Users/fernando/Documents/Dev/Prive/loc-to-city"
REMOTE_DIR_WIN="C:\\Users\\fernando\\Documents\\Dev\\Prive\\loc-to-city"
REMOTE_RSYNC_PATH="C:\\Users\\fernando\\Programs\\bin\\rsync.exe"
# ~32GB total RAM on this machine (`node -e "os.totalmem()"`, since
# Get-CimInstance is access-denied over this ssh session) -- generous on
# purpose, since more headroom than needed is the entire reason to use
# this machine instead of the local one.
REMOTE_MAX_OLD_SPACE_MB=24576

REQUIRED_DATA_FILES=(
  data/02-resolved/world/hierarchy.json
  data/02-resolved/world/cities-filtered.geojsonseq
  data/02-resolved/world/regions.geojson
  data/02-resolved/world/country-polygons.geojson
)
for f in "${REQUIRED_DATA_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing $f -- run 'node data-ingest/src/prepare-world.ts' locally first" >&2
    echo "(that step needs data/01-extracted/world/*-admin.geojson, produced by" >&2
    echo " scripts/extract-boundaries.sh via the loc2city-tools Docker image," >&2
    echo " which is why it can't run on the Docker-less remote machine)" >&2
    exit 1
  fi
done

# until ping 192.168.2.8; do
#   wakeonlan 00-FF-81-A8-ED-B5
#   sleep 1
# done

echo "== syncing repo to $REMOTE_HOST:$REMOTE_DIR_WIN =="
# '/.git', not '.git/': in a git worktree .git is a file, not a
# directory, and a directory-only pattern let --delete replace the remote
# checkout's .git directory with it (2026-09-26). Building needs no git.
rsync -avz --delete \
  --rsync-path="$REMOTE_RSYNC_PATH" \
  --exclude='/.git' \
  --exclude='cgeodata-demo.tar.gz' \
  --exclude='node_modules/' \
  --exclude='*/node_modules/' \
  --exclude='*/dist/' \
  --exclude='data/00-raw/osm/' \
  --exclude='data/01-extracted/' \
  --exclude='agent-resources/' \
  --exclude='data/search-index/' \
  --exclude='*.pbf' \
  --exclude='*.pbf.part' \
  --exclude='*.cpuprofile' \
  --exclude='.venv/' \
  --exclude='__pycache__/' \
  --exclude='playwright-report/' \
  --exclude='test-results/' \
  ./ "$REMOTE_HOST:$REMOTE_DIR_CYGWIN/"

echo "== installing deps on remote (--no-bin-links: see Gotcha 2 above) =="
# Windows OpenSSH's default shell here is cmd.exe (confirmed via `%CD%`),
# not a POSIX shell -- '&&' chaining and native backslash paths.
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR_WIN && npm install --no-bin-links"

echo "== building reader, then replacing its junction with a real copy (see Gotcha 3 above) =="
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR_WIN && node node_modules\\typescript\\bin\\tsc -p reader\\tsconfig.json"
ssh "$REMOTE_HOST" "rd \"$REMOTE_DIR_WIN\\node_modules\\@loc-to-city\\reader\""
ssh "$REMOTE_HOST" "robocopy \"$REMOTE_DIR_WIN\\reader\" \"$REMOTE_DIR_WIN\\node_modules\\@loc-to-city\\reader\" /E /NFL /NDL /NJH /NJS || exit 0"

echo "== running compressor build on remote (default workers = os.availableParallelism()) =="
# compressor itself is never prebuilt -- Node >=26 strips its TS source
# directly at import time, so only reader (imported via its compiled
# dist/ per its package.json `exports`) needs the tsc step above.
# --workers is deliberately omitted: the CLI's own default is
# os.availableParallelism(), which is exactly "the default amount of
# workers" on whichever machine actually runs it.
ssh "$REMOTE_HOST" "cd /d $REMOTE_DIR_WIN && set NODE_OPTIONS=--max-old-space-size=$REMOTE_MAX_OLD_SPACE_MB && node compressor\\src\\cli.ts data\\02-resolved\\world\\hierarchy.json data\\02-resolved\\world\\cities-filtered.geojsonseq data\\03-final\\world.bin --regions data\\02-resolved\\world\\regions.geojson --countries data\\02-resolved\\world\\country-polygons.geojson --width-exp 6 --height-exp 6 --max-depth 8 --keyframe-exp 7 --attribution \"[OpenStreetMap](https://openstreetmap.org/copyright)\" $*"

echo "== syncing data/03-final/world.bin back =="
rsync -avz \
  --rsync-path="$REMOTE_RSYNC_PATH" \
  "$REMOTE_HOST:$REMOTE_DIR_CYGWIN/data/03-final/world.bin" ./data/03-final/world.bin

echo "== done: data/03-final/world.bin updated from remote build =="
ls -la data/03-final/world.bin
