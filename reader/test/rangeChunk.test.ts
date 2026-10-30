import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { generate, MODULES } from "../scripts/build-wasm.ts";
import { parseChunk } from "../src/chunk.ts";
import { CGeoDataFormatError } from "../src/errors.ts";
import {
	decodeRangeCodedRecords,
	encodeRangeCodedRecords,
	type RangeCodedRecords,
	writeVarint,
} from "../src/format.ts";
import {
	decodeRangeCodedWasm,
	useWasmRangeDecoder,
	wasmRangeDecoderAvailable,
	wasmRangeDecoderBytes,
} from "../src/rangeDecoder.ts";

/** Deterministic PRNG, so a failure reproduces. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Records {
	depths: number[];
	indices: number[];
}

/** Random records tiling a chunk at `maxDepth`, subdivided mostly near
 * the finest levels as real chunks are, with palette indices up to
 * `paletteCount` that often repeat the one before (as neighbouring cells
 * of one place do). Sometimes stops before the end of the chunk. */
function randomRecords(
	rand: () => number,
	maxDepth: number,
	paletteCount: number,
): Records {
	const records: Records = { depths: [], indices: [] };
	const limit = rand() < 0.3 ? Math.floor(rand() * 2000) : 20000;
	let index = 0;
	const node = (d: number): void => {
		if (records.depths.length >= limit) return;
		const splitChance = d === 0 ? 0.95 : d < maxDepth - 4 ? 0.3 : 0.55;
		if (d < maxDepth && rand() < splitChance) {
			for (let q = 0; q < 4; q++) node(d + 1);
			return;
		}
		if (rand() < 0.35) index = Math.floor(rand() * (paletteCount + 1));
		records.depths.push(d);
		records.indices.push(index);
	};
	node(0);
	return records;
}

/** A version 2 chunk block of `records` (Section 8.7) with palette ids
 * 0..P-1, and where its stream starts. */
function encodeBlock(
	records: Records,
	paletteCount: number,
	maxDepth: number,
): { bytes: Uint8Array; streamStart: number } {
	const head = [...writeVarint(paletteCount)];
	for (let k = 0; k < paletteCount; k++) head.push(...writeVarint(k ? 1 : 0));
	head.push(...writeVarint(records.depths.length));
	const stream = encodeRangeCodedRecords(
		records.depths,
		records.indices,
		paletteCount,
		maxDepth,
	);
	return {
		bytes: Uint8Array.from([...head, ...stream]),
		streamStart: head.length,
	};
}

/** The JavaScript decoder's answer: the records, or the error it threw. */
function decodeJs(
	bytes: Uint8Array,
	offset: number,
	paletteCount: number,
	recordCount: number,
	maxDepth: number,
): RangeCodedRecords | Error {
	useWasmRangeDecoder(false);
	try {
		return decodeRangeCodedRecords(
			bytes,
			offset,
			paletteCount,
			recordCount,
			maxDepth,
		);
	} catch (err) {
		assert.ok(err instanceof CGeoDataFormatError, String(err));
		return err;
	} finally {
		useWasmRangeDecoder(true);
	}
}

test("the committed src/rangeDecoderWasm.ts matches wasm/rangeDecoder.wat", async () => {
	const committed = readFileSync(
		new URL("../src/rangeDecoderWasm.ts", import.meta.url),
		"utf8",
	);
	assert.equal(
		committed,
		await generate(MODULES[1]),
		"stale: run npm run build:wasm -w reader",
	);
});

test("Node.js runs the WebAssembly range decoder", () => {
	assert.ok(wasmRangeDecoderAvailable());
});

test("random chunks round-trip through both decoders", () => {
	const rand = mulberry32(1);
	for (let round = 0; round < 300; round++) {
		const maxDepth = 1 + Math.floor(rand() * 16);
		const paletteCount = [0, 1, 7, 255, 256, 70000][round % 6]!;
		const records = randomRecords(rand, maxDepth, paletteCount);
		const { bytes, streamStart } = encodeBlock(records, paletteCount, maxDepth);
		const n = records.depths.length;
		const js = decodeJs(bytes, streamStart, paletteCount, n, maxDepth);
		assert.ok(!(js instanceof Error), `round ${round}: ${js}`);
		assert.deepEqual([...js.depths], records.depths, `round ${round}`);
		assert.deepEqual([...js.paletteIndices], records.indices, `round ${round}`);
		let code = 0;
		for (let j = 0; j < n; j++) {
			assert.equal(js.codes[j], code, `round ${round} record ${j}`);
			code += 4 ** (maxDepth - records.depths[j]!);
		}
		const wasm = decodeRangeCodedWasm(
			bytes,
			streamStart,
			paletteCount,
			n,
			maxDepth,
		);
		assert.ok(wasm, `round ${round}: a valid stream was declined`);
		assert.deepEqual(wasm, js, `round ${round}`);
		// And parseChunk, palette included.
		const chunk = parseChunk(bytes, maxDepth, 2);
		assert.deepEqual(
			chunk.palette,
			Array.from({ length: paletteCount }, (_, k) => k),
		);
		assert.deepEqual(chunk.depths, js.depths);
	}
});

