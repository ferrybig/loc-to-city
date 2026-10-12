import { CGeoDataFormatError } from "./errors.ts";

/**
 * varint (LEB128) codec, per binary-format.md Section 3.2, plus the
 * delta-coded list helper from Section 3.3.
 */

/** Thrown when a parser ran out of bytes because the given buffer was too
 * short to hold the full structure -- distinct from a genuine format error,
 * so callers can retry with a larger read. */
export class IncompleteBufferError extends CGeoDataFormatError {
	override name = "IncompleteBufferError";
}

const CONTINUATION_BIT = 0x80;
const PAYLOAD_MASK = 0x7f;
const MAX_VARINT_BYTES = 8;
// Section 3.2: every varint MUST be less than 2^53, so it round-trips
// exactly through an IEEE 754 double.
const MAX_VARINT_VALUE = 2 ** 53;

/** One decoded varint. */
export interface VarintResult {
	/** The value, below 2^53. */
	value: number;
	/** How many bytes it took (1-8). */
	bytesRead: number;
}

/** The varint (Section 3.2) at `offset`; throws a `CGeoDataFormatError`
 * for a malformed one, an `IncompleteBufferError` for a cut-off one. */
export function readVarint(buf: Uint8Array, offset: number): VarintResult {
	const value = varintAt(buf, offset);
	return { value, bytesRead: varintEnd - offset };
}

/** `value`'s minimal varint encoding (Section 3.2). */
export function writeVarint(value: number): Uint8Array {
	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError("varint value must be a non-negative integer");
	}
	if (value >= MAX_VARINT_VALUE) {
		throw new RangeError("varint value must be less than 2^53");
	}
	const bytes: number[] = [];
	let remaining = value;
	do {
		let byte = remaining % 128;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) byte |= CONTINUATION_BIT;
		bytes.push(byte);
	} while (remaining > 0);
	return Uint8Array.from(bytes);
}

/** A decoded list of varints. */
export interface VarintListResult {
	/** The values, in order. */
	values: number[];
	/** How many bytes the whole list took. */
	bytesRead: number;
}

/** A plain list of `count` varints (not delta-coded) -- used for
 * region_counts, city_counts, chunk_lengths, and block_lengths. */
export function readVarintList(
	buf: Uint8Array,
	offset: number,
	count: number,
): VarintListResult {
	const values: number[] = new Array(count);
	let cursor = offset;
	for (let i = 0; i < count; i++) {
		const { value, bytesRead } = readVarint(buf, cursor);
		values[i] = value;
		cursor += bytesRead;
	}
	return { values, bytesRead: cursor - offset };
}

/** A delta-coded list per Section 3.3 -- used for a chunk's palette and
 * codes. Each stored varint is the difference from the previous element,
 * with an implicit previous element of 0 before the first. */
export function readDeltaVarintList(
	buf: Uint8Array,
	offset: number,
	count: number,
): VarintListResult {
	const values = new Float64Array(count);
	const end = readDeltaVarintsInto(buf, offset, values);
	return { values: Array.from(values), bytesRead: end - offset };
}

/** Where the varint `varintAt` last read ended: a second return value,
 * kept here rather than in a returned object because a chunk's codes are
 * millions of varints, and an object per varint showed up as most of a
 * chunk's parse time. */
let varintEnd = 0;

/**
 * The varint at `cursor`, leaving the offset just past it in
 * `varintEnd`. The one varint decoder here, so every varint the reader
 * reads gets the same checks.
 */
function varintAt(buf: Uint8Array, cursor: number): number {
	let byte = buf[cursor++];
	if (byte === undefined)
		throw new IncompleteBufferError("varint runs past end of buffer");
	let value = byte & PAYLOAD_MASK;
	let scale = 128;
	for (let n = 1; byte & CONTINUATION_BIT; n++) {
		if (n === MAX_VARINT_BYTES)
			throw new CGeoDataFormatError(
				`varint longer than ${MAX_VARINT_BYTES} bytes`,
			);
		byte = buf[cursor++];
		if (byte === undefined)
			throw new IncompleteBufferError("varint runs past end of buffer");
		value += (byte & PAYLOAD_MASK) * scale;
		if ((byte & CONTINUATION_BIT) === 0) {
			if (value >= MAX_VARINT_VALUE) {
				throw new CGeoDataFormatError("varint value must be less than 2^53");
			}
			if (byte === 0) {
				// A minimal encoder never emits a trailing zero group (see
				// writeVarint above), so this can only be non-minimal padding.
				throw new CGeoDataFormatError(
					"non-minimal varint encoding (trailing zero byte)",
				);
			}
		}
		scale *= 128;
	}
	varintEnd = cursor;
	return value;
}

/**
 * `out.length` delta-coded varints (Section 3.3) from `buf` at `offset`
 * into `out`, returning the offset just past them. Decodes straight into
 * a typed array, without an object per varint (see `varintEnd`).
 */
export function readDeltaVarintsInto(
	buf: Uint8Array,
	offset: number,
	out: Float64Array,
): number {
	let cursor = offset;
	let previous = 0;
	for (let i = 0; i < out.length; i++) {
		previous += varintAt(buf, cursor);
		cursor = varintEnd;
		out[i] = previous;
	}
	return cursor;
}

/**
 * `readDeltaVarintsInto` for values known to fit in 32 bits, such as a
 * chunk's codes at `max_depth` 16 and under: a running total that
 * outgrows the `Uint32Array` is a format error, not a silent wraparound.
 * A separate function rather than one taking either array, because V8
 * optimizes a loop for the array types its function has seen, and a
 * loop that has seen both decoded chunks ~10% slower.
 */
export function readDeltaVarints32Into(
	buf: Uint8Array,
	offset: number,
	out: Uint32Array,
): number {
	let cursor = offset;
	let previous = 0;
	for (let i = 0; i < out.length; i++) {
		previous += varintAt(buf, cursor);
		cursor = varintEnd;
		if (previous > 0xffffffff) {
			throw new CGeoDataFormatError(
				`delta-coded value ${previous} does not fit in 32 bits`,
			);
		}
		out[i] = previous;
	}
	return cursor;
}
