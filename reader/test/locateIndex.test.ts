import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildLocateIndex,
	buildSearchIndex,
	CGeoDataReader,
	type CGeoDataHeader,
	decodeLocateEntry,
	encodeLocateEntry,
	LocateIndex,
	locateEntryWidth,
	locateIndexPathFor,
} from "../src/index.js";
import { type CellList, representativeCell } from "../src/locateIndex.js";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

function hexBytes(hex: string): Uint8Array {
	return Uint8Array.from(
		hex
			.split(/\s+/)
			.filter((s) => s.length > 0)
			.map((s) => parseInt(s, 16)),
	);
}

// ── Appendix C.8 worked example ──────────────────────────────────────────────

// C.8.1, transcribed from the spec rather than produced by the builder.
const APPENDIX_C_BYTES = hexBytes(`
	43 47 45 4f 44 41 54 41
	20
	ea 66 ac 6c a7 f7 4b 33
	01
	07
	73 00 73 00 00 74 00
`);

function referenceFnv1a64(data: Uint8Array): bigint {
	let h = 0xcbf29ce484222325n;
	for (const byte of data) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
}

test("buildLocateIndex: reproduces the Appendix C.8 file byte for byte", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(buildLocateIndex(reader), APPENDIX_C_BYTES);
	reader.close();
});

test("prefixChecksum: FNV-1a of everything before the first chunk (C.8.1)", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.equal(reader.prefixChecksum(), 0x334bf7a76cac66ean);
	assert.equal(reader.prefixChecksum(), referenceFnv1a64(APPENDIX_A_BYTES.subarray(0, 131)));
	reader.close();
});

test("locate: Appendix C.8's coordinates, with and without the index", () => {
	const noGeometry = [1, 3, 4, 6]; // België, Antwerpen (region), Amsterdam, Antwerpen (city)
	for (const withIndex of [false, true]) {
		const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
		if (withIndex) reader.useLocateIndex(APPENDIX_C_BYTES);
		assert.equal(reader.hasLocateIndex, withIndex);
		// C.8.4: Nederland has no records of its own; its area is Noord-Holland's.
		for (const id of [0, 2]) {
			assert.deepEqual(reader.locate(id), {
				lat: 33.75,
				lon: 67.5,
				boundingBox: { minLon: 45, maxLon: 90, minLat: 22.5, maxLat: 45 },
			});
		}
		// C.8.3: the median falls in a gap and is moved to the lower row.
		assert.deepEqual(reader.locate(5), {
			lat: 11.25,
			lon: 112.5,
			boundingBox: { minLon: 90, maxLon: 135, minLat: 0, maxLat: 22.5 },
		});
		for (const id of noGeometry) assert.equal(reader.locate(id), null, `id ${id}`);
		assert.throws(() => reader.locate(7), RangeError);
		reader.close();
	}
});

// ── Entries (Section C.2) ────────────────────────────────────────────────────

const APPENDIX_A_GRID = { widthExp: 1, heightExp: 1, maxDepth: 2 };

test("decodeLocateEntry: the C.8.5 examples", () => {
	assert.equal(decodeLocateEntry(0, APPENDIX_A_GRID), null);
	assert.deepEqual(decodeLocateEntry(0x74, APPENDIX_A_GRID), { chunkIndex: 3, depth: 2, code: 4 });
	assert.deepEqual(decodeLocateEntry(0x75, APPENDIX_A_GRID), { chunkIndex: 3, depth: 2, code: 5 });
	assert.deepEqual(decodeLocateEntry(0x73, APPENDIX_A_GRID), { chunkIndex: 3, depth: 2, code: 3 });
	assert.throws(() => decodeLocateEntry(0x20, APPENDIX_A_GRID), /does not name a cell/); // odd t - B
	assert.throws(() => decodeLocateEntry(0x80, APPENDIX_A_GRID), /does not name a cell/); // deeper than D
	assert.throws(() => decodeLocateEntry(0x02, APPENDIX_A_GRID), /does not name a cell/); // shallower than depth 0
});

