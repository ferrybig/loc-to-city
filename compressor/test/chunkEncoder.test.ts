import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { parseChunk } from "@ferrybig/cgeodata-reader/format";
import { encodeChunk, gapCells } from "../src/chunkEncoder.ts";

test("gapCells tiles a gap with the fewest aligned cells", () => {
  // max_depth 2: a chunk of 16 codes, a depth-1 cell spans 4.
  assert.deepEqual(gapCells(0, 0, 2), []);
  assert.deepEqual(gapCells(0, 16, 2), [0]);
  assert.deepEqual(gapCells(6, 8, 2), [2, 2]);
  assert.deepEqual(gapCells(1, 16, 2), [2, 2, 2, 1, 1, 1]);
  assert.deepEqual(gapCells(5, 13, 2), [2, 2, 2, 1, 2]);
});

test("encodeChunk fills the gaps between records with index 0, and not the end", () => {
  // Appendix A's chunk 3: Noord-Holland (id 2) and Zaandam (id 5), with
  // codes 5 to 7 and 13 to 15 empty.
  const records = [
    { code: 0, depth: 1, globalId: 2 },
    { code: 4, depth: 2, globalId: 5 },
    { code: 8, depth: 1, globalId: 2 },
    { code: 12, depth: 2, globalId: 5 },
  ];
  const block = inflateSync(encodeChunk(records, 2));
  assert.deepEqual([...block], [2, 2, 3, 7, 1, 2, 2, 2, 2, 1, 2, 1, 2, 0, 0, 0, 1, 2]);
  const chunk = parseChunk(block, 2, 1);
  assert.deepEqual([...chunk.codes], [0, 4, 5, 6, 7, 8, 12]);
  assert.deepEqual([...chunk.paletteIndices], [1, 2, 0, 0, 0, 1, 2]);
});

test("encodeChunk starts with a gap when the first record isn't at code 0", () => {
  const chunk = parseChunk(inflateSync(encodeChunk([{ code: 12, depth: 1, globalId: 7 }], 2)), 2, 1);
  assert.deepEqual([...chunk.codes], [0, 4, 8, 12]);
  assert.deepEqual([...chunk.depths], [1, 1, 1, 1]);
  assert.deepEqual([...chunk.paletteIndices], [0, 0, 0, 1]);
  assert.deepEqual(chunk.palette, [7]);
});
