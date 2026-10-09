/**
 * varint (LEB128) codec, per binary-format.md Section 3.2, plus the
 * delta-coded list helper from Section 3.3.
 */

/** Thrown when a parser ran out of bytes because the given buffer was too
 * short to hold the full structure -- distinct from a genuine format error,
 * so callers can retry with a larger read. */
export class IncompleteBufferError extends RangeError {}

const CONTINUATION_BIT = 0x80;
const PAYLOAD_MASK = 0x7f;
const MAX_VARINT_BYTES = 8;
// Section 3.2: every varint MUST be less than 2^53, so it round-trips
// exactly through an IEEE 754 double.
const MAX_VARINT_VALUE = 2 ** 53;

export interface VarintResult {
	value: number;
	bytesRead: number;
}

/** Scratch output for `readVarint`, so a single read allocates nothing
 * beyond its result. */
const single = new Float64Array(1);

export function readVarint(buf: Uint8Array, offset: number): VarintResult {
	const end = readDeltaVarintsInto(buf, offset, single);
	return { value: single[0]!, bytesRead: end - offset };
}

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

export interface VarintListResult {
	values: number[];
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

/**
 * `out.length` delta-coded varints (Section 3.3) from `buf` at `offset`
 * into `out`, returning the offset just past them. The one varint decoder
 * here: `readVarint` is a list of one (whose previous element is the
 * implicit 0), so every varint the reader reads gets the same checks.
 * Decodes inline into a typed array because a chunk's codes are millions
 * of varints, and an object per varint showed up as most of a chunk's
 * parse time.
 */
export function readDeltaVarintsInto(
	buf: Uint8Array,
	offset: number,
	out: Float64Array,
): number {
	let cursor = offset;
	let previous = 0;
	for (let i = 0; i < out.length; i++) {
		let byte = buf[cursor++];
		if (byte === undefined)
			throw new IncompleteBufferError("varint runs past end of buffer");
		let value = byte & PAYLOAD_MASK;
		let scale = 128;
		for (let n = 1; byte & CONTINUATION_BIT; n++) {
			if (n === MAX_VARINT_BYTES)
				throw new RangeError(`varint longer than ${MAX_VARINT_BYTES} bytes`);
			byte = buf[cursor++];
			if (byte === undefined)
				throw new IncompleteBufferError("varint runs past end of buffer");
			value += (byte & PAYLOAD_MASK) * scale;
			if ((byte & CONTINUATION_BIT) === 0) {
				if (value >= MAX_VARINT_VALUE) {
					throw new RangeError("varint value must be less than 2^53");
				}
				if (byte === 0) {
					// A minimal encoder never emits a trailing zero group (see
					// writeVarint above), so this can only be non-minimal padding.
					throw new RangeError(
						"non-minimal varint encoding (trailing zero byte)",
					);
				}
			}
			scale *= 128;
		}
		previous += value;
		out[i] = previous;
	}
	return cursor;
}
