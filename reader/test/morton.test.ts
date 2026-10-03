import { test } from "node:test";
import assert from "node:assert/strict";
import { mortonEncode, mortonDecode, shiftRight, lowBits } from "../src/index.ts";

// Section 8.1's D=2 worked example:
//  y=3 | 10  11  14  15
//  y=2 |  8   9  12  13
//  y=1 |  2   3   6   7
//  y=0 |  0   1   4   5
//      +----------------
//        x=0 x=1 x=2 x=3
const EXPECTED_D2: number[][] = [
  [0, 1, 4, 5],
  [2, 3, 6, 7],
  [8, 9, 12, 13],
  [10, 11, 14, 15],
];

test("mortonEncode matches the D=2 worked example", () => {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      assert.equal(mortonEncode(x, y, 2), EXPECTED_D2[y]![x], `x=${x} y=${y}`);
    }
  }
});

test("mortonDecode inverts mortonEncode for D=2", () => {
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const code = mortonEncode(x, y, 2);
      assert.deepEqual(mortonDecode(code, 2), { x, y });
    }
  }
});

test("mortonEncode/mortonDecode round-trip at max_depth = 26 (52-bit codes)", () => {
  const depth = 26;
  const cases: Array<[number, number]> = [
    [0, 0],
    [(2 ** depth) - 1, (2 ** depth) - 1],
    [12345678, 65432100], // both < 2^26 - 1 = 67108863, the max coordinate at depth 26
    [1, 0],
    [0, 1],
  ];
  for (const [x, y] of cases) {
    const code = mortonEncode(x, y, depth);
    assert.ok(code < 2 ** 52, "code must fit in 52 bits");
    assert.deepEqual(mortonDecode(code, depth), { x, y }, `x=${x} y=${y}`);
  }
});

test("shiftRight and lowBits are safe beyond 32 bits", () => {
  const value = 2 ** 50 + 2 ** 3 + 1;
  assert.equal(shiftRight(value, 50), 1);
  assert.equal(lowBits(value, 4), 2 ** 3 + 1);
});
