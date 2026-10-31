import { decodeChunkCodes, WASM_MIN_RECORDS } from "./chunkDecoder.ts";
import { CGeoDataFormatError } from "./errors.ts";
import { decodeRangeCodedRecords } from "./rangeChunk.ts";
import {
	readDeltaVarintList,
	readDeltaVarints32Into,
	readVarint,
} from "./varint.ts";

/** One chunk's records (Section 8), decoded: record `j` is the cell
 * `codes[j]` at depth `depths[j]`, attributed to
 * `palette[paletteIndices[j] - 1]` (or to no place for index 0). */
export interface ChunkRecords {
	/** Global place ids referenced by this chunk, indexed 0..P-1. */
	palette: number[];
	/** Stored Morton codes, chunk-local, strictly increasing. Typed arrays
	 * rather than plain ones for this and the other per-record fields: a
	 * big chunk holds over a million records, and parsing and holding them
	 * as boxed JS arrays costs several times as much. 32 bits, as every
	 * code is below 4^`MAX_SUPPORTED_DEPTH`. */
	codes: Uint32Array;
	/** Each record's depth in the chunk's quadtree, 0 to `max_depth`. */
	depths: Uint8Array;
	/** Local palette index per record: 0 = "no place", k = palette[k-1].
	 * As wide as the file stores them (Section 8.3's S), rounding 3 bytes
	 * up to a `Uint32Array`. */
	paletteIndices: Uint8Array | Uint16Array | Uint32Array;
}

/**
 * The deepest `max_depth` this reader supports, though the format allows
 * up to 26: every code is then below 4^16 = 2^32, so a decoded chunk
 * holds its codes in 32 bits. Deeper files aren't worth reading in
 * place: one chunk is one zlib block that a lookup inflates whole, and
 * at depth 16 a chunk already spans up to 4^16 cells, so a lookup could
 * inflate gigabytes. Finer cells should come from a bigger chunk grid
 * (`width_exp`, `height_exp`) instead (binary-format.md Section 10).
 */
export const MAX_SUPPORTED_DEPTH = 16;

/** The index width S from Section 8.3's table. */
function paletteIndexWidth(paletteCount: number): number {
	if (paletteCount <= 255) return 1;
	if (paletteCount <= 65535) return 2;
	if (paletteCount <= 2 ** 24 - 1) return 3;
	return 4;
}

/** Whether typed arrays here are little-endian, as the file's integers
 * are (true on every mainstream platform), so 2- and 4-byte palette
 * indices can be copied in rather than assembled byte by byte. */
const LITTLE_ENDIAN = new Uint8Array(Uint16Array.of(1).buffer)[0] === 1;

/** `n` unsigned `width`-byte little-endian integers (Section 8.3's
 * palette indices) from `buf` at `offset`, in the narrowest typed array
 * that holds `width` bytes. Always a copy, so the inflated block can be
 * freed. */
function readLittleEndian(
	buf: Uint8Array,
	offset: number,
	width: number,
	n: number,
): Uint8Array | Uint16Array | Uint32Array {
	switch (width) {
		case 1:
			// Not `buf.slice()`: the block is a Buffer, whose `slice` returns
			// a view.
			return new Uint8Array(buf.subarray(offset, offset + n));
		case 2: {
			const out = new Uint16Array(n);
			if (LITTLE_ENDIAN) {
				new Uint8Array(out.buffer).set(buf.subarray(offset, offset + 2 * n));
				return out;
			}
			for (let i = 0, b = offset; i < n; i++, b += 2)
				out[i] = buf[b]! | (buf[b + 1]! << 8);
			return out;
		}
		case 3: {
			const out = new Uint32Array(n);
			for (let i = 0, b = offset; i < n; i++, b += 3) {
				out[i] = buf[b]! | (buf[b + 1]! << 8) | (buf[b + 2]! << 16);
			}
			return out;
		}
		default: {
			const out = new Uint32Array(n);
			if (LITTLE_ENDIAN) {
				new Uint8Array(out.buffer).set(buf.subarray(offset, offset + 4 * n));
				return out;
			}
			for (let i = 0, b = offset; i < n; i++, b += 4) {
				out[i] =
					buf[b]! |
					(buf[b + 1]! << 8) |
					(buf[b + 2]! << 16) |
					(buf[b + 3]! << 24);
			}
			return out;
		}
	}
}

/** Whether the power of two `span` divides `value`, both below 2^53: a
 * bitwise check while they fit in 31 bits (max_depth 15 and under), else
 * a double modulo, which is exact but several times slower. */
function isMultipleOf(value: number, span: number): boolean {
	return value < 0x80000000 ? (value & (span - 1)) === 0 : value % span === 0;
}

