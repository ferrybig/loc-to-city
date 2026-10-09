import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CGeoDataReader,
	type PlaceIdResult,
	type PlaceIds,
	type QueryResult,
} from "@loc-to-city/reader";
import { placeColor } from "../src/colors.ts";
import {
	defaultTileResolution,
	renderTileGrid,
	type TileReader,
	tilePixelToLonLat,
} from "../src/tiles.ts";

/** The color a render should give a query result: its finest resolved
 * level's, or transparent where nothing resolved. Derives the level from
 * the names rather than `placeIds()`, so it checks the render's use of
 * that independently. */
function resultColor(result: QueryResult): [number, number, number, number] {
	if (result.placeId === null) return [0, 0, 0, 0];
	const level = result.city ? "city" : result.region ? "region" : "country";
	return [...placeColor(level, result.placeId), 255];
}

/** A reader that also answers plain `query()`, which the uncached
 * reference renders below use. */
type QueryingReader = TileReader & Pick<CGeoDataReader, "query">;

/** What renderTileGrid should produce: every sample queried on its own,
 * no cache. */
function uncachedGrid(
	reader: QueryingReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
): Buffer {
	const gridSize = Math.floor(256 / resolution);
	const data = Buffer.alloc(gridSize * gridSize * 4);
	for (let gy = 0; gy < gridSize; gy++) {
		for (let gx = 0; gx < gridSize; gx++) {
			const { lat, lon } = tilePixelToLonLat(
				z,
				x,
				y,
				gx * resolution + resolution / 2,
				gy * resolution + resolution / 2,
			);
			if (lat < -90 || lat >= 90 || lon < -180 || lon >= 180) continue;
			data.set(resultColor(reader.query(lat, lon)), (gridSize * gy + gx) << 2);
		}
	}
	return data;
}

/** A small deterministic hash, for the synthetic reader's structure. */
function hash(a: number, b: number, c: number): number {
	let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
	h = Math.imul(h ^ b ^ (h >>> 13), 0xc2b2ae35);
	h = Math.imul(h ^ c ^ (h >>> 16), 0x27d4eb2f);
	return (h ^ (h >>> 15)) >>> 0;
}

/**
 * A reader over a synthetic, irregular quadtree on lat/lon: each cell
 * below depth 3 splits or not by a hash of its position (9 in 10 do),
 * down to depth 24 (about a meter), and each
 * leaf resolves to one of a handful of places (or nothing), so
 * neighboring cells of very different sizes often share a place. Like the
 * real reader, `boundingBox` is the leaf cell, [minLat, maxLat) x
 * [minLon, maxLon). Counts its queries.
 */
function syntheticReader(): QueryingReader & { queries: number } {
	const levels = [
		{ country: ["A"], region: null, city: null },
		{ country: ["A"], region: ["A1"], city: null },
		{ country: ["A"], region: ["A1"], city: ["Alpha"] },
		{ country: ["A"], region: ["A1"], city: ["Beta", "Bèta"] },
		{ country: ["B"], region: ["B1"], city: ["Alpha"] },
		{ country: null, region: null, city: null },
	];
	const reader = {
		queries: 0,
		queryPlaceId(lat: number, lon: number): PlaceIdResult {
			reader.queries++;
			let [minLat, maxLat, minLon, maxLon] = [-90, 90, -180, 180];
			let row = 0;
			let col = 0;
			let depth = 0;
			while (depth < 3 || (depth < 24 && hash(depth, row, col) % 10 !== 0)) {
				const midLat = (minLat + maxLat) / 2;
				const midLon = (minLon + maxLon) / 2;
				row = row * 2 + (lat >= midLat ? 1 : 0);
				col = col * 2 + (lon >= midLon ? 1 : 0);
				if (lat >= midLat) minLat = midLat;
				else maxLat = midLat;
				if (lon >= midLon) minLon = midLon;
				else maxLon = midLon;
				depth++;
			}
			const placeId = hash(depth + 100, row, col) % levels.length;
			return {
				placeId: levels[placeId]!.country ? placeId : null,
				boundingBox: { minLat, maxLat, minLon, maxLon },
				chunkIndex: 0,
			};
		},
		placeIds(id: number): PlaceIds {
			const { country, region, city } = levels[id]!;
			// Each country and region has one id, which every place under it
			// refers to, as in a real place table: A and A1 are places 0 and
			// 1 themselves; B and B1 have no entry of their own.
			const ancestorIds: Record<string, number> = { A: 0, A1: 1, B: 100, B1: 101 };
			return {
				level: city ? "city" : region ? "region" : "country",
				country: ancestorIds[country![0]!]!,
				region: region && ancestorIds[region[0]!]!,
				city: city && id,
			};
		},
		/** Not counted: only the uncached references call it. */
		query(lat: number, lon: number): QueryResult {
			const result = reader.queryPlaceId(lat, lon);
			reader.queries--;
			return { ...result, ...levels[result.placeId ?? levels.length - 1]! };
		},
	};
	return reader;
}

