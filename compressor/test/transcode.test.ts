import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CGeoDataReader } from "@ferrybig/cgeodata-reader";
import { compareChunks, transcode } from "../src/transcode.ts";

const APPENDIX_A = readFileSync(new URL("../../data/03-final/appendix-a-example.bin", import.meta.url));

test("transcode writes Appendix A.6's version 2 file, and back", async () => {
  const v2 = transcode(APPENDIX_A, 2);
  assert.equal(v2.length, 142);
  assert.deepEqual([...v2.subarray(-11)], [0x02, 0x02, 0x03, 0x07, 0x00, 0xa5, 0x11, 0x64, 0xba, 0x00, 0x00]);
  compareChunks(APPENDIX_A, v2);
  const reader = await CGeoDataReader.open(new Uint8Array(v2));
  assert.equal((await reader.query(20, 100)).city?.localName, "Zaandam");
  // zlib at level 9 is deterministic, so back to version 1 is the original.
  assert.deepEqual(transcode(v2, 1), APPENDIX_A);
});
