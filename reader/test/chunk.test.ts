import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChunk, writeVarint } from "../src/format.ts";
import { CGeoDataFormatError } from "../src/index.ts";

/** An inflated version 0 chunk block (Section 8.6) of `codes` (stored
 * codes, not deltas), with palette ids 0..paletteCount-1 and every record
 * pointing at palette entry 1. */
function chunkBlock(
	paletteCount: number,
	codes: number[],
	depths: number[],
): Uint8Array {
	const width =
		paletteCount <= 255
			? 1
			: paletteCount <= 65535
				? 2
				: paletteCount < 2 ** 24
					? 3
					: 4;
	const codeBytes = codes.flatMap((code, j) => [
		...writeVarint(code - (codes[j - 1] ?? 0)),
	]);
	const index = [1, ...new Array<number>(width - 1).fill(0)];
	return Uint8Array.from([
		...writeVarint(paletteCount),
		...writeVarint(0),
		...new Array<number>(paletteCount - 1).fill(1),
		...writeVarint(codes.length),
		...writeVarint(codeBytes.length),
		...codeBytes,
		...depths,
		...codes.flatMap(() => index),
	]);
}

test("parseChunk keeps codes in a Uint32Array, up to max_depth 16", () => {
	const chunk = parseChunk(chunkBlock(1, [0, 4, 8, 12], [1, 1, 1, 1]), 2, 0);
	assert.ok(chunk.codes instanceof Uint32Array);
	assert.deepEqual(Array.from(chunk.codes), [0, 4, 8, 12]);

	// 4^16 - 1, the largest max_depth-16 code, still fits.
	const last = 4 ** 16 - 1;
	const deep = parseChunk(chunkBlock(1, [0, last], [15, 16]), 16, 0);
	assert.ok(deep.codes instanceof Uint32Array);
	assert.deepEqual(Array.from(deep.codes), [0, last]);
});

test("parseChunk refuses a max_depth past 16", () => {
	// A caller's argument, so a RangeError (the reader itself refuses such
	// a file when it opens it).
	assert.throws(
		() => parseChunk(chunkBlock(1, [0, 4 ** 16], [16, 17]), 17, 0),
		RangeError,
	);
});

test("parseChunk rejects a code past 32 bits at max_depth 16", () => {
	assert.throws(
		() => parseChunk(chunkBlock(1, [0, 4 ** 16], [16, 16]), 16, 0),
		CGeoDataFormatError,
	);
});

for (const [paletteCount, type] of [
	[255, Uint8Array],
	[256, Uint16Array],
	[65535, Uint16Array],
	[65536, Uint32Array],
] as const) {
	test(`parseChunk holds ${paletteCount} palette entries' indices in a ${type.name}`, () => {
		const chunk = parseChunk(
			chunkBlock(paletteCount, [0, 1, 2], [2, 2, 2]),
			2,
			0,
		);
		assert.equal(chunk.palette.length, paletteCount);
		assert.ok(chunk.paletteIndices instanceof type);
		assert.deepEqual(Array.from(chunk.paletteIndices), [1, 1, 1]);
	});
}

/** An inflated chunk block (Section 8.2) of one-byte palette indices,
 * with palette ids 0..paletteCount-1. */
function recordsBlock(
	paletteCount: number,
	depths: number[],
	indices: number[] = depths.map(() => 1),
): Uint8Array {
	return Uint8Array.from([
		...writeVarint(paletteCount),
		...writeVarint(0),
		...new Array<number>(paletteCount - 1).fill(1),
		...writeVarint(depths.length),
		...depths,
		...indices,
	]);
}

test("parseChunk derives each code from the depths before it", () => {
	// Appendix A's chunk 3: Noord-Holland, Zaandam, three empty max-depth
	// cells, Noord-Holland, Zaandam; codes 13 to 15 are left empty.
	const chunk = parseChunk(
		recordsBlock(2, [1, 2, 2, 2, 2, 1, 2], [1, 2, 0, 0, 0, 1, 2]),
		2,
		1,
	);
	assert.ok(chunk.codes instanceof Uint32Array);
	assert.deepEqual(Array.from(chunk.codes), [0, 4, 5, 6, 7, 8, 12]);
	assert.deepEqual(Array.from(chunk.depths), [1, 2, 2, 2, 2, 1, 2]);
	assert.deepEqual(Array.from(chunk.paletteIndices), [1, 2, 0, 0, 0, 1, 2]);
	assert.deepEqual(chunk.palette, [0, 1]);
});

test("parseChunk reads a chunk that is one record, and one with none", () => {
	assert.deepEqual(
		Array.from(parseChunk(recordsBlock(1, [0]), 2, 1).codes),
		[0],
	);
	assert.deepEqual(Array.from(parseChunk(recordsBlock(1, []), 2, 1).codes), []);
});

test("parseChunk keeps derived codes in 32 bits at max_depth 16", () => {
	const chunk = parseChunk(recordsBlock(1, [1, 1, 1, 1]), 16, 1);
	assert.deepEqual(Array.from(chunk.codes), [0, 2 ** 30, 2 ** 31, 3 * 2 ** 30]);
	assert.deepEqual(
		Array.from(parseChunk(recordsBlock(1, [0]), 16, 1).codes),
		[0],
	);
});

for (const [name, block, maxDepth] of [
	["a depth past max_depth", recordsBlock(1, [3]), 2],
	["a record not aligned to its depth", recordsBlock(1, [2, 1]), 2],
	["a record after the chunk is full", recordsBlock(1, [0, 2]), 2],
	["a record that runs past the chunk", recordsBlock(1, [1, 1, 1, 2, 1]), 2],
	["the same at max_depth 16", recordsBlock(1, [1, 1, 1, 1, 1]), 16],
	["a palette index past P", recordsBlock(1, [1], [2]), 2],
	["a block cut short", recordsBlock(1, [1, 1]).subarray(0, 6), 2],
	["trailing bytes", Uint8Array.from([...recordsBlock(1, [1]), 0]), 2],
] as const) {
	test(`parseChunk rejects ${name}`, () => {
		assert.throws(() => parseChunk(block, maxDepth, 1), CGeoDataFormatError);
	});
}
