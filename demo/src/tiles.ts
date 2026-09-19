/**
 * Renders a single Leaflet XYZ tile as a PNG, ported from the Python
 * prototype's webapp/tiles.py: query the reader for a sub-sampled grid of
 * pixel centers in the tile, color each cell by a hash of the resolved
 * place, render small, then upscale with nearest-neighbor (so the grid's
 * actual cell structure stays visible instead of being smoothed away).
 */
import { PNG } from "pngjs";
import type { CGeoDataReader, QueryResult } from "@loc-to-city/reader";
import { colorKeyToRgb, type ColorSpace } from "./colors.js";
import { BoundingBoxCache } from "./boundingBoxCache.js";

const TILE_SIZE = 256;

export function tilePixelToLonLat(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
  tileSize = TILE_SIZE,
): { lat: number; lon: number } {
  const n = 2 ** z;
  const lon = ((x + px / tileSize) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / tileSize)) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lon };
}

function colorKeyForResult(result: QueryResult): string | null {
  const mostSpecific = result.city ?? result.region ?? result.country;
  if (!mostSpecific) return null;
  const name = mostSpecific[0] ?? "";
  const region = result.region?.[0] ?? "";
  return `${name}|${region}`;
}

export function renderTilePng(
  reader: CGeoDataReader,
  z: number,
  x: number,
  y: number,
  resolution: number,
  colorSpace: ColorSpace,
): Buffer {
  const clampedResolution = Math.max(1, Math.min(resolution, TILE_SIZE));
  const gridSize = Math.max(1, Math.floor(TILE_SIZE / clampedResolution));

  // Many of this tile's sample points land in the same underlying grid
  // cell, especially once zoomed in -- reuse the reader's own boundingBox
  // for that cell instead of re-querying for each repeat hit. Scoped to
  // one render call: simple, and a stale entry across tiles/chunks isn't a
  // concern this way.
  const cache = new BoundingBoxCache();

  const small = new PNG({ width: gridSize, height: gridSize });
  for (let gy = 0; gy < gridSize; gy++) {
    const cy = gy * clampedResolution + clampedResolution / 2;
    for (let gx = 0; gx < gridSize; gx++) {
      const cx = gx * clampedResolution + clampedResolution / 2;
      const { lat, lon } = tilePixelToLonLat(z, x, y, cx, cy);
      const idx = (gridSize * gy + gx) << 2;

      // Tiles can extend past the poles/antimeridian at low zoom; the
      // reader rejects out-of-range coordinates, so skip those pixels.
      if (lat < -90 || lat >= 90 || lon < -180 || lon >= 180) {
        continue;
      }

      let result = cache.lookup(lat, lon);
      if (!result) {
        result = reader.query(lat, lon);
        cache.insert(result);
      }

      const colorKey = colorKeyForResult(result);
      if (colorKey === null) continue;

      const [r, g, b] = colorKeyToRgb(colorKey, colorSpace);
      small.data[idx] = r;
      small.data[idx + 1] = g;
      small.data[idx + 2] = b;
      small.data[idx + 3] = 255;
    }
  }

  const upscaled = nearestNeighborUpscale(small, TILE_SIZE, TILE_SIZE);
  return PNG.sync.write(upscaled);
}

function nearestNeighborUpscale(src: PNG, width: number, height: number): PNG {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * src.height) / height);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * src.width) / width);
      const srcIdx = (src.width * sy + sx) << 2;
      const dstIdx = (width * y + x) << 2;
      dst.data[dstIdx] = src.data[srcIdx]!;
      dst.data[dstIdx + 1] = src.data[srcIdx + 1]!;
      dst.data[dstIdx + 2] = src.data[srcIdx + 2]!;
      dst.data[dstIdx + 3] = src.data[srcIdx + 3]!;
    }
  }
  return dst;
}
