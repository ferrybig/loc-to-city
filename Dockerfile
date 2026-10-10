# syntax=docker/dockerfile:1
FROM node:26-alpine AS builder
WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./
COPY reader/package.json reader/
COPY compressor/package.json compressor/
COPY data-ingest/package.json data-ingest/
COPY demo/package.json demo/

RUN npm ci

COPY tsconfig.base.json ./
COPY reader/src reader/src
COPY reader/tsconfig.json reader/typedoc.json reader/README.md reader/binary-format.md reader/
COPY demo/src demo/src
COPY demo/tsconfig.json demo/
COPY demo/public demo/public

# reader/docs: the API reference the demo serves under /docs/.
RUN npm run build -w reader && npm run build -w demo && npm run docs -w reader

# Which data/03-final/<DATASET>.bin to serve, copied in as world.bin:
#   docker build --build-arg DATASET=world .
ARG DATASET=world-high-res

# Sidecar indexes next to world.bin, which the demo picks up by name:
# /api/search checks only the cities the search index leaves over, and
# /api/locate reads one entry instead of scanning every chunk. The demo
# also offers all three as downloads, under these names.
COPY data/03-final/${DATASET}.bin data/world.bin
RUN node reader/dist/cli.js build-search-index data/world.bin --output data/world.search-index.bin \
 && node reader/dist/cli.js build-locate-index data/world.bin --output data/world.locate-index.bin

# Brotli-compress the page, Leaflet and the docs once, here, rather than per
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
COPY --from=builder /app/demo/public demo/public
COPY --from=builder /app/data/world.bin /app/data/world.search-index.bin /app/data/world.locate-index.bin /app/data/.etags.json data/

EXPOSE 8766
ENV HOST=::
CMD ["node", "demo/dist/server.js", "8766", "data/world.bin"]
