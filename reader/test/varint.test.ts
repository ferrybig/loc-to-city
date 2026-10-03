import { test } from "node:test";
import assert from "node:assert/strict";
import { readVarint, writeVarint } from "../src/index.ts";

// Section 3.2 worked examples: 0 -> 00; 127 -> 7f; 128 -> 80 01;
// 300 -> ac 02; 8192 -> 80 40.
const CASES: Array<[number, number[]]> = [
  [0, [0x00]],
  [127, [0x7f]],
  [128, [0x80, 0x01]],
  [300, [0xac, 0x02]],
  [8192, [0x80, 0x40]],
];

for (const [value, bytes] of CASES) {
  test(`writeVarint(${value}) === ${bytes.map((b) => b.toString(16)).join(" ")}`, () => {
    assert.deepEqual(Array.from(writeVarint(value)), bytes);
  });

  test(`readVarint decodes ${bytes.map((b) => b.toString(16)).join(" ")} to ${value}`, () => {
    const result = readVarint(Uint8Array.from(bytes), 0);
    assert.equal(result.value, value);
    assert.equal(result.bytesRead, bytes.length);
  });
}

test("readVarint rejects a varint longer than 8 bytes", () => {
  const buf = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]);
  assert.throws(() => readVarint(buf, 0), RangeError);
});

test("readVarint rejects a non-minimal encoding", () => {
  // 0 encoded as two bytes instead of one.
  const buf = Uint8Array.from([0x80, 0x00]);
  assert.throws(() => readVarint(buf, 0), RangeError);
});

test("writeVarint rejects values >= 2^53", () => {
  assert.throws(() => writeVarint(2 ** 53), RangeError);
});
