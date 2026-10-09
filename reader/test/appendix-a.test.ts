import assert from "node:assert/strict";
import { test } from "node:test";
import { boundingBoxContains, CGeoDataReader } from "../src/index.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";

test("Appendix A fixture is exactly 157 bytes", () => {
	assert.equal(APPENDIX_A_BYTES.length, 157);
});

// Chunk 3 (row 1, col 1) covers lon [0, 180), lat [0, 90) (Section A.2).
// Bounding boxes below are worked out by hand from the chunk's decoded
// records (Section A.4): codes [0, 4, 5, 8, 12], depths [1, 2, 2, 1, 2].

test("lookup 1: (lat 20, lon 100) resolves to Zaandam, Noord-Holland, Nederland", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const result = await reader.query(20, 100);
	assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
	assert.deepEqual(result.region, ["Noord-Holland"]);
	assert.deepEqual(result.city, ["Zaandam"]);
	// Record (code 4, depth 2): x=2, y=0 at depth 2 -> lon [90, 135), lat [0, 22.5).
	assert.deepEqual(result.boundingBox, {
		minLon: 90,
		maxLon: 135,
		minLat: 0,
		maxLat: 22.5,
	});
	assert.ok(boundingBoxContains(result.boundingBox, 20, 100));
	assert.equal(result.chunkIndex, 3);
});

test("lookup 2: (lat 40, lon 30) resolves to a region-level result (Noord-Holland), city null", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const result = await reader.query(40, 30);
	assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
	assert.deepEqual(result.region, ["Noord-Holland"]);
	assert.equal(result.city, null);
	// Record (code 0, depth 1): x=0, y=0 at depth 1 -> lon [0, 90), lat [0, 45).
	assert.deepEqual(result.boundingBox, {
		minLon: 0,
		maxLon: 90,
		minLat: 0,
		maxLat: 45,
	});
	assert.ok(boundingBoxContains(result.boundingBox, 40, 30));
});

test("lookup 3: (lat 30, lon 100) is unknown (gap between records)", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const result = await reader.query(30, 100);
	assert.deepEqual(result.country, null);
	assert.deepEqual(result.region, null);
	assert.deepEqual(result.city, null);
	// No record covers this point, so the box falls back to the single
	// finest-grain cell (depth 2) containing it: x=2, y=1 -> lon [90, 135),
	// lat [22.5, 45).
	assert.deepEqual(result.boundingBox, {
		minLon: 90,
		maxLon: 135,
		minLat: 22.5,
		maxLat: 45,
	});
	assert.ok(boundingBoxContains(result.boundingBox, 30, 100));
});

test("lookup 4: (lat 20, lon 170) is unknown (palette index 0)", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const result = await reader.query(20, 170);
	assert.deepEqual(result.country, null);
	assert.deepEqual(result.region, null);
	assert.deepEqual(result.city, null);
	// A record *did* match here (code 5, depth 2), it just carries palette
	// index 0 -- so the box is that record's exact cell, not just the
	// finest cell around the query point: x=3, y=0 -> lon [135, 180), lat [0, 22.5).
	assert.deepEqual(result.boundingBox, {
		minLon: 135,
		maxLon: 180,
		minLat: 0,
		maxLat: 22.5,
	});
	assert.ok(boundingBoxContains(result.boundingBox, 20, 170));
});

test("lookup 5: (lat -10, lon 10) is unknown (chunk 1 is empty, no decompression needed)", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const result = await reader.query(-10, 10);
	assert.deepEqual(result.country, null);
	assert.deepEqual(result.region, null);
	assert.deepEqual(result.city, null);
	// Chunk 1 (row 0, col 1) is entirely empty, so the box is the whole
	// chunk: lon [0, 180), lat [-90, 0).
	assert.deepEqual(result.boundingBox, {
		minLon: 0,
		maxLon: 180,
		minLat: -90,
		maxLat: 0,
	});
	assert.ok(boundingBoxContains(result.boundingBox, -10, 10));
	// The chunk index is reported even when the chunk was never decompressed.
	assert.equal(result.chunkIndex, 1);
});

test("header fields match the worked example", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.equal(reader.header.version, 0);
	assert.equal(reader.header.attribution, "OSM");
	assert.equal(reader.header.width, 2);
	assert.equal(reader.header.height, 2);
	assert.equal(reader.header.maxDepth, 2);
	assert.equal(reader.header.keyframeExp, 2);
});