test("decodeLocateEntry: coarser cells decode to their stored codes", () => {
	// Depth 1 cell, path 2 (north-west), in chunk 1: 2^(2+2) + 1 × 4 + 2.
	assert.deepEqual(decodeLocateEntry(22, APPENDIX_A_GRID), { chunkIndex: 1, depth: 1, code: 8 });
	// A whole chunk (depth 0): just the marker and the chunk index.
	assert.deepEqual(decodeLocateEntry(4 + 2, APPENDIX_A_GRID), { chunkIndex: 2, depth: 0, code: 0 });
});

test("encodeLocateEntry/decodeLocateEntry: round trip at every depth, up to 6-byte entries", () => {
	const grids = [
		APPENDIX_A_GRID,
		{ widthExp: 6, heightExp: 6, maxDepth: 8 },
		{ widthExp: 6, heightExp: 6, maxDepth: 10 },
		{ widthExp: 6, heightExp: 6, maxDepth: 11 },
		{ widthExp: 7, heightExp: 6, maxDepth: 13 },
		{ widthExp: 6, heightExp: 6, maxDepth: 17 },
	];
	let seed = 1;
	const random = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	for (const grid of grids) {
		const width = locateEntryWidth(grid);
		const chunks = 2 ** (grid.widthExp + grid.heightExp);
		for (let depth = 0; depth <= grid.maxDepth; depth++) {
			for (const chunkIndex of [0, chunks - 1, random(chunks)]) {
				for (const path of [0, 4 ** depth - 1, random(4 ** depth)]) {
					const cell = { chunkIndex, depth, code: path * 4 ** (grid.maxDepth - depth) };
					const entry = encodeLocateEntry(cell, grid);
					assert.ok(entry > 0 && entry < 256 ** width, `${JSON.stringify(cell)} fits ${width} bytes`);
					assert.deepEqual(decodeLocateEntry(entry, grid), cell);
				}
			}
		}
	}
	assert.equal(encodeLocateEntry(null, APPENDIX_A_GRID), 0);
});

test("locateEntryWidth: 4 bytes for the worldwide depth-8 grid, 5 at depth 10 and 11", () => {
	const grid = (maxDepth: number) => ({ widthExp: 6, heightExp: 6, maxDepth });
	assert.equal(locateEntryWidth(APPENDIX_A_GRID), 1);
	assert.equal(locateEntryWidth(grid(8)), 4);
	assert.equal(locateEntryWidth(grid(9)), 4);
	assert.equal(locateEntryWidth(grid(10)), 5);
	assert.equal(locateEntryWidth(grid(11)), 5);
	assert.equal(locateEntryWidth(grid(13)), 5);
	assert.equal(locateEntryWidth(grid(14)), 6);
});

// ── Representative cell (Section C.3) ────────────────────────────────────────

/** One 16 × 16 chunk: W = H = 1, D = 4. A cell is 360/16 wide and 180/16
 * high, so distances weigh columns twice as much as rows (a = 2, b = 1). */
const ONE_CHUNK = {
	widthExp: 0,
	heightExp: 0,
	width: 1,
	height: 1,
	maxDepth: 4,
} as CGeoDataHeader;

/** [gx, gy, depth] squares, in full-precision cells. */
function cells(squares: Array<[number, number, number]>): CellList {
	return {
		gx: Uint32Array.from(squares.map((s) => s[0])),
		gy: Uint32Array.from(squares.map((s) => s[1])),
		depth: Uint8Array.from(squares.map((s) => s[2])),
	};
}

function rep(squares: Array<[number, number, number]>) {
	return representativeCell(cells(squares), 0, squares.length, ONE_CHUNK);
}

test("representativeCell: an empty area has none", () => {
	assert.equal(rep([]), undefined);
});

test("representativeCell: with equal weights, an odd count takes the middle value", () => {
	assert.deepEqual(rep([[1, 3, 4], [9, 3, 4], [5, 3, 4]]), { gx: 5, gy: 3 });
});

test("representativeCell: with equal weights, an even count takes the midpoint", () => {
	// Centres (half-cells) 5 and 13 on both axes: midpoint 9 -> cell 4...
	// but (4, 4) is outside the area, and (2, 2) and (6, 6) are equally near:
	// the lower row wins.
	assert.deepEqual(rep([[6, 6, 4], [2, 2, 4]]), { gx: 2, gy: 2 });
	// Same row: the lower column wins.
	assert.deepEqual(rep([[6, 0, 4], [2, 0, 4]]), { gx: 2, gy: 0 });
	// A midpoint inside the area is kept. Centres 5, 7, 9, 11: the midpoint
	// of 7 and 9 is the edge between cells 3 and 4, which belongs to cell 4
	// like every half-open cell's west edge.
	assert.deepEqual(rep([[2, 0, 4], [3, 0, 4], [4, 0, 4], [5, 0, 4]]), { gx: 4, gy: 0 });
});

