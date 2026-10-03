#!/usr/bin/env bash
# Build the demo image, ship it to geodata.ferrybig.nl, and restart it there.
# pipefail matters on the `docker save | gzip` line: without it the pipeline
# reports gzip's status, so a failed/partial `docker save` would leave a
# truncated tarball behind and the script would happily rsync and load it.
set -euo pipefail
docker build -t cgeodata-demo .
docker save cgeodata-demo | gzip > cgeodata-demo.tar.gz
rsync --progress cgeodata-demo.tar.gz fernando@geodata.ferrybig.nl:docker/geocode/
ssh fernando@geodata.ferrybig.nl "docker load < docker/geocode/cgeodata-demo.tar.gz && cd docker/geocode && docker compose up -d"
