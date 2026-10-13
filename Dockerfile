# syntax=docker/dockerfile:1

# Which data/03-final/<DATASET>.bin to serve, copied in as world.bin:
#   docker build --build-arg DATASET=world .
ARG DATASET=world-high-res

# ---- sidecars ----
# Sidecar indexes next to world.bin, which the demo picks up by name:
# /api/search checks only the cities the search index leaves over, and
# /api/locate reads one entry instead of scanning every chunk. The demo
# also offers all three as downloads, under these names.
#
# A stage of its own, with no `npm ci`: the reader has no runtime
# dependencies and Node runs its TypeScript directly (as the Makefile does),
# so the only inputs are reader/ and the .bin. Adding a package to another
# workspace changes the lockfile and rebuilds the builder stage below, but
# not this one, whose locate index alone takes a minute or more.
FROM node:26-alpine AS sidecars
ARG DATASET
WORKDIR /app
COPY reader/package.json reader/
COPY reader/src reader/src
COPY data/03-final/${DATASET}.bin data/world.bin
# The locate index first: build-search-index ranks its short-query table by
# area when one is next to the .bin, as the reader then ranks searches, and
# the reader only uses a table ranked its own way.
RUN node reader/src/cli.ts build-locate-index data/world.bin --output data/world.locate-index.bin \
 && node reader/src/cli.ts build-search-index data/world.bin --output data/world.search-index.bin

# ---- builder ----
FROM node:26-alpine AS builder
ARG DATASET
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
COPY reader/package.json reader/
COPY compressor/package.json compressor/
COPY data-ingest/package.json data-ingest/
COPY verify/package.json verify/
COPY demo/package.json demo/

RUN npm ci

COPY tsconfig.base.json ./
COPY reader/src reader/src
COPY reader/tsconfig.json reader/typedoc.json reader/README.md reader/binary-format.md reader/
COPY verify/src verify/src
COPY verify/tsconfig.json verify/
COPY demo/src demo/src
COPY demo/tsconfig.json demo/
COPY demo/web demo/web

# reader/docs: the API reference the demo serves under /docs/.
RUN npm run build -w reader && npm run build -w demo && npm run build -w verify && npm run docs -w reader

COPY data/03-final/${DATASET}.bin data/world.bin
COPY --from=sidecars /app/data/world.locate-index.bin /app/data/world.search-index.bin data/

# The spot-checks from countries.md, run against this very dataset, which the
# page draws as map markers (the demo picks the file up next to world.bin, and
# ignores one made for a dataset of another size).
RUN node verify/dist/export.js data/world.bin --out data/world.checks.json

# Brotli-compress the page, its bundle (Leaflet included) and the docs once, here, rather than per
# request, and hash everything served (those and data/) for content ETags:
# every file this build writes gets a new mtime, which the default ETags
# are made of, so each deploy would have clients fetch it all again.
RUN node demo/dist/prepareStatic.js data

RUN npm prune --omit=dev

# ---- runtime ----
FROM node:26-alpine
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/reader/package.json reader/
COPY --from=builder /app/reader/dist reader/dist
COPY --from=builder /app/reader/docs reader/docs
COPY --from=builder /app/demo/package.json demo/
COPY --from=builder /app/demo/dist demo/dist
COPY --from=builder /app/data/world.bin /app/data/world.search-index.bin /app/data/world.locate-index.bin /app/data/world.checks.json /app/data/.etags.json data/

EXPOSE 8766
ENV HOST=::
CMD ["node", "demo/dist/server.js", "8766", "data/world.bin"]
