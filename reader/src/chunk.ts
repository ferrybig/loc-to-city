import { readVarint, readDeltaVarintList } from "./varint.js";
import { lowBits } from "./morton.js";

export interface ChunkRecords {
  /** Global place ids referenced by this chunk, indexed 0..P-1. */
  palette: number[];
  /** Stored Morton codes, chunk-local, strictly increasing. */
  codes: number[];
  depths: number[];
  /** Local palette index per record: 0 = "no place", k = palette[k-1]. */
  paletteIndices: number[];
}

/** The index width S from Section 8.3's table. */
function paletteIndexWidth(paletteCount: number): number {
  if (paletteCount <= 255) return 1;
  if (paletteCount <= 65535) return 2;
  if (paletteCount <= 2 ** 24 - 1) return 3;
  return 4;
}

/** Parses one already-inflated chunk block (Section 8.2) and checks the
 * cheap Section 8.5 invariants a reader can verify without external
 * context (place ids are validated by the caller, which has the place
 * table). */
export function parseChunk(buf: Uint8Array, maxDepth: number): ChunkRecords {
  let offset = 0;
  const { value: paletteCount, bytesRead: b1 } = readVarint(buf, offset);
  offset += b1;
  const { values: palette, bytesRead: b2 } = readDeltaVarintList(buf, offset, paletteCount);
  offset += b2;

  const { value: recordCount, bytesRead: b3 } = readVarint(buf, offset);
  offset += b3;
  const { value: codesLength, bytesRead: b4 } = readVarint(buf, offset);
  offset += b4;

  const codesStart = offset;
  const { values: codes, bytesRead: codesBytesRead } = readDeltaVarintList(buf, codesStart, recordCount);
  if (codesBytesRead !== codesLength) {
    throw new Error(
      `chunk codes_length mismatch: header says ${codesLength}, decoding consumed ${codesBytesRead}`,
    );
  }
  offset = codesStart + codesLength;

  if (offset + recordCount > buf.length) {
    throw new RangeError("chunk depths array runs past end of block");
  }
  const depths = Array.from(buf.subarray(offset, offset + recordCount));
  offset += recordCount;

  const indexWidth = paletteIndexWidth(paletteCount);
  const indicesBytes = recordCount * indexWidth;
  if (offset + indicesBytes > buf.length) {
    throw new RangeError("chunk palette_indices array runs past end of block");
  }
  const paletteIndices: number[] = new Array(recordCount);
  for (let i = 0; i < recordCount; i++) {
    const base = offset + i * indexWidth;
    let value = 0;
    for (let b = indexWidth - 1; b >= 0; b--) {
      value = value * 256 + buf[base + b]!;
    }
    paletteIndices[i] = value;
  }
  offset += indicesBytes;

  if (offset !== buf.length) {
    throw new Error("chunk block has trailing bytes after palette_indices");
  }

  const maxCode = 4 ** maxDepth;
  for (let j = 0; j < recordCount; j++) {
    const depth = depths[j]!;
    const code = codes[j]!;
    if (depth > maxDepth) {
      throw new Error(`record ${j} has depth ${depth} > max_depth ${maxDepth}`);
    }
    if (lowBits(code, 2 * (maxDepth - depth)) !== 0) {
      throw new Error(`record ${j}'s code is not a valid stored code for depth ${depth}`);
    }
    if (code >= maxCode) {
      throw new Error(`record ${j}'s code ${code} is not less than 4^max_depth`);
    }
    if (paletteIndices[j]! > paletteCount) {
      throw new Error(`record ${j} has palette index ${paletteIndices[j]} > P (${paletteCount})`);
    }
    if (j > 0) {
      const prevDepth = depths[j - 1]!;
      const prevCode = codes[j - 1]!;
      if (!(prevCode < code)) {
        throw new Error(`chunk codes are not strictly increasing at record ${j}`);
      }
      const span = 4 ** (maxDepth - prevDepth);
      if (prevCode + span > code) {
        throw new Error(`record ${j - 1} overlaps record ${j}`);
      }
    }
  }

  return { palette, codes, depths, paletteIndices };
}
