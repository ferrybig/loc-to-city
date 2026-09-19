import { test } from "node:test";
import assert from "node:assert/strict";
import { CGeoDataReader } from "../src/index.js";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

test("Appendix A fixture is exactly 157 bytes", () => {
  assert.equal(APPENDIX_A_BYTES.length, 157);
});

test("lookup 1: (lat 20, lon 100) resolves to Zaandam, Noord-Holland, Nederland", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  const result = reader.query(20, 100);
  assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
  assert.deepEqual(result.region, ["Noord-Holland"]);
  assert.deepEqual(result.city, ["Zaandam"]);
});

test("lookup 2: (lat 40, lon 30) resolves to a region-level result (Noord-Holland), city null", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  const result = reader.query(40, 30);
  assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
  assert.deepEqual(result.region, ["Noord-Holland"]);
  assert.equal(result.city, null);
});

test("lookup 3: (lat 30, lon 100) is unknown (gap between records)", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  const result = reader.query(30, 100);
  assert.deepEqual(result, { country: null, region: null, city: null });
});

test("lookup 4: (lat 20, lon 170) is unknown (palette index 0)", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  const result = reader.query(20, 170);
  assert.deepEqual(result, { country: null, region: null, city: null });
});

test("lookup 5: (lat -10, lon 10) is unknown (chunk 1 is empty, no decompression needed)", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  const result = reader.query(-10, 10);
  assert.deepEqual(result, { country: null, region: null, city: null });
});

test("header fields match the worked example", () => {
  const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
  assert.equal(reader.header.version, 0);
  assert.equal(reader.header.attribution, "OSM");
  assert.equal(reader.header.width, 2);
  assert.equal(reader.header.height, 2);
  assert.equal(reader.header.maxDepth, 2);
  assert.equal(reader.header.keyframeExp, 2);
});
