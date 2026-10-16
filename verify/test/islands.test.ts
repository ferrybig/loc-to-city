import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChunkRecords } from "@ferrybig/cgeodata-reader/format";
import { mortonDecode, mortonEncode } from "@ferrybig/cgeodata-reader/format";
import {
	BORDER_EAST,
	BORDER_NORTH,
	BORDER_SOUTH,
	BORDER_WEST,
	combineIslands,
	compactBits,
	scanChunk,
} from "../src/islands.ts";

const D = 2; // a 4x4 chunk

/** A chunk of depth-2 cells from a picture, top row first: a letter is a
 * place (palette order), `.` no place. */
function chunkOf(rows: string[]): ChunkRecords {
	const letters = [...new Set(rows.join("").replaceAll(".", ""))].sort();
	const cells: { code: number; k: number }[] = [];
	rows.forEach((line, r) => {
		const y = rows.length - 1 - r;
		[...line].forEach((ch, x) => {
			cells.push({
				code: mortonEncode(x, y, D),
				k: ch === "." ? 0 : letters.indexOf(ch) + 1,
			});
		});
	});
	cells.sort((a, b) => a.code - b.code);
	return {
		palette: letters.map((l) => l.charCodeAt(0)),
		codes: Uint32Array.from(cells, (c) => c.code),
		depths: Uint8Array.from(cells, () => D),
		paletteIndices: Uint8Array.from(cells, (c) => c.k),
	};
}

const A = "A".charCodeAt(0);
const B = "B".charCodeAt(0);

test("compactBits takes a Morton code apart like mortonDecode", () => {
	for (const code of [0, 1, 2, 3, 0x12345678, 0xffffffff, 0x80000001]) {
		const { x, y } = mortonDecode(code, 16);
		assert.deepEqual([compactBits(code), compactBits(code >>> 1)], [x, y]);
	}
});

test("cells touching only at a corner are two islands", () => {
	const { islands } = scanChunk(chunkOf(["A...", ".A..", "....", "...."]), D);
	assert.equal(islands.filter((i) => i.place === A).length, 2);
});

test("a place cut in two is two islands, each with the borders it touches", () => {
	const { islands } = scanChunk(chunkOf(["AAAA", "BBBB", "AABA", "AAAA"]), D);
	const a = islands
		.filter((i) => i.place === A)
		.map((i) => i.mask)
		.sort((x, y) => x - y);
	assert.deepEqual(
		a,
		[
			BORDER_WEST | BORDER_EAST | BORDER_NORTH,
			BORDER_WEST | BORDER_EAST | BORDER_SOUTH,
		].sort((x, y) => x - y),
	);
	assert.equal(islands.filter((i) => i.place === B).length, 1);
});

test("a big record joins the small ones along its edge", () => {
	// One depth-1 A in the south-west quarter, depth-2 A cells east of it.
	const codes = [
		mortonEncode(0, 0, 1) * 4,
		mortonEncode(2, 1, D),
		mortonEncode(3, 3, D),
	].sort((x, y) => x - y);
	const chunk: ChunkRecords = {
		palette: [A],
		codes: Uint32Array.from(codes),
		depths: Uint8Array.from(codes, (c) => (c === 0 ? 1 : D)),
		paletteIndices: Uint8Array.from(codes, () => 1),
	};
	const { islands } = scanChunk(chunk, D);
	assert.equal(islands.length, 2); // (3, 3) only touches nothing
	assert.equal(
		islands.find((i) => i.cells === 5)?.mask,
		BORDER_WEST | BORDER_SOUTH,
	);
});

test("islands that meet across a chunk border are one, including across the antimeridian", () => {
	// Two chunks side by side, wrapping: A runs over both shared borders.
	const left = scanChunk(chunkOf(["A..A", "....", "....", "B..."]), D);
	const right = scanChunk(chunkOf(["A..A", "....", "....", "...B"]), D);
	const places = combineIslands([left, right], 2);
	assert.equal(places.get(A)?.islands, 2); // two A runs, each over one border
	assert.equal(places.get(B)?.islands, 1); // B meets itself across the antimeridian
});

test("a corner touch across chunks does not join", () => {
	// Chunk 1 is north of chunk 0 (width 1). A in the lower chunk's
	// north-east cell and in the upper chunk's cell diagonally next to it
	// only touch at a corner; in the cell straight above, they share an edge.
	const lower = scanChunk(chunkOf(["...A", "....", "....", "...."]), D);
	const upper = scanChunk(chunkOf(["....", "....", "....", "..A."]), D);
	assert.equal(combineIslands([lower, upper], 1).get(A)?.islands, 2);
	const upperJoined = scanChunk(chunkOf(["....", "....", "....", "...A"]), D);
	assert.equal(combineIslands([lower, upperJoined], 1).get(A)?.islands, 1);
});
