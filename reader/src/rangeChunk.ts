import type { ChunkRecords } from "./chunk.ts";
import { CGeoDataFormatError } from "./errors.ts";
import { decodeRangeCodedWasm } from "./rangeDecoder.ts";

/**
 * A version 2 chunk's records (binary-format.md Section 8.7): the
 * quadtree's split flags and each leaf's palette index, coded with an
 * adaptive binary range coder whose contexts come from the west and south
 * neighbours of each node. This is the JavaScript decoder, the one that
 * reports errors; `rangeDecoder.ts`'s WebAssembly one only accepts or
 * declines, and a declined block is decoded again here.
 */

/** A chunk's records as `decodeRangeCodedRecords` decodes them: all of
 * `ChunkRecords` but the palette, which precedes the stream. */
export type RangeCodedRecords = Omit<ChunkRecords, "palette">;

/** Probabilities are 12-bit: the chance of a 0, out of 4096. */
const PROB_BITS = 12;
const PROB_INIT = 2048;
/** How fast a probability adapts: it moves 1/16 of the way each time. */
const ADAPT_SHIFT = 4;
const TOP = 2 ** 24;

/** Context table sizes (Section 8.7.3). */
export const SPLIT_CONTEXTS = 16 * 16;
export const VALUE_CONTEXTS = 17 * 8 * 4;
export const RANK_LENGTH_CONTEXTS = 4 * 32;
export const RANK_BIT_CONTEXTS = 32 * 32;

/** A version 2 chunk's palette_count is below this, so a palette index
 * and a depth fit in one 32-bit integer together. */
export const MAX_PALETTE_COUNT = 2 ** 26;

/** At most this many records per byte of coded stream: every leaf takes at
 * least one binary decision, which costs at least log2(4096 / 4081) bits,
 * so 2048 records per byte can't be reached by any stream. Checked before
 * allocating for `record_count`. */
export const MAX_RECORDS_PER_BYTE = 2048;

/** Section 8.7.2's neighbour category: 0 when there is no neighbour, else
 * how much deeper than `d` its record is (1: not deeper, 2: one level, 3:
 * more). `tag` is the neighbour's `index << 5 | depth`, or -1. */
function category(tag: number, d: number): number {
	if (tag < 0) return 0;
	const e = tag & 31;
	return e <= d ? 1 : e === d + 1 ? 2 : 3;
}

class RangeDecoder {
	private range = 0xffffffff;
	private code = 0;
	pos: number;
	private readonly buf: Uint8Array;
	readonly end: number;

	constructor(buf: Uint8Array, start: number, end: number) {
		this.buf = buf;
		this.end = end;
		if (end - start < 5) {
			throw new CGeoDataFormatError(
				"chunk range-coded stream is shorter than 5 bytes",
			);
		}
		if (buf[start] !== 0) {
			throw new CGeoDataFormatError(
				"chunk range-coded stream does not start with a 0 byte",
			);
		}
		let code = 0;
		for (let i = 1; i <= 4; i++) code = code * 256 + buf[start + i]!;
		if (code === 0xffffffff) {
			throw new CGeoDataFormatError(
				"chunk range-coded stream starts with code 0xffffffff",
			);
		}
		this.code = code;
		this.pos = start + 5;
	}

	bit(probs: Uint16Array, i: number): number {
		const p = probs[i]!;
		const bound = (this.range >>> PROB_BITS) * p;
		let b: number;
		if (this.code < bound) {
			this.range = bound;
			probs[i] = p + (((1 << PROB_BITS) - p) >> ADAPT_SHIFT);
			b = 0;
		} else {
			this.code -= bound;
			this.range -= bound;
			probs[i] = p - (p >> ADAPT_SHIFT);
			b = 1;
		}
		while (this.range < TOP) {
			if (this.pos >= this.end) {
				throw new CGeoDataFormatError(
					"chunk range-coded stream runs past end of block",
				);
			}
			this.range *= 256;
			this.code = this.code * 256 + this.buf[this.pos++]!;
		}
		return b;
	}
}

/** The narrowest typed array for palette indices up to `paletteCount`
 * (Section 8.3's S, with 3 bytes rounded up to 4). */
export function paletteIndexArray(
	paletteCount: number,
	n: number,
): Uint8Array | Uint16Array | Uint32Array {
	if (paletteCount <= 255) return new Uint8Array(n);
	if (paletteCount <= 65535) return new Uint16Array(n);
	return new Uint32Array(n);
}

