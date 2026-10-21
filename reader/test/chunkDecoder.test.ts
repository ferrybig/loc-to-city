import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { generate } from "../scripts/build-wasm.ts";
import { parseChunk } from "../src/chunk.ts";
import {
	decodeChunkCodes,
	useWasmChunkDecoder,
	WASM_MIN_RECORDS,
	wasmChunkDecoderAvailable,
	wasmChunkDecoderBytes,
} from "../src/chunkDecoder.ts";
import { writeVarint } from "../src/format.ts";

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

/** A chunk's records before encoding. */
interface Records {
	maxDepth: number;
	paletteCount: number;
	codes: number[];
	depths: number[];
	indices: number[];
}

/** An encoded chunk block (Section 8.2) and where its parts are. */
interface Block {
	bytes: Uint8Array;
	codesStart: number;
	codesLength: number;
	recordCount: number;
	paletteCount: number;
	width: number;
}

/** Random valid records at `maxDepth`: a quadtree subdivided mostly near
 * its finest levels, as real chunks are, with some cells left out (gaps,
 * so multi-byte deltas) and palette indices up to `paletteCount`. */
function randomRecords(
	rand: () => number,
	maxDepth: number,
	paletteCount: number,
): Records {
	const records: Records = {
		maxDepth,
		paletteCount,
		codes: [],
		depths: [],
		indices: [],
	};
	const visit = (code: number, depth: number): void => {
		if (records.codes.length >= 3000) return;
		const stop =
			depth === maxDepth || rand() < (maxDepth - depth > 4 ? 0.02 : 0.35);
		if (stop) {
			if (rand() < 0.95) {
				records.codes.push(code);
				records.depths.push(depth);
				records.indices.push(Math.floor(rand() * (paletteCount + 1)));
			}
			return;
		}
		const quarter = 4 ** (maxDepth - depth - 1);
		for (let q = 0; q < 4; q++) visit(code + q * quarter, depth + 1);
	};
	visit(0, 0);
	return records;
}

/** `records` as a block. `encodeDelta` writes code `j`'s delta (to plant
 * a non-minimal varint); `padding` goes between the codes and the
 * depths, counted in codes_length. */
function encode(
	{ paletteCount, codes, depths, indices }: Records,
	encodeDelta: (delta: number, j: number) => number[] = (delta) => [
		...writeVarint(delta),
	],
	padding: number[] = [],
): Block {
	const width = paletteCount <= 255 ? 1 : paletteCount <= 65535 ? 2 : 3;
	const codeBytes = [
		...codes.flatMap((code, j) => encodeDelta(code - (codes[j - 1] ?? 0), j)),
		...padding,
	];
	const head = [
		...writeVarint(paletteCount),
		...(paletteCount > 0 ? writeVarint(7) : []),
		...new Array<number>(Math.max(0, paletteCount - 1)).fill(1),
		...writeVarint(codes.length),
		...writeVarint(codeBytes.length),
	];
	const indexBytes = indices.flatMap((k) =>
		[k & 0xff, (k >> 8) & 0xff, (k >> 16) & 0xff].slice(0, width),
	);
	return {
		bytes: Uint8Array.from([...head, ...codeBytes, ...depths, ...indexBytes]),
		codesStart: head.length,
		codesLength: codeBytes.length,
		recordCount: codes.length,
		paletteCount,
		width,
	};
}

/** `records` broken in one way -- most aimed at a single Section 8.5
 * check, the odd random byte at anything (which may leave it valid). */
function corrupt(rand: () => number, records: Records): Block {
	const pick = (n: number) => Math.floor(rand() * n);
	const { maxDepth, codes, depths } = records;
	const r: Records = {
		...records,
		codes: [...codes],
		depths: [...depths],
		indices: [...records.indices],
	};
	const n = codes.length;
	const j = 1 + pick(n - 1);
	const span = (d: number) => 4 ** (maxDepth - d);
	switch (pick(10)) {
		case 0: // a code equal to the one before it
			r.codes[j] = codes[j - 1]!;
			break;
		case 1: // a depth past max_depth, as far as 255
			r.depths[j] = rand() < 0.5 ? 255 : maxDepth + 1 + pick(255 - maxDepth);
			break;
		case 2: // the previous cell grown over this one
			r.depths[j - 1] = Math.max(0, depths[j - 1]! - 1 - pick(2));
			break;
		case 3: {
			// a code off its span's grid, with room after it, so only the
			// alignment check catches it
			const k = codes.findIndex(
				(code, i) =>
					i >= j &&
					depths[i]! < maxDepth &&
					(codes[i + 1] ?? 4 ** maxDepth) > code + span(depths[i]!),
			);
			if (k >= 0) r.codes[k] = codes[k]! + 1;
			break;
		}
		case 4: // a palette index past P
			r.indices[j] = records.paletteCount + 1;
			break;
		case 5: // the last code at or past 4^max_depth
			r.codes[n - 1] = 4 ** maxDepth + pick(3) * span(depths[n - 1]!);
			break;
		case 6: // a non-minimal varint: an extra, zero, last group
			return encode(r, (delta, i) => {
				const bytes = [...writeVarint(delta)];
				return i === j ? [...bytes.map((b) => b | 0x80), 0] : bytes;
			});
		case 7: // bytes between the codes and the depths
			return encode(r, undefined, [pick(256)]);
		default: {
			const block = encode(r);
			block.bytes[
				block.codesStart + pick(block.bytes.length - block.codesStart)
			] = pick(256);
			return block;
		}
	}
	return encode(r);
}

