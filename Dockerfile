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
COPY reader/tsconfig.json reader/
COPY demo/src demo/src
COPY demo/tsconfig.json demo/

RUN npm run build -w reader && npm run build -w demo

RUN npm prune --omit=dev

# ---- runtime ----
FROM node:26-alpine
WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/reader/package.json reader/
COPY --from=builder /app/reader/dist reader/dist
COPY --from=builder /app/demo/package.json demo/
COPY --from=builder /app/demo/dist demo/dist
COPY demo/public demo/public
COPY data/world.bin data/world.bin

EXPOSE 8766
ENV HOST=::
CMD ["node", "demo/dist/server.js", "8766", "data/world.bin"]
