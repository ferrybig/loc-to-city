/**
 * Renders a single Leaflet XYZ tile as a PNG, ported from the deleted
 * Python prototype's tile renderer (see README's historical record):
 * query the reader for a sub-sampled grid of pixel centers in the tile,
 * color each cell by a hash of the resolved place, render small, then
 * upscale with nearest-neighbor (so the grid's actual cell structure stays
 * visible instead of being smoothed away).
 */

import type { CGeoDataReader, PlaceIdResult } from "@loc-to-city/reader";
import { PNG } from "pngjs";
import { placeColor } from "./colors.ts";

const TILE_SIZE = 256;

/** The part of the reader a tile render uses. */
export type TileReader = Pick<CGeoDataReader, "queryPlaceId" | "placeIds">;

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

/** Zoom level from which a tile draws borders between places: further
 * out, they'd cover most of the tile. */
export const BORDER_MIN_ZOOM = 8;

/**
 * How dark a border is, by the finest level that changes across it: 1
 * between two cities of one region, 2 between regions, 3 between
 * countries (or between a place and nowhere). Index 0 is no border.
 */
const BORDER_ALPHA = [0, 0.3, 0.5, 0.75] as const;

/** What one sample resolved to: its color, plus the global place ids of
 * its country, region and city (-1 for none), for telling where borders
 * go. */
interface Sample {
	color: Rgba;
	country: number;
	region: number;
	city: number;
}

/**
 * The tile at `z`/`x`/`y` sampled once every `resolution` pixels, plus
 * `margin` more samples beyond each edge, row by row from the top: the
 * margin is where a tile's borders come from the neighboring tile's
 * places. Samples outside the reader's coordinate range (past the poles at
 * low zoom) are null.
 */
export function sampleTile(
	reader: TileReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
	margin = 0,
): { size: number; samples: (Sample | null)[] } {
	const clampedResolution = Math.max(1, Math.min(resolution, TILE_SIZE));
	const gridSize = Math.max(1, Math.floor(TILE_SIZE / clampedResolution));
	const size = gridSize + 2 * margin;
	const samples: (Sample | null)[] = new Array(size * size).fill(null);

	// Built once per place rather than once per query: zoomed out, cells
	// get smaller than a pixel and nearly every sample is a query of its
	// own, while a tile only ever shows a few thousand places.
	const unknown: Sample = {
		color: TRANSPARENT,
		country: -1,
		region: -1,
		city: -1,
	};
	const byPlace = new Map<number, Sample>();
	const sampleOf = ({ placeId }: PlaceIdResult): Sample => {
		if (placeId === null) return unknown;
		let sample = byPlace.get(placeId);
		if (sample === undefined) {
			const ids = reader.placeIds(placeId);
			sample = {
				color: [...placeColor(ids.level, placeId), 255],
				country: ids.country,
				region: ids.region ?? -1,
				city: ids.city ?? -1,
			};
			byPlace.set(placeId, sample);
		}
		return sample;
	};

	// A sample's latitude depends only on its row and its longitude only on
	// its column. Rows run north to south (py=0 is the top edge), so `lats`
	// is decreasing; `lons` is increasing except where a margin sample
	// wraps past the antimeridian onto the place it shows on the map.
	const lats = new Float64Array(size);
	const lons = new Float64Array(size);
	for (let s = 0; s < size; s++) {
		const c = (s - margin) * clampedResolution + clampedResolution / 2;
		lats[s] = tilePixelToLonLat(z, x, y, 0, c).lat;
		const lon = tilePixelToLonLat(z, x, y, c, 0).lon;
		lons[s] = lon < -180 ? lon + 360 : lon >= 180 ? lon - 360 : lon;
	}

	// Every point of a result's boundingBox resolves the same way, so one
	// query answers every sample inside it: the run of columns from the
	// queried one rightward whose longitude it covers, in this row and each
	// row below whose latitude it still covers. Samples above and to the
	// left were already visited, so a sample left unfilled when its turn
	// comes lies in no earlier result's box -- and, since boxes don't
	// overlap, the box queried there can't reach any column left of it.
	const filled = new Uint8Array(size * size);
	for (let sy = 0; sy < size; sy++) {
		const lat = lats[sy]!;
		// Tiles can extend past the poles at low zoom; the reader rejects
		// out-of-range coordinates, so skip those samples.
		if (lat < -90 || lat >= 90) continue;
		for (let sx = 0; sx < size; sx++) {
			const lon = lons[sx]!;
			if (filled[size * sy + sx] || lon < -180 || lon >= 180) continue;

			const result = reader.queryPlaceId(lat, lon);
			const sample = sampleOf(result);
			const { minLat, maxLat, minLon, maxLon } = result.boundingBox;
			let last = sx;
			while (
				last + 1 < size &&
				lons[last + 1]! >= minLon &&
				lons[last + 1]! < maxLon
			)
				last++;

			samples[size * sy + sx] = sample;
			filled[size * sy + sx] = 1;
			for (
				let row = sy;
				row < size &&
				(row === sy || (lats[row]! >= minLat && lats[row]! < maxLat));
				row++
			) {
				for (let col = sx; col <= last; col++) {
					samples[size * row + col] = sample;
					filled[size * row + col] = 1;
				}
			}
		}
	}
	return { size, samples };
}

