import { deflateSync } from "node:zlib";
import { writeVarint } from "@loc-to-city/reader/format";
import type { ChunkRecord } from "./quadtree.ts";

function paletteIndexWidth(paletteCount: number): number {
  if (paletteCount <= 255) return 1;
  if (paletteCount <= 65535) return 2;
  if (paletteCount <= 2 ** 24 - 1) return 3;
  return 4;
}

/** Encodes one chunk's already-sorted records into a deflated block per
 * Section 8.2. */
export function encodeChunk(records: ChunkRecord[]): Buffer {
  // Section 8.3: the palette is strictly increasing, delta-coded -- so the
  // unique referenced ids must be sorted before assigning local indices,
  // not just taken in first-encounter order (records are sorted by code,
  // not by id).
  const palette = [...new Set(records.map((r) => r.globalId))].sort((a, b) => a - b);
  const localIndexByGlobalId = new Map<number, number>();
  palette.forEach((globalId, i) => {
    localIndexByGlobalId.set(globalId, i + 1); // 1-based
  });

  const paletteBytes: Buffer[] = [];
  let previousId = 0;
  for (const globalId of palette) {
    paletteBytes.push(Buffer.from(writeVarint(globalId - previousId)));
    previousId = globalId;
  }

  const codeBytes: Buffer[] = [];
  let previousCode = 0;
  for (const record of records) {
    codeBytes.push(Buffer.from(writeVarint(record.code - previousCode)));
    previousCode = record.code;
  }
  const codesBuffer = Buffer.concat(codeBytes);

  const depthsBuffer = Buffer.from(records.map((r) => r.depth));

  const indexWidth = paletteIndexWidth(palette.length);
  const indicesBuffer = Buffer.alloc(records.length * indexWidth);
  for (let i = 0; i < records.length; i++) {
    const localIndex = localIndexByGlobalId.get(records[i]!.globalId)!;
    for (let b = 0; b < indexWidth; b++) {
      indicesBuffer[i * indexWidth + b] = (localIndex >>> (8 * b)) & 0xff;
    }
  }

  const inflated = Buffer.concat([
    Buffer.from(writeVarint(palette.length)),
    ...paletteBytes,
    Buffer.from(writeVarint(records.length)),
    Buffer.from(writeVarint(codesBuffer.length)),
    codesBuffer,
    depthsBuffer,
    indicesBuffer,
  ]);

  return deflateSync(inflated, { level: 9 });
}