/** Tiles across zoom levels, including ones that run past the poles. */
const TILES: [z: number, x: number, y: number][] = [
	[0, 0, 0],
	[1, 1, 0],
	[3, 4, 2],
	[6, 33, 21],
	[9, 263, 169],
	[12, 2104, 1350],
	[14, 8417, 5432],
];

test("the cached tile render matches querying every pixel", () => {
	const reader = syntheticReader();
	for (const [z, x, y] of TILES) {
		for (const resolution of [1, 3, 8, 64]) {
			const cached = renderTileGrid(reader, z, x, y, resolution).data;
			const expected = uncachedGrid(reader, z, x, y, resolution);
			assert.ok(
				cached.equals(expected),
				`tile ${z}/${x}/${y} at res ${resolution} differs`,
			);
		}
	}
});

test("the cache saves queries on a zoomed-in tile", () => {
	const reader = syntheticReader();
	renderTileGrid(reader, 14, 8417, 5432, 1);
	assert.ok(
		reader.queries < 256 * 256,
		`${reader.queries} queries for ${256 * 256} pixels`,
	);
});

/** Uncached: how strong the border is at each grid pixel (0 none, 1
 * city, 2 region, 3 country), from the pixel's place and the places of
 * the samples left of and above it, which for the first row and column
 * lie in the neighboring tile. */
function uncachedBorders(
	reader: QueryingReader,
	z: number,
	x: number,
	y: number,
	resolution: number,
): number[] {
	const gridSize = Math.floor(256 / resolution);
	const place = (gx: number, gy: number) => {
		const { lat, lon } = tilePixelToLonLat(
			z,
			x,
			y,
			gx * resolution + resolution / 2,
			gy * resolution + resolution / 2,
		);
		const r = reader.query(lat, lon);
		return [r.country, r.region, r.city].map((n) => JSON.stringify(n));
	};
	const strength = ([c1, r1, t1]: string[], [c2, r2, t2]: string[]): number =>
		c1 !== c2 ? 3 : r1 !== r2 ? 2 : t1 !== t2 ? 1 : 0;
	const out: number[] = [];
	for (let gy = 0; gy < gridSize; gy++) {
		for (let gx = 0; gx < gridSize; gx++) {
			const here = place(gx, gy);
			out.push(
				Math.max(
					strength(here, place(gx - 1, gy)),
					strength(here, place(gx, gy - 1)),
				),
			);
		}
	}
	return out;
}

test("borders darken exactly the pixels whose left or upper neighbor is another place", () => {
	const reader = syntheticReader();
	const alpha = [0, 0.3, 0.5, 0.75];
	for (const [z, x, y] of [
		[9, 263, 169],
		[12, 2104, 1350],
	] as const) {
		for (const resolution of [2, 8]) {
			const plain = renderTileGrid(reader, z, x, y, resolution).data;
			const bordered = renderTileGrid(reader, z, x, y, resolution, true).data;
			const expected = uncachedBorders(reader, z, x, y, resolution);
			let drawn = 0;
			for (const [i, strength] of expected.entries()) {
				const dark = alpha[strength]!;
				const [r, g, b, a] = plain.subarray(i * 4, i * 4 + 4);
				const want = [
					Math.round(r! * (1 - dark)),
					Math.round(g! * (1 - dark)),
					Math.round(b! * (1 - dark)),
					Math.round(a! + (255 - a!) * dark),
				];
				assert.deepEqual(
					[...bordered.subarray(i * 4, i * 4 + 4)],
					want,
					`tile ${z}/${x}/${y} res ${resolution} pixel ${i}`,
				);
				if (strength > 0) drawn++;
			}
			assert.ok(drawn > 0, `no borders in tile ${z}/${x}/${y}`);
		}
	}
});

test("default resolution is full from zoom 7 in and coarser further out", () => {
	assert.equal(defaultTileResolution(20), 1);
	assert.equal(defaultTileResolution(7), 1);
	assert.equal(defaultTileResolution(6), 2);
	assert.equal(defaultTileResolution(4), 8);
	assert.equal(defaultTileResolution(1), 64);
	assert.equal(defaultTileResolution(0), 64);
});

const ZUID_HOLLAND = fileURLToPath(
	new URL("../../data/03-final/zuid-holland.bin", import.meta.url),
);

test("the cached tile render matches querying every pixel on real data", {
	skip:
		!existsSync(ZUID_HOLLAND) &&
		"data/03-final/zuid-holland.bin not built (make netherlands)",
}, () => {
	const reader = CGeoDataReader.open(ZUID_HOLLAND);
	// Around Den Haag / Rotterdam, from a whole-province view in to
	// street level.
	for (const [z, x, y] of [
		[8, 131, 84],
		[11, 1048, 674],
		[14, 8389, 5397],
	] as const) {
		for (const resolution of [1, 4]) {
			const cached = renderTileGrid(reader, z, x, y, resolution).data;
			const expected = uncachedGrid(reader, z, x, y, resolution);
			assert.ok(
				cached.equals(expected),
				`tile ${z}/${x}/${y} at res ${resolution} differs`,
			);
		}
	}
});