test("representativeCell: cells are weighted by area, so one large cell outweighs many small ones", () => {
	// A depth-2 square (4 × 4 cells, weight 16) and three single cells far to
	// the east. Unweighted, the median would be among the singles.
	assert.deepEqual(rep([[12, 0, 4], [0, 0, 2], [13, 0, 4], [14, 0, 4]]), { gx: 2, gy: 2 });
});

test("representativeCell: a median outside the area moves to the nearest cell inside it", () => {
	// A ring of single cells around (8, 8): the median is the empty middle.
	const ring: Array<[number, number, number]> = [];
	for (let x = 5; x <= 11; x++) ring.push([x, 5, 4], [x, 11, 4]);
	for (let y = 6; y <= 10; y++) ring.push([5, y, 4], [11, y, 4]);
	// Columns count double, so the nearest ring cells are straight north and
	// south of (8, 8) at distance 3; the lower one wins.
	assert.deepEqual(rep(ring), { gx: 8, gy: 5 });
});

test("representativeCell: the result is in the area and doesn't depend on record order", () => {
	let seed = 7;
	const random = (n: number) => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed % n;
	};
	for (let trial = 0; trial < 200; trial++) {
		// Non-overlapping random squares: pick distinct aligned cells per depth
		// on separate quadrants of a coarse grid.
		const squares: Array<[number, number, number]> = [];
		const used = new Set<number>();
		for (let k = random(6) + 1; k > 0; k--) {
			const slot = random(16); // one of 16 depth-2 slots
			if (used.has(slot)) continue;
			used.add(slot);
			const depth = 2 + random(3); // 2..4, all inside the slot
			const size = 2 ** (4 - depth);
			const sx = (slot % 4) * 4 + random(4 / size) * size;
			const sy = Math.floor(slot / 4) * 4 + random(4 / size) * size;
			squares.push([sx, sy, depth]);
		}
		const result = rep(squares)!;
		const inside = squares.some(
			([x, y, d]) =>
				result.gx >= x && result.gx < x + 2 ** (4 - d) && result.gy >= y && result.gy < y + 2 ** (4 - d),
		);
		assert.ok(inside, `trial ${trial}: ${JSON.stringify(result)} outside ${JSON.stringify(squares)}`);
		assert.deepEqual(rep([...squares].reverse()), result, `trial ${trial}: order changed the result`);
	}
});

// ── LocateIndex file (Sections C.4, C.6) ─────────────────────────────────────

test("LocateIndex.open: reads the header and entries of the C.8 file", () => {
	const index = LocateIndex.open(APPENDIX_C_BYTES);
	assert.equal(index.sourceChecksum, 0x334bf7a76cac66ean);
	assert.equal(index.entryWidth, 1);
	assert.equal(index.placeCount, 7);
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((id) => index.entry(id)), [0x73, 0, 0x73, 0, 0, 0x74, 0]);
	assert.throws(() => index.entry(7), RangeError);
});

test("LocateIndex.open: rejects malformed files", () => {
	assert.throws(() => LocateIndex.open(new Uint8Array(5)), /too short/);
	assert.throws(() => LocateIndex.open(new Uint8Array(40)), /wrong magic bytes/);
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.throws(() => LocateIndex.open(buildSearchIndex(reader)), /kind 1, expected 2/);
	reader.close();
	assert.throws(() => LocateIndex.open(APPENDIX_C_BYTES.subarray(0, 25)), /header implies 26/);
	const wide = APPENDIX_C_BYTES.slice();
	wide[17] = 7; // entry_width
	assert.throws(() => LocateIndex.open(wide), /entry width 7/);
});