/**
 * Decodes the records of a version 2 chunk from `buf[offset..]`, the
 * range-coded stream that follows `record_count` and runs to the end of
 * the block. Throws a `CGeoDataFormatError` for anything Section 8.7
 * rejects.
 */
export function decodeRangeCodedRecords(
	buf: Uint8Array,
	offset: number,
	paletteCount: number,
	recordCount: number,
	maxDepth: number,
): RangeCodedRecords {
	if (paletteCount >= MAX_PALETTE_COUNT) {
		throw new CGeoDataFormatError(
			`chunk palette_count ${paletteCount} is 2^26 or more, past what a version 2 chunk allows`,
		);
	}
	checkRecordCount(recordCount, maxDepth, buf.length - offset);
	const fast = decodeRangeCodedWasm(
		buf,
		offset,
		paletteCount,
		recordCount,
		maxDepth,
	);
	if (fast) return fast;
	const rc = new RangeDecoder(buf, offset, buf.length);
	const D = maxDepth;
	const N = 2 ** D;
	const split = new Uint16Array(SPLIT_CONTEXTS).fill(PROB_INIT);
	const eqW = new Uint16Array(VALUE_CONTEXTS).fill(PROB_INIT);
	const eqS = new Uint16Array(VALUE_CONTEXTS).fill(PROB_INIT);
	const rankLength = new Uint16Array(RANK_LENGTH_CONTEXTS).fill(PROB_INIT);
	const rankBits = new Uint16Array(RANK_BIT_CONTEXTS).fill(PROB_INIT);
	// row[y] / col[x]: the last record decoded in row y / column x, as
	// `index << 5 | depth`; in Morton order that is the cell west of /
	// south of the next one to be decoded there.
	const row = new Int32Array(N).fill(-1);
	const col = new Int32Array(N).fill(-1);
	// Move-to-front list of palette indices 0..P.
	const mtf = new Int32Array(paletteCount + 1);
	for (let k = 0; k <= paletteCount; k++) mtf[k] = k;

	const codes = new Uint32Array(recordCount);
	const depths = new Uint8Array(recordCount);
	const paletteIndices = paletteIndexArray(paletteCount, recordCount);

	// Pending nodes, popped in pre-order: at most 3 per level plus one.
	const stackD = new Int32Array(4 * (D + 1));
	const stackX = new Int32Array(4 * (D + 1));
	const stackY = new Int32Array(4 * (D + 1));
	let sp = 1;
	let j = 0;
	let prev = -1;
	let code = 0;
	while (j < recordCount) {
		if (sp === 0) {
			throw new CGeoDataFormatError(
				`chunk record_count ${recordCount} is more than the ${j} records its quadtree has`,
			);
		}
		sp--;
		const d = stackD[sp]!;
		const x = stackX[sp]!;
		const y = stackY[sp]!;
		const w = x > 0 ? row[y]! : -1;
		const s = y > 0 ? col[x]! : -1;
		const wc = category(w, d);
		if (d < D && rc.bit(split, d * 16 + wc * 4 + category(s, d)) === 1) {
			const h = 2 ** (D - d - 1);
			const d1 = d + 1;
			// Pushed in reverse, so the south-west child pops first.
			stackD[sp] = d1;
			stackX[sp] = x + h;
			stackY[sp] = y + h;
			sp++;
			stackD[sp] = d1;
			stackX[sp] = x;
			stackY[sp] = y + h;
			sp++;
			stackD[sp] = d1;
			stackX[sp] = x + h;
			stackY[sp] = y;
			sp++;
			stackD[sp] = d1;
			stackX[sp] = x;
			stackY[sp] = y;
			sp++;
			continue;
		}
		const wv = w < 0 ? -1 : w >>> 5;
		const sv = s < 0 ? -1 : s >>> 5;
		const c =
			(d * 8 +
				(wv === sv ? 4 : 0) +
				(prev === wv ? 2 : 0) +
				(prev === sv ? 1 : 0)) *
				4 +
			wc;
		let v = -1;
		let p = 0;
		if (wv >= 0 && rc.bit(eqW, c) === 1) v = wv;
		else if (sv >= 0 && sv !== wv && rc.bit(eqS, c) === 1) v = sv;
		if (v < 0) {
			const cc = (wv >= 0 ? 32 : 0) + (sv >= 0 ? 64 : 0);
			let nb = 0;
			while (rc.bit(rankLength, cc + nb) === 1) {
				if (++nb === 32) {
					throw new CGeoDataFormatError(
						`chunk record ${j}'s palette rank is 2^32 or more`,
					);
				}
			}
			let value = 1;
			for (let k = nb - 1; k >= 0; k--) {
				value = value * 2 + rc.bit(rankBits, nb * 32 + k);
			}
			let rank = value - 1;
			for (; ; p++) {
				if (p > paletteCount) {
					throw new CGeoDataFormatError(
						`chunk record ${j}'s palette rank ${value - 1} is past the palette`,
					);
				}
				const t = mtf[p]!;
				if (t === wv || t === sv) continue;
				if (rank === 0) break;
				rank--;
			}
			v = mtf[p]!;
		} else {
			while (mtf[p] !== v) p++;
		}
		for (let k = p; k > 0; k--) mtf[k] = mtf[k - 1]!;
		mtf[0] = v;
		const size = 2 ** (D - d);
		const tag = v * 32 + d;
		row.fill(tag, y, y + size);
		col.fill(tag, x, x + size);
		codes[j] = code;
		depths[j] = d;
		paletteIndices[j] = v;
		code += size * size;
		prev = v;
		j++;
	}
	if (rc.pos !== rc.end) {
		throw new CGeoDataFormatError(
			`chunk block has ${rc.end - rc.pos} trailing bytes after its range-coded stream`,
		);
	}
	return { codes, depths, paletteIndices };
}

