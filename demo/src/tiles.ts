/**
 * Renders a single Leaflet XYZ tile as a PNG, ported from the Python
 * prototype's webapp/tiles.py: query the reader for a sub-sampled grid of
 * pixel centers in the tile, color each cell by a hash of the resolved
 * place, render small, then upscale with nearest-neighbor (so the grid's
 * actual cell structure stays visible instead of being smoothed away).
 */

import type { CGeoDataReader, QueryResult } from "@loc-to-city/reader";
import { PNG } from "pngjs";
import { colorKeyToRgb } from "./colors.ts";

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
	const latRad = Math.atan(
		Math.sinh(Math.PI * (1 - (2 * (y + py / tileSize)) / n)),
	);
	const lat = (latRad * 180) / Math.PI;
	return { lat, lon };
}

function colorKeyForResult(result: QueryResult): string | null {
  if (!result.country) return null;
  return (result.city ? '2' : result.region ? '1' : '0' ) + (result.city ?? result.region ?? result.country)
}

export function renderTilePng(
	reader: CGeoDataReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
): Buffer {
	const clampedResolution = Math.max(1, Math.min(resolution, TILE_SIZE));
	const gridSize = Math.max(1, Math.floor(TILE_SIZE / clampedResolution));

	// Many of this tile's sample points land in the same underlying grid
	// cell, especially once zoomed in -- reuse the reader's own boundingBox
	// for that cell instead of re-querying for each repeat hit. Scoped to
	// one render call: simple, and a stale entry across tiles/chunks isn't a
	// concern this way.
	const xyCache: [
		latMin: number,
		lonMin: number,
		lonMax: number,
		r: number,
		g: number,
		b: number,
		a: number,
	][] = [];

	const small = new PNG({ width: gridSize, height: gridSize });

	// Adjacent pixels along a row usually fall in the same cached region, so
	// checking the previous hit's slot first turns most lookups into an O(1)
	// check instead of a scan of the whole cache.
	let lastHit = -1;

	for (let gy = 0; gy < gridSize; gy++) {
		const cy = gy * clampedResolution + clampedResolution / 2;
		pixelloop: for (let gx = 0; gx < gridSize; gx++) {
			const cx = gx * clampedResolution + clampedResolution / 2;
			const { lat, lon } = tilePixelToLonLat(z, x, y, cx, cy);
			const idx = (gridSize * gy + gx) << 2;

			// Tiles can extend past the poles/antimeridian at low zoom; the
			// reader rejects out-of-range coordinates, so skip those pixels.
			if (lat < -90 || lat >= 90 || lon < -180 || lon >= 180) {
				continue;
			}

			if (lastHit !== -1 && lastHit < xyCache.length) {
				const e = xyCache[lastHit]!;
				if (lat >= e[0] && lon >= e[1] && lon < e[2]) {
					small.data[idx] = e[3];
					small.data[idx + 1] = e[4];
					small.data[idx + 2] = e[5];
					small.data[idx + 3] = e[6];
					continue pixelloop;
				}
			}

			let firstFreeIndex = -1;
			for (let i = 0; i < xyCache.length; i++) {
				if (
					lat >= xyCache[i]![0] &&
					lon >=xyCache[i]![1] &&
					lon < xyCache[i]![2]
				) {
					// cache hit
					small.data[idx] = xyCache[i]![3];
					small.data[idx + 1] = xyCache[i]![4];
					small.data[idx + 2] = xyCache[i]![5];
					small.data[idx + 3] = xyCache[i]![6];
					lastHit = i;
					continue pixelloop;
				}
				if (lat < xyCache[i]![0] && firstFreeIndex === -1)
					// Tile rows run north to south (py=0 is the top edge), so
					// latitude only decreases: once it drops below an entry's
					// minLat, that entry can never hit again and its slot is free.
					firstFreeIndex = i;
			}

			const result = reader.query(lat, lon);

			const colorKey = colorKeyForResult(result);

			const [r, g, b, a = 255] = colorKey === null ? [0,0,0,0] :  colorKeyToRgb(colorKey);
			if (firstFreeIndex === -1) {
				xyCache.push([result.boundingBox.minLat, result.boundingBox.minLon, result.boundingBox.maxLon, r, g, b, a])
				lastHit = xyCache.length - 1;
			} else {
				xyCache[firstFreeIndex]![0] = result.boundingBox.minLat
				xyCache[firstFreeIndex]![1] = result.boundingBox.minLon
				xyCache[firstFreeIndex]![2] = result.boundingBox.maxLon
				xyCache[firstFreeIndex]![3] = r
				xyCache[firstFreeIndex]![4] = g
				xyCache[firstFreeIndex]![5] = b
				xyCache[firstFreeIndex]![6] = a
				lastHit = firstFreeIndex;
			}
			small.data[idx] = r;
			small.data[idx + 1] = g;
			small.data[idx + 2] = b;
			small.data[idx + 3] = a;
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