function parseWith(wasm: boolean, bytes: Uint8Array, maxDepth: number) {
	useWasmChunkDecoder(wasm);
	try {
		return parseChunk(bytes, maxDepth, 0);
	} catch (error) {
		return error as Error;
	} finally {
		useWasmChunkDecoder(true);
	}
}

function decodeCodes(block: Block, maxDepth: number) {
	return decodeChunkCodes(
		block.bytes,
		block.codesStart,
		block.codesLength,
		block.recordCount,
		maxDepth,
		block.paletteCount,
		block.width,
	);
}

test("the committed src/chunkDecoderWasm.ts matches wasm/chunkDecoder.wat", async () => {
	const committed = readFileSync(
		new URL("../src/chunkDecoderWasm.ts", import.meta.url),
		"utf8",
	);
	assert.equal(
		committed,
		await generate(),
		"stale: run npm run build:wasm -w reader",
	);
});

test("Node.js runs the WebAssembly fast path", () => {
	assert.ok(wasmChunkDecoderAvailable());
});

test("the fast path decodes random chunks exactly as the JavaScript parser does", () => {
	const rand = mulberry32(1);
	let big = 0;
	for (let round = 0; round < 300; round++) {
		const maxDepth = 1 + Math.floor(rand() * 16);
		const paletteCount = [0, 1, 200, 255, 256, 70000][round % 6]!;
		const block = encode(randomRecords(rand, maxDepth, paletteCount));
		const js = parseWith(false, block.bytes, maxDepth);
		assert.ok(!(js instanceof Error), `round ${round}: ${js}`);
		assert.deepEqual(parseWith(true, block.bytes, maxDepth), js);
		const codes = decodeCodes(block, maxDepth);
		assert.ok(codes, `round ${round}: a valid block was declined`);
		assert.deepEqual(codes, js.codes);
		if (block.recordCount >= WASM_MIN_RECORDS) big++;
	}
	assert.ok(big > 100, `only ${big} blocks big enough to take the fast path`);
});

test("the fast path declines every block the JavaScript parser rejects", () => {
	const rand = mulberry32(2);
	let rejected = 0;
	for (let round = 0; round < 300; round++) {
		const maxDepth = 2 + Math.floor(rand() * 15);
		const paletteCount = [1, 255, 256, 70000][round % 4]!;
		const records = randomRecords(rand, maxDepth, paletteCount);
		if (records.codes.length < 2) continue;
		for (let m = 0; m < 40; m++) {
			const block = corrupt(rand, records);
			const js = parseWith(false, block.bytes, maxDepth);
			const codes = decodeCodes(block, maxDepth);
			if (js instanceof Error) {
				rejected++;
				assert.equal(codes, undefined, `round ${round}.${m}: ${js.message}`);
			} else if (codes) {
				assert.deepEqual(codes, js.codes, `round ${round}.${m}`);
			}
			// Either way, parseChunk itself answers as the JavaScript parser.
			assert.deepEqual(parseWith(true, block.bytes, maxDepth), js);
		}
	}
	assert.ok(rejected > 5000, `only ${rejected} corrupted blocks rejected`);
});

test("the fast path checks alignment in every byte of a code", () => {
	// A code misaligned only above its low byte can only take the
	// 16-record path as the last of the 16, just before a delta as long
	// as its span: build that for a code misaligned at bit 8, 16 and 24.
	const maxDepth = 16;
	for (const bit of [8, 16, 24]) {
		const target = 2 ** bit;
		const span = 4 * target; // 4^k for k = bit / 2 + 1, so target is off it
		// 16m records of one-byte deltas up to just below the target, so
		// it is record 16m: the last of the block starting at 16m - 15.
		const count = 16 * Math.ceil(((target - 1) / 127 + 1) / 16);
		const sum = target - 1;
		const codes = [0];
		for (let i = 1; i < count; i++) {
			codes.push(Math.floor((sum * i) / (count - 1)));
		}
		codes.push(target, target + span);
		const depths = codes.map(() => maxDepth);
		depths[count] = maxDepth - Math.log2(span) / 2;
		const block = encode({
			maxDepth,
			paletteCount: 1,
			codes,
			depths,
			indices: codes.map(() => 1),
		});
		const js = parseWith(false, block.bytes, maxDepth);
		assert.match(String(js), /not a valid stored code/);
		assert.equal(decodeCodes(block, maxDepth), undefined, `bit ${bit}`);
		// Accepted with that record a finest-level cell instead.
		codes[count] = codes[count - 1]! + 1;
		depths[count] = maxDepth;
		const fixed = encode({
			maxDepth,
			paletteCount: 1,
			codes,
			depths,
			indices: codes.map(() => 1),
		});
		assert.deepEqual(decodeCodes(fixed, maxDepth), Uint32Array.from(codes));
	}
});

test("the fast path holds no WebAssembly memory once idle", async () => {
	const block = encode(randomRecords(mulberry32(3), 10, 200));
	assert.ok(block.recordCount >= WASM_MIN_RECORDS);
	parseChunk(block.bytes, 10, 0);
	assert.ok(wasmChunkDecoderBytes() > 0);
	await sleep(1100);
	assert.equal(wasmChunkDecoderBytes(), 0);
});