/** Parses one chunk block: already inflated for a `version` 0 or 1 file
 * (Section 8.2, or Section 8.6's layout for `version` 0), as stored for
 * `version` 2, whose blocks are not zlib streams (Section 8.7). It checks the cheap Section 8.5
 * invariants a reader can verify without external context (place ids
 * are validated by the caller, which has the place table). */
export function parseChunk(
	buf: Uint8Array,
	maxDepth: number,
	version: number,
): ChunkRecords {
	if (maxDepth > MAX_SUPPORTED_DEPTH) {
		throw new RangeError(
			`max_depth ${maxDepth} is past the ${MAX_SUPPORTED_DEPTH} this reader supports`,
		);
	}
	let offset = 0;
	const { value: paletteCount, bytesRead: b1 } = readVarint(buf, offset);
	offset += b1;
	const { values: palette, bytesRead: b2 } = readDeltaVarintList(
		buf,
		offset,
		paletteCount,
	);
	offset += b2;

	const { value: recordCount, bytesRead: b3 } = readVarint(buf, offset);
	offset += b3;
	if (version >= 2) {
		return {
			palette,
			...decodeRangeCodedRecords(
				buf,
				offset,
				paletteCount,
				recordCount,
				maxDepth,
			),
		};
	}
	if (version !== 0) {
		return parseRecords(buf, offset, palette, recordCount, maxDepth);
	}
	const { value: codesLength, bytesRead: b4 } = readVarint(buf, offset);
	offset += b4;

	// Every code takes at least one byte, so a count the block can't hold
	// fails here instead of allocating for it.
	if (offset + recordCount > buf.length) {
		throw new CGeoDataFormatError("chunk codes run past end of block");
	}
	const codesStart = offset;
	const indexWidth = paletteIndexWidth(paletteCount);
	const depthsStart = codesStart + codesLength;
	if (
		recordCount >= WASM_MIN_RECORDS &&
		paletteCount < 2 ** 32 &&
		depthsStart + recordCount * (1 + indexWidth) === buf.length
	) {
		// The fast path (./chunkDecoder.ts) for a block whose size adds up;
		// a declined block falls through to be parsed below.
		const codes = decodeChunkCodes(
			buf,
			codesStart,
			codesLength,
			recordCount,
			maxDepth,
			paletteCount,
			indexWidth,
		);
		if (codes) {
			return {
				palette,
				codes,
				depths: new Uint8Array(
					buf.subarray(depthsStart, depthsStart + recordCount),
				),
				paletteIndices: readLittleEndian(
					buf,
					depthsStart + recordCount,
					indexWidth,
					recordCount,
				),
			};
		}
	}

	const codes = new Uint32Array(recordCount);
	const codesBytesRead =
		readDeltaVarints32Into(buf, codesStart, codes) - codesStart;
	if (codesBytesRead !== codesLength) {
		throw new CGeoDataFormatError(
			`chunk codes_length mismatch: header says ${codesLength}, decoding consumed ${codesBytesRead}`,
		);
	}
	offset = codesStart + codesLength;

	if (offset + recordCount > buf.length) {
		throw new CGeoDataFormatError("chunk depths array runs past end of block");
	}
	// A copy, not a view, so the inflated block can be freed. Not
	// `buf.slice()`: the block is a Buffer, whose `slice` returns a view.
	const depths = new Uint8Array(buf.subarray(offset, offset + recordCount));
	offset += recordCount;

	const indicesBytes = recordCount * indexWidth;
	if (offset + indicesBytes > buf.length) {
		throw new CGeoDataFormatError(
			"chunk palette_indices array runs past end of block",
		);
	}
	const paletteIndices = readLittleEndian(buf, offset, indexWidth, recordCount);
	offset += indicesBytes;

	if (offset !== buf.length) {
		throw new CGeoDataFormatError(
			"chunk block has trailing bytes after palette_indices",
		);
	}

	// span[d]: how many max-depth cells a depth-d record covers, 4^(D-d).
	// A stored code is valid for depth d exactly when its low 2 x (D-d) bits
	// are zero, i.e. when span[d] divides it -- exact in doubles, since codes
	// and spans are both below 2^53.
	const span: number[] = [];
	for (let d = 0; d <= maxDepth; d++) span.push(4 ** (maxDepth - d));
	const maxCode = 4 ** maxDepth;
	for (let j = 0; j < recordCount; j++) {
		const depth = depths[j]!;
		const code = codes[j]!;
		if (depth > maxDepth) {
			throw new CGeoDataFormatError(
				`record ${j} has depth ${depth} > max_depth ${maxDepth}`,
			);
		}
		if (!isMultipleOf(code, span[depth]!)) {
			throw new CGeoDataFormatError(
				`record ${j}'s code is not a valid stored code for depth ${depth}`,
			);
		}
		if (code >= maxCode) {
			throw new CGeoDataFormatError(
				`record ${j}'s code ${code} is not less than 4^max_depth`,
			);
		}
		if (paletteIndices[j]! > paletteCount) {
			throw new CGeoDataFormatError(
				`record ${j} has palette index ${paletteIndices[j]} > P (${paletteCount})`,
			);
		}
		if (j > 0) {
			const prevCode = codes[j - 1]!;
			if (!(prevCode < code)) {
				throw new CGeoDataFormatError(
					`chunk codes are not strictly increasing at record ${j}`,
				);
			}
			if (prevCode + span[depths[j - 1]!]! > code) {
				throw new CGeoDataFormatError(`record ${j - 1} overlaps record ${j}`);
			}
		}
	}

	return { palette, codes, depths, paletteIndices };
}