/** How strong a border between samples `a` and `b` is, as an index into
 * BORDER_ALPHA. */
export function borderStrength(a: Sample | null, b: Sample | null): number {
	// Off the map (past a pole): nothing to draw a border against.
	if (a === null || b === null) return 0;
	if (a.country !== b.country) return 3;
	if (a.region !== b.region) return 2;
	if (a.city !== b.city) return 1;
	return 0;
}

/**
 * The tile at `z`/`x`/`y` sampled once every `resolution` pixels, one
 * output pixel per sample, transparent where nothing resolved. With
 * `borders`, a pixel whose place differs from the one left of it or above
 * it is darkened, drawing a one-sample-wide line along the boundary
 * (always on its right/lower side, so lines don't double up).
 */
export function renderTileGrid(
	reader: TileReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
	borders = false,
): PNG {
	const margin = borders ? 1 : 0;
	const { size, samples } = sampleTile(reader, z, x, y, resolution, margin);
	const gridSize = size - 2 * margin;
	const small = new PNG({ width: gridSize, height: gridSize });
	for (let gy = 0; gy < gridSize; gy++) {
		for (let gx = 0; gx < gridSize; gx++) {
			const at = size * (gy + margin) + gx + margin;
			const sample = samples[at]!;
			const [r, g, b, a] = sample?.color ?? TRANSPARENT;
			const strength = borders
				? Math.max(
						borderStrength(sample, samples[at - 1]!),
						borderStrength(sample, samples[at - size]!),
					)
				: 0;
			const dark = BORDER_ALPHA[strength as 0 | 1 | 2 | 3];
			// Black at `dark` alpha composited over the place's color.
			const out = (gridSize * gy + gx) << 2;
			small.data[out] = Math.round(r * (1 - dark));
			small.data[out + 1] = Math.round(g * (1 - dark));
			small.data[out + 2] = Math.round(b * (1 - dark));
			small.data[out + 3] = Math.round(a + (255 - a) * dark);
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
	const small = renderTileGrid(
		reader,
		z,
		x,
		y,
		resolution,
		z >= BORDER_MIN_ZOOM,
	);
	const tile =
		small.width === TILE_SIZE && small.height === TILE_SIZE
			? small
			: nearestNeighborUpscale(small, TILE_SIZE, TILE_SIZE);
	// Paeth alone compresses these flat-colored tiles as well as pngjs's
	// default of trying every filter on every row, in half the time.
	return PNG.sync.write(tile, { filterType: 4 });
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
