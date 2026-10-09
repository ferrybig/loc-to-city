import { CGeoDataFormatError } from "./errors.ts";
import {
	readDeltaVarintList,
	readDeltaVarintsInto,
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
	 * as boxed JS arrays costs several times as much. */
	codes: Float64Array;
	/** Each record's depth in the chunk's quadtree, 0 to `max_depth`. */
	depths: Uint8Array;
	/** Local palette index per record: 0 = "no place", k = palette[k-1]. */
	paletteIndices: Uint32Array;
}

/** The index width S from Section 8.3's table. */
function paletteIndexWidth(paletteCount: number): number {
	if (paletteCount <= 255) return 1;
	if (paletteCount <= 65535) return 2;
	if (paletteCount <= 2 ** 24 - 1) return 3;
	return 4;
}

/** `out.length` unsigned `width`-byte little-endian integers (Section
 * 8.3's palette indices) from `buf` at `offset` into `out`. */
function readLittleEndianInto(
	buf: Uint8Array,
	offset: number,
	width: number,
	out: Uint32Array,
): Uint32Array {
	const n = out.length;
	switch (width) {
		case 1:
			out.set(buf.subarray(offset, offset + n));
			break;
		case 2:
			for (let i = 0, b = offset; i < n; i++, b += 2)
				out[i] = buf[b]! | (buf[b + 1]! << 8);
			break;
		case 3:
			for (let i = 0, b = offset; i < n; i++, b += 3) {
				out[i] = buf[b]! | (buf[b + 1]! << 8) | (buf[b + 2]! << 16);
			}
			break;
		default:
			for (let i = 0, b = offset; i < n; i++, b += 4) {
				out[i] =
					buf[b]! |
					(buf[b + 1]! << 8) |
					(buf[b + 2]! << 16) |
					(buf[b + 3]! << 24);
			}
	}
	return out;
}

/** Whether the power of two `span` divides `value`, both below 2^53: a
 * bitwise check while they fit in 31 bits (max_depth 15 and under), else
 * a double modulo, which is exact but several times slower. */
function isMultipleOf(value: number, span: number): boolean {
	return value < 0x80000000 ? (value & (span - 1)) === 0 : value % span === 0;
}

/** Parses one already-inflated chunk block (Section 8.2) and checks the
 * cheap Section 8.5 invariants a reader can verify without external
 * context (place ids are validated by the caller, which has the place
 * table). */
export function parseChunk(buf: Uint8Array, maxDepth: number): ChunkRecords {
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
	const { value: codesLength, bytesRead: b4 } = readVarint(buf, offset);
	offset += b4;

	// Every code takes at least one byte, so a count the block can't hold
	// fails here instead of allocating for it.
	if (offset + recordCount > buf.length) {
		throw new CGeoDataFormatError("chunk codes run past end of block");
	}
	const codesStart = offset;
	const codes = new Float64Array(recordCount);
	const codesBytesRead =
		readDeltaVarintsInto(buf, codesStart, codes) - codesStart;
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

	const indexWidth = paletteIndexWidth(paletteCount);
	const indicesBytes = recordCount * indexWidth;
	if (offset + indicesBytes > buf.length) {
		throw new CGeoDataFormatError(
			"chunk palette_indices array runs past end of block",
		);
	}
	const paletteIndices = readLittleEndianInto(
		buf,
		offset,
		indexWidth,
		new Uint32Array(recordCount),
	);
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