test("useLocateIndex: rejects an index with the wrong checksum, place count or width", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const badChecksum = APPENDIX_C_BYTES.slice();
	badChecksum[9]! ^= 0xff; // first checksum byte, after "CGEODATA" + version 0x20
	assert.throws(() => reader.useLocateIndex(badChecksum), /checksum mismatch/);
	assert.equal(reader.hasLocateIndex, false);

	const fewer = Uint8Array.from([...APPENDIX_C_BYTES.subarray(0, 18), 6, ...APPENDIX_C_BYTES.subarray(19, 25)]);
	assert.throws(() => reader.useLocateIndex(fewer), /covers 6 places, but this file has 7/);

	const wider = Uint8Array.from([
		...APPENDIX_C_BYTES.subarray(0, 17),
		2,
		7,
		...[...APPENDIX_C_BYTES.subarray(19)].flatMap((b) => [b, 0]),
	]);
	assert.throws(() => reader.useLocateIndex(wider), /2-byte entries, but this file's grid needs 1/);
	reader.close();
});

test("open: picks up <name>.locate-index.bin next to the file; a stale one throws on locate", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-locate-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	assert.equal(locateIndexPathFor(binPath), path.join(dir, "fixture.locate-index.bin"));

	const without = CGeoDataReader.open(binPath);
	assert.equal(without.hasLocateIndex, false);
	without.close();

	writeFileSync(locateIndexPathFor(binPath), APPENDIX_C_BYTES);
	const withIndex = CGeoDataReader.open(binPath);
	assert.equal(withIndex.hasLocateIndex, true);
	assert.equal(withIndex.locate(5)?.lat, 11.25);
	withIndex.close();

	const stale = APPENDIX_C_BYTES.slice();
	stale[9]! ^= 0xff;
	writeFileSync(locateIndexPathFor(binPath), stale);
	const reader = CGeoDataReader.open(binPath); // opening alone doesn't touch it
	assert.throws(() => reader.locate(5), /fixture\.locate-index\.bin: .*checksum mismatch/);
	assert.throws(() => reader.locate(5), /checksum mismatch/); // every time
	reader.useLocateIndex(undefined); // opting out still works
	assert.equal(reader.locate(5)?.lat, 11.25);
	reader.close();
});

// ── Reader helpers ───────────────────────────────────────────────────────────

test("subtreeIdRanges: a place, then its children's ranges", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(reader.subtreeIdRanges(0), [[0, 1], [2, 3], [4, 6]]);
	assert.deepEqual(reader.subtreeIdRanges(1), [[1, 2], [3, 4], [6, 7]]);
	assert.deepEqual(reader.subtreeIdRanges(3), [[3, 4], [6, 7]]);
	assert.deepEqual(reader.subtreeIdRanges(5), [[5, 6]]);
	assert.throws(() => reader.subtreeIdRanges(7), RangeError);
	reader.close();
});

test("chunk: cache false parses the same records without caching them", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(reader.chunk(3, { cache: false }), reader.chunk(3));
	assert.equal(reader.chunk(0, { cache: false }), undefined);
	reader.close();
});

// ── Real data ────────────────────────────────────────────────────────────────

// Max depth 10 on a 64 × 64 grid: 5-byte entries, and enough places to
// exercise the builder's batching and every level of the hierarchy.
const ZH_BIN = fileURLToPath(new URL("../../data/03-final/zuid-holland.bin", import.meta.url));
if (existsSync(ZH_BIN)) {
	test("zuid-holland.bin: index and scan agree, in any batch size, and every point is inside its place", () => {
		const scan = CGeoDataReader.open(ZH_BIN);
		scan.useLocateIndex(undefined);
		const bytes = buildLocateIndex(scan);
		assert.deepEqual(buildLocateIndex(scan, { batchRecords: 1 }), bytes);
		const indexed = CGeoDataReader.open(ZH_BIN);
		indexed.useLocateIndex(bytes);
		assert.equal(LocateIndex.open(bytes).entryWidth, 5);

		const { countries, regions, cities } = scan.placeCounts;
		let located = 0;
		for (let id = 0; id < countries + regions + cities; id++) {
			const point = indexed.locate(id);
			assert.deepEqual(point, scan.locate(id), `id ${id}`);
			if (!point) continue;
			located++;
			const place = indexed.place(id);
			const found = indexed.query(point.lat, point.lon);
			const names = { country: found.country, region: found.region, city: found.city }[place.level];
			assert.deepEqual(names, place.names, `id ${id}'s point resolves elsewhere`);
		}
		assert.ok(located > (countries + regions + cities) / 2, `only ${located} places located`);
		scan.close();
		indexed.close();
	});
}