/** Section 8.7.5's bounds on `record_count`, checked before allocating
 * for it: at most one record per cell, and at most `MAX_RECORDS_PER_BYTE`
 * per byte of stream. */
export function checkRecordCount(
	recordCount: number,
	maxDepth: number,
	streamBytes: number,
): void {
	if (recordCount > 4 ** maxDepth) {
		throw new CGeoDataFormatError(
			`chunk record_count ${recordCount} is more than the 4^${maxDepth} cells of a chunk`,
		);
	}
	if (recordCount > MAX_RECORDS_PER_BYTE * Math.max(streamBytes, 0)) {
		throw new CGeoDataFormatError(
			`chunk record_count ${recordCount} is more than a ${streamBytes}-byte stream can code`,
		);
	}
}

class RangeEncoder {
	private low = 0;
	private range = 0xffffffff;
	private cache = 0;
	private cacheSize = 1;
	private out: number[] = [];

	bit(probs: Uint16Array, i: number, b: number): void {
		const p = probs[i]!;
		const bound = (this.range >>> PROB_BITS) * p;
		if (b === 0) {
			this.range = bound;
			probs[i] = p + (((1 << PROB_BITS) - p) >> ADAPT_SHIFT);
		} else {
			this.low += bound;
			this.range -= bound;
			probs[i] = p - (p >> ADAPT_SHIFT);
		}
		while (this.range < TOP) {
			this.range *= 256;
			this.shiftLow();
		}
	}

	/** Emits the top byte of `low`, holding back runs of 0xff until a
	 * carry out of them is ruled out (LZMA's encoder). */
	private shiftLow(): void {
		if (this.low < 0xff000000 || this.low >= 0x100000000) {
			const carry = this.low >= 0x100000000 ? 1 : 0;
			let c = this.cache;
			do {
				this.out.push((c + carry) & 0xff);
				c = 0xff;
			} while (--this.cacheSize !== 0);
			this.cache = Math.floor(this.low / 0x1000000) & 0xff;
		}
		this.cacheSize++;
		this.low = (this.low % 0x1000000) * 256;
	}

	finish(): Uint8Array {
		for (let i = 0; i < 5; i++) this.shiftLow();
		return Uint8Array.from(this.out);
	}
}

/**
 * Encodes records that tile a chunk from code 0 (Section 8.4) as Section
 * 8.7's range-coded stream: `depths[j]` and `paletteIndices[j]` (0..P)
 * per record, in Morton order. The inverse of `decodeRangeCodedRecords`.
 * Throws a RangeError for records that don't tile the chunk.
 */
