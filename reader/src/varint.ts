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

export function readVarint(buf: Uint8Array, offset: number): VarintResult {
  let value = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const byte = buf[offset + i];
    if (byte === undefined) {
      throw new IncompleteBufferError("varint runs past end of buffer");
    }
    value += (byte & PAYLOAD_MASK) * 2 ** (7 * i);
    if ((byte & CONTINUATION_BIT) === 0) {
      if (value >= MAX_VARINT_VALUE) {
        throw new RangeError("varint value must be less than 2^53");
      }
      if (i > 0 && byte === 0) {
        // A minimal encoder never emits a trailing zero group (see
        // writeVarint below), so this can only be non-minimal padding.
        throw new RangeError("non-minimal varint encoding (trailing zero byte)");
      }
      return { value, bytesRead: i + 1 };
    }
  }
  throw new RangeError("varint longer than 8 bytes");
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
export function readVarintList(buf: Uint8Array, offset: number, count: number): VarintListResult {
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
export function readDeltaVarintList(buf: Uint8Array, offset: number, count: number): VarintListResult {
  const values: number[] = new Array(count);
  let cursor = offset;
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const { value: delta, bytesRead } = readVarint(buf, cursor);
    previous += delta;
    values[i] = previous;
    cursor += bytesRead;
  }
  return { values, bytesRead: cursor - offset };
}