/** The rest of a chunk block from its `depths` on (Section 8.2): the
 * records tile the chunk from code 0, so each code is where the record
 * before it ends (Section 8.4). */
function parseRecords(
	buf: Uint8Array,
	offset: number,
	palette: number[],
	recordCount: number,
	maxDepth: number,
): ChunkRecords {
	const paletteCount = palette.length;
	const indexWidth = paletteIndexWidth(paletteCount);
	const end = offset + recordCount * (1 + indexWidth);
	if (end > buf.length) {
		throw new CGeoDataFormatError(
			"chunk depths and palette_indices run past end of block",
		);
	}
	if (end !== buf.length) {
		throw new CGeoDataFormatError(
			"chunk block has trailing bytes after palette_indices",
		);
	}
	// A copy, not a view, so the inflated block can be freed. Not
	// `buf.slice()`: the block is a Buffer, whose `slice` returns a view.
	const depths = new Uint8Array(buf.subarray(offset, offset + recordCount));
	const paletteIndices = readLittleEndian(
		buf,
		offset + recordCount,
		indexWidth,
		recordCount,
	);

	const codes = new Uint32Array(recordCount);
	if (!deriveCodes(depths, maxDepth, codes)) {
		throw recordError(depths, maxDepth);
	}
	let maxIndex = 0;
	for (let j = 0; j < recordCount; j++) {
		const k = paletteIndices[j]!;
		if (k > maxIndex) maxIndex = k;
	}
	if (maxIndex > paletteCount) {
		const j = paletteIndices.findIndex((k) => k > paletteCount);
		throw new CGeoDataFormatError(
			`record ${j} has palette index ${paletteIndices[j]} > P (${paletteCount})`,
		);
	}
	return { palette, codes, depths, paletteIndices };
}

/** Fills `codes` with each record's code (Section 8.4), or returns false
 * when a record breaks invariant 1, 2 or 3 of Section 8.5, for
 * `recordError` to say which. In integers while every code and span fits
 * in 31 bits (max_depth 15 and under), else in doubles. */
function deriveCodes(
	depths: Uint8Array,
	maxDepth: number,
	codes: Uint32Array,
): boolean {
	const n = depths.length;
	// span[d]: how many max-depth cells a depth-d record covers, 4^(D-d);
	// 0 past max_depth.
	if (maxDepth <= 15) {
		const span = new Int32Array(256);
		for (let d = 0; d <= maxDepth; d++) span[d] = 1 << (2 * (maxDepth - d));
		const maxCode = 1 << (2 * maxDepth);
		let code = 0;
		for (let j = 0; j < n; j++) {
			const size = span[depths[j]!]!;
			if (size === 0 || (code & (size - 1)) !== 0 || code >= maxCode) {
				return false;
			}
			codes[j] = code;
			code += size;
		}
		return code <= maxCode;
	}
	const span = new Float64Array(256);
	for (let d = 0; d <= maxDepth; d++) span[d] = 4 ** (maxDepth - d);
	const maxCode = 4 ** maxDepth;
	let code = 0;
	for (let j = 0; j < n; j++) {
		const size = span[depths[j]!]!;
		if (size === 0 || code % size !== 0 || code >= maxCode) return false;
		codes[j] = code;
		code += size;
	}
	return code <= maxCode;
}

/** The error for the first record `deriveCodes` refused. */
function recordError(depths: Uint8Array, maxDepth: number): Error {
	const maxCode = 4 ** maxDepth;
	let code = 0;
	for (let j = 0; j < depths.length; j++) {
		const depth = depths[j]!;
		if (depth > maxDepth) {
			return new CGeoDataFormatError(
				`record ${j} has depth ${depth} > max_depth ${maxDepth}`,
			);
		}
		if (code >= maxCode) {
			return new CGeoDataFormatError(
				`record ${j} starts past the end of the chunk`,
			);
		}
		const size = 4 ** (maxDepth - depth);
		if (code % size !== 0) {
			return new CGeoDataFormatError(
				`record ${j} at code ${code} is not aligned to its depth ${depth}`,
			);
		}
		code += size;
	}
	return new CGeoDataFormatError(
		`record ${depths.length - 1} runs past the end of the chunk`,
	);
}
