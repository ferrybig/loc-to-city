/**
 * Renders a single Leaflet XYZ tile as a PNG, ported from the deleted
 * Python prototype's tile renderer (see README's historical record):
 * query the reader for a sub-sampled grid of pixel centers in the tile,
 * color each cell by a hash of the resolved place, render small, then
 * upscale with nearest-neighbor (so the grid's actual cell structure stays
 * visible instead of being smoothed away).
 */

import type { CGeoDataReader, QueryResult } from "@loc-to-city/reader";
import { PNG } from "pngjs";
import { placeColor } from "./colors.ts";

const TILE_SIZE = 256;

/** The part of the reader a tile render uses. */
export type TileReader = Pick<CGeoDataReader, "query">;

type Rgba = [r: number, g: number, b: number, a: number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/** Zoom level from which every pixel gets its own query. */
const FULL_RESOLUTION_ZOOM = 7;

/**
 * The resolution (tile pixels per query, per axis) a tile at zoom `z` is
 * rendered at unless the request asks for one: 1 from zoom 7 in, doubling
 * for every level further out (2 at zoom 6, 4 at zoom 5, ...), up to 64.
 * Zoomed out, neighboring pixels rarely share a cell, so the per-render
 * cell cache stops saving queries and a full-resolution tile gets slow.
 */
export function defaultTileResolution(z: number): number {
	return 2 ** Math.min(6, Math.max(0, FULL_RESOLUTION_ZOOM - z));
}

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

/** The color for a query result: its finest resolved level's, or
 * transparent where nothing resolved. */
export function resultColor(result: QueryResult): Rgba {
	const [level, names] = result.city
		? (["city", result.city] as const)
		: result.region
			? (["region", result.region] as const)
			: result.country
				? (["country", result.country] as const)
				: [null, null];
	if (level === null) return TRANSPARENT;
	return [...placeColor(level, names), 255];
}

/**
 * The tile at `z`/`x`/`y` sampled once every `resolution` pixels, one
 * output pixel per sample. Pixels outside the reader's coordinate range
 * (past the poles at low zoom) stay transparent.
 */
export function renderTileGrid(
	reader: TileReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
): PNG {
	const clampedResolution = Math.max(1, Math.min(resolution, TILE_SIZE));
	const gridSize = Math.max(1, Math.floor(TILE_SIZE / clampedResolution));
	const small = new PNG({ width: gridSize, height: gridSize });

	// Many of this tile's sample points land in the same underlying grid
	// cell, especially once zoomed in -- reuse the reader's own boundingBox
	// for that cell instead of re-querying for each repeat hit. Scoped to
	// one render call: simple, and a stale entry across tiles/chunks isn't a
	// concern this way.
	//
	// Rows run north to south (py=0 is the top edge), so a sample's
	// latitude never exceeds that of any earlier sample, and so never
	// exceeds the maxLat of any cell an earlier sample landed in: an entry
	// only has to check minLat. Once a row's latitude drops below an
	// entry's minLat, that entry can never hit again and its slot is free.
	const cache: {
		minLat: number;
		minLon: number;
		maxLon: number;
		color: Rgba;
	}[] = [];
	const hits = (i: number, lat: number, lon: number): boolean => {
		const e = cache[i]!;
		return lat >= e.minLat && lon >= e.minLon && lon < e.maxLon;
	};

	// Adjacent pixels along a row usually fall in the same cached cell, so
	// checking the previous hit's slot first turns most lookups into an O(1)
	// check instead of a scan of the whole cache.
	let lastHit = -1;

	for (let gy = 0; gy < gridSize; gy++) {
		const cy = gy * clampedResolution + clampedResolution / 2;
		for (let gx = 0; gx < gridSize; gx++) {
			const cx = gx * clampedResolution + clampedResolution / 2;
			const { lat, lon } = tilePixelToLonLat(z, x, y, cx, cy);

			// Tiles can extend past the poles/antimeridian at low zoom; the
			// reader rejects out-of-range coordinates, so skip those pixels.
			if (lat < -90 || lat >= 90 || lon < -180 || lon >= 180) {
				continue;
			}

			let color: Rgba | null = null;
			if (lastHit !== -1 && hits(lastHit, lat, lon)) {
				color = cache[lastHit]!.color;
			} else {
				let freeSlot = -1;
				for (let i = 0; i < cache.length; i++) {
					if (hits(i, lat, lon)) {
						color = cache[i]!.color;
						lastHit = i;
						break;
					}
					if (freeSlot === -1 && lat < cache[i]!.minLat) freeSlot = i;
				}
				if (color === null) {
					const result = reader.query(lat, lon);
					color = resultColor(result);
					const entry = {
						minLat: result.boundingBox.minLat,
						minLon: result.boundingBox.minLon,
						maxLon: result.boundingBox.maxLon,
						color,
					};
					if (freeSlot === -1) {
						lastHit = cache.push(entry) - 1;
					} else {
						cache[freeSlot] = entry;
						lastHit = freeSlot;
					}
				}
			}

			small.data.set(color, (gridSize * gy + gx) << 2);
		}
	}
	return small;
}

export function renderTilePng(
	reader: TileReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
): Buffer {
	const small = renderTileGrid(reader, z, x, y, resolution);
	return PNG.sync.write(nearestNeighborUpscale(small, TILE_SIZE, TILE_SIZE));
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