export function encodeRangeCodedRecords(
	depths: ArrayLike<number>,
	paletteIndices: ArrayLike<number>,
	paletteCount: number,
	maxDepth: number,
): Uint8Array {
	if (paletteCount >= MAX_PALETTE_COUNT) {
		throw new RangeError(
			`palette_count ${paletteCount} is 2^26 or more, past what a version 2 chunk allows`,
		);
	}
	const rc = new RangeEncoder();
	const D = maxDepth;
	const N = 2 ** D;
	const recordCount = depths.length;
	const split = new Uint16Array(SPLIT_CONTEXTS).fill(PROB_INIT);
	const eqW = new Uint16Array(VALUE_CONTEXTS).fill(PROB_INIT);
	const eqS = new Uint16Array(VALUE_CONTEXTS).fill(PROB_INIT);
	const rankLength = new Uint16Array(RANK_LENGTH_CONTEXTS).fill(PROB_INIT);
	const rankBits = new Uint16Array(RANK_BIT_CONTEXTS).fill(PROB_INIT);
	const row = new Int32Array(N).fill(-1);
	const col = new Int32Array(N).fill(-1);
	const mtf = new Int32Array(paletteCount + 1);
	for (let k = 0; k <= paletteCount; k++) mtf[k] = k;

	const stackD = new Int32Array(4 * (D + 1));
	const stackX = new Int32Array(4 * (D + 1));
	const stackY = new Int32Array(4 * (D + 1));
	let sp = 1;
	let j = 0;
	let prev = -1;
	while (j < recordCount) {
		if (sp === 0) throw new RangeError("records run past the end of the chunk");
		sp--;
		const d = stackD[sp]!;
		const x = stackX[sp]!;
		const y = stackY[sp]!;
		const depth = depths[j]!;
		if (depth < d || depth > D) {
			throw new RangeError(
				`record ${j} at depth ${depth} doesn't tile the chunk`,
			);
		}
		const w = x > 0 ? row[y]! : -1;
		const s = y > 0 ? col[x]! : -1;
		const wc = category(w, d);
		if (d < D) {
			const splits = depth > d ? 1 : 0;
			rc.bit(split, d * 16 + wc * 4 + category(s, d), splits);
			if (splits) {
				const h = 2 ** (D - d - 1);
				const d1 = d + 1;
				stackD[sp] = d1;
				stackX[sp] = x + h;
				stackY[sp] = y + h;
				sp++;
				stackD[sp] = d1;
				stackX[sp] = x;
				stackY[sp] = y + h;
				sp++;
				stackD[sp] = d1;
				stackX[sp] = x + h;
				stackY[sp] = y;
				sp++;
				stackD[sp] = d1;
				stackX[sp] = x;
				stackY[sp] = y;
				sp++;
				continue;
			}
		}
		const v = paletteIndices[j]!;
		if (!(v >= 0 && v <= paletteCount)) {
			throw new RangeError(
				`record ${j}'s palette index ${v} is past P (${paletteCount})`,
			);
		}
		const wv = w < 0 ? -1 : w >>> 5;
		const sv = s < 0 ? -1 : s >>> 5;
		const c =
			(d * 8 +
				(wv === sv ? 4 : 0) +
				(prev === wv ? 2 : 0) +
				(prev === sv ? 1 : 0)) *
				4 +
			wc;
		let coded = false;
		if (wv >= 0) {
			rc.bit(eqW, c, v === wv ? 1 : 0);
			coded = v === wv;
		}
		if (!coded && sv >= 0 && sv !== wv) {
			rc.bit(eqS, c, v === sv ? 1 : 0);
			coded = v === sv;
		}
		let p = 0;
		while (mtf[p] !== v) p++;
		if (!coded) {
			let rank = 0;
			for (let k = 0; k < p; k++) if (mtf[k] !== wv && mtf[k] !== sv) rank++;
			const value = rank + 1;
			const nb = 31 - Math.clz32(value);
			const cc = (wv >= 0 ? 32 : 0) + (sv >= 0 ? 64 : 0);
			for (let k = 0; k < nb; k++) rc.bit(rankLength, cc + k, 1);
			rc.bit(rankLength, cc + nb, 0);
			for (let k = nb - 1; k >= 0; k--)
				rc.bit(rankBits, nb * 32 + k, (value >>> k) & 1);
		}
		for (let k = p; k > 0; k--) mtf[k] = mtf[k - 1]!;
		mtf[0] = v;
		const size = 2 ** (D - d);
		const tag = v * 32 + d;
		row.fill(tag, y, y + size);
		col.fill(tag, x, x + size);
		prev = v;
		j++;
	}
	return rc.finish();
}