test("the fast path declines every stream the JavaScript decoder rejects", () => {
	const rand = mulberry32(2);
	let rejected = 0;
	let accepted = 0;
	for (let round = 0; round < 200; round++) {
		const maxDepth = 2 + Math.floor(rand() * 15);
		const paletteCount = [1, 5, 255, 256, 70000][round % 5]!;
		const records = randomRecords(rand, maxDepth, paletteCount);
		const { bytes, streamStart } = encodeBlock(records, paletteCount, maxDepth);
		for (let m = 0; m < 40; m++) {
			let corrupted = bytes;
			let n = records.depths.length;
			const kind = m % 5;
			if (kind === 0) {
				corrupted = bytes.slice();
				const at =
					streamStart + Math.floor(rand() * (bytes.length - streamStart));
				corrupted[at]! ^= 1 << Math.floor(rand() * 8);
			} else if (kind === 1) {
				corrupted = bytes.subarray(
					0,
					streamStart + Math.floor(rand() * (bytes.length - streamStart)),
				);
			} else if (kind === 2) {
				corrupted = Uint8Array.from([
					...bytes,
					...Array.from({ length: 1 + Math.floor(rand() * 4) }, () =>
						Math.floor(rand() * 256),
					),
				]);
			} else if (kind === 3) {
				n += Math.floor(rand() * 2000) - 1000;
				if (n < 0) n = 0;
			} else {
				corrupted = bytes.slice();
				for (let k = 0; k < 4; k++) {
					const at =
						streamStart + Math.floor(rand() * (bytes.length - streamStart));
					corrupted[at] = Math.floor(rand() * 256);
				}
			}
			const js = decodeJs(corrupted, streamStart, paletteCount, n, maxDepth);
			let wasm: RangeCodedRecords | undefined;
			try {
				wasm = decodeRangeCodedWasm(
					corrupted,
					streamStart,
					paletteCount,
					n,
					maxDepth,
				);
			} catch (err) {
				// Only Section 8.7.5's bounds, which the caller checks first.
				assert.ok(js instanceof Error, String(err));
				continue;
			}
			if (js instanceof Error) {
				rejected++;
				assert.equal(wasm, undefined, `round ${round}.${m}: ${js.message}`);
			} else if (wasm) {
				accepted++;
				assert.deepEqual(wasm, js, `round ${round}.${m}`);
			}
		}
	}
	assert.ok(rejected > 3000, `only ${rejected} corrupted streams rejected`);
	assert.ok(accepted > 100, `only ${accepted} corrupted streams accepted`);
});

test("the JavaScript decoder names what is wrong", () => {
	const records = { depths: [1, 1, 1, 1], indices: [1, 0, 1, 1] };
	const { bytes, streamStart } = encodeBlock(records, 1, 2);
	const decode = (b: Uint8Array, n = 4, p = 1) =>
		decodeRangeCodedRecords(b, streamStart, p, n, 2);
	assert.deepEqual([...decode(bytes).paletteIndices], [1, 0, 1, 1]);
	const flipped = bytes.slice();
	flipped[streamStart] = 1;
	assert.throws(() => decode(flipped), /does not start with a 0 byte/);
	assert.throws(
		() => decode(bytes.subarray(0, streamStart + 4)),
		/shorter than 5 bytes/,
	);
	assert.throws(() => decode(Uint8Array.from([...bytes, 0])), /trailing bytes/);
	assert.throws(() => decode(bytes, 17), /more than the 4\^2 cells/);
	assert.throws(
		() => decode(bytes, 5),
		/more than the 4 records its quadtree has/,
	);
	assert.throws(() => decode(bytes, 4, 2 ** 26), /2\^26 or more/);
	const streamBytes = bytes.length - streamStart;
	assert.throws(
		() =>
			decodeRangeCodedRecords(bytes, streamStart, 1, 2048 * streamBytes + 1, 8),
		new RegExp(`more than a ${streamBytes}-byte stream can code`),
	);
});

test("a stream starting with code 0xffffffff is rejected by both decoders", () => {
	// From that code every decision decodes as a 1, which the encoder can't
	// produce; the first leaf's rank then runs to 32 bits.
	const stream = Uint8Array.from([
		0,
		255,
		255,
		255,
		255,
		...new Array(64).fill(0),
	]);
	assert.throws(
		() => decodeRangeCodedRecords(stream, 0, 3, 1, 4),
		/starts with code 0xffffffff/,
	);
	assert.equal(decodeRangeCodedWasm(stream, 0, 3, 1, 4), undefined);
});

test("encodeRangeCodedRecords refuses records that don't tile the chunk", () => {
	assert.throws(
		() => encodeRangeCodedRecords([2, 1], [0, 0], 0, 2),
		/doesn't tile the chunk/,
	);
	assert.throws(
		() => encodeRangeCodedRecords([0, 0], [0, 0], 0, 2),
		/past the end of the chunk/,
	);
	assert.throws(() => encodeRangeCodedRecords([0], [2], 1, 2), /past P/);
});

test("the range decoder holds no WebAssembly memory once idle", async () => {
	const { bytes, streamStart } = encodeBlock(
		{ depths: [1, 1, 1, 1], indices: [1, 0, 1, 1] },
		1,
		2,
	);
	assert.ok(decodeRangeCodedWasm(bytes, streamStart, 1, 4, 2));
	assert.ok(wasmRangeDecoderBytes() > 0);
	await sleep(1100);
	assert.equal(wasmRangeDecoderBytes(), 0);
});
