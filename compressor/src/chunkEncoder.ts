import { deflateSync } from "node:zlib";
import { encodeRangeCodedRecords, writeVarint } from "@ferrybig/cgeodata-reader/format";
import type { ChunkRecord } from "./quadtree.ts";

function paletteIndexWidth(paletteCount: number): number {
  if (paletteCount <= 255) return 1;
  if (paletteCount <= 65535) return 2;
  if (paletteCount <= 2 ** 24 - 1) return 3;
  return 4;
}

/** The format versions the compressor writes: 1 deflates each chunk
 * (Section 8.2), 2 range codes it (Section 8.7). */
export type FormatVersion = 1 | 2;

/** Encodes one chunk's already-sorted records into a block: a deflated one
 * per Section 8.2 for `formatVersion` 1, a range-coded one per Section 8.7
 * for 2. */
export function encodeChunk(records: ChunkRecord[], maxDepth: number, formatVersion: FormatVersion): Buffer {
  // Section 8.3: the palette is strictly increasing, delta-coded -- so the
  // unique referenced ids must be sorted before assigning local indices,
  // not just taken in first-encounter order (records are sorted by code,
  // not by id).
  const palette = [...new Set(records.map((r) => r.globalId))].sort((a, b) => a - b);
  const localIndexByGlobalId = new Map<number, number>();
  palette.forEach((globalId, i) => {
    localIndexByGlobalId.set(globalId, i + 1); // 1-based
  });

  // Section 8.4: records tile the chunk from code 0, a code being where the
  // record before it ends, so the empty cells between records become
  // index-0 records. Past the last record nothing is needed.
  const depths: number[] = [];
  const localIndices: number[] = [];
  let code = 0;
  for (const record of records) {
    for (const depth of gapCells(code, record.code, maxDepth)) {
      depths.push(depth);
      localIndices.push(0);
    }
    depths.push(record.depth);
    localIndices.push(localIndexByGlobalId.get(record.globalId)!);
    code = record.code + 4 ** (maxDepth - record.depth);
  }

  return encodeChunkRecords(palette, depths, localIndices, maxDepth, formatVersion);
}

/** Encodes a chunk block from its palette (sorted global ids) and the
 * depth and local palette index (0..P) of each record, which tile the
 * chunk from code 0 in Morton order (Section 8.4). Also what a transcoder
 * re-encodes a decoded chunk with. */
export function encodeChunkRecords(
  palette: readonly number[],
  depths: ArrayLike<number>,
  localIndices: ArrayLike<number>,
  maxDepth: number,
  formatVersion: FormatVersion,
): Buffer {
  const paletteBytes: Buffer[] = [];
  let previousId = 0;
  for (const globalId of palette) {
    paletteBytes.push(Buffer.from(writeVarint(globalId - previousId)));
    previousId = globalId;
  }
  const head = [
    Buffer.from(writeVarint(palette.length)),
    ...paletteBytes,
    Buffer.from(writeVarint(depths.length)),
  ];
  if (formatVersion === 2) {
    return Buffer.concat([...head, encodeRangeCodedRecords(depths, localIndices, palette.length, maxDepth)]);
  }

  const indexWidth = paletteIndexWidth(palette.length);
  const indicesBuffer = Buffer.alloc(localIndices.length * indexWidth);
  for (let i = 0; i < localIndices.length; i++) {
    for (let b = 0; b < indexWidth; b++) {
      indicesBuffer[i * indexWidth + b] = (localIndices[i]! >>> (8 * b)) & 0xff;
    }
  }

  const inflated = Buffer.concat([...head, Buffer.from(Uint8Array.from(depths)), indicesBuffer]);

  return deflateSync(inflated, { level: 9 });
}

/** The depths of the fewest cells that tile the codes from `start` up to
 * `end`, in order (Section 10): each the largest cell that starts where
 * the one before it ends and doesn't pass `end`. */
export function gapCells(start: number, end: number, maxDepth: number): number[] {
  const depths: number[] = [];
  let code = start;
  while (code < end) {
    let depth = 0;
    while (code % 4 ** (maxDepth - depth) !== 0 || code + 4 ** (maxDepth - depth) > end) depth++;
    depths.push(depth);
    code += 4 ** (maxDepth - depth);
  }
  return depths;
}
