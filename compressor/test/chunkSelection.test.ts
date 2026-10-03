import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { openSource, readHeaderAndDirectory, parsePlaceTable, readNameEntry, resolveIdentifier } from "@loc-to-city/reader";
import { parseChunkSelection } from "../src/chunkSelection.ts";
import { buildCGeoDataFile } from "../src/build.ts";
import { buildCGeoDataFileParallel } from "../src/buildParallel.ts";
import type { HierarchyCountry } from "../src/hierarchy.ts";
import type { CityProperties } from "../src/placeIds.ts";

test("parseChunkSelection: single index, list, and inclusive ranges", () => {
  assert.deepEqual([...parseChunkSelection("200")], [200]);
  assert.deepEqual([...parseChunkSelection("3,1,2")], [3, 1, 2]);
  assert.deepEqual([...parseChunkSelection("10-13")], [10, 11, 12, 13]);
  assert.deepEqual([...parseChunkSelection("200,300-302")], [200, 300, 301, 302]);
  // A range endpoint is inclusive on both sides, and a single-value range
  // is the same as naming the index.
  assert.deepEqual([...parseChunkSelection("7-7")], [7]);
  // Overlapping entries collapse -- it's a set, not a list.
  assert.deepEqual([...parseChunkSelection("5,4-6")], [5, 4, 6]);
  assert.deepEqual([...parseChunkSelection("  200 , 300-301 ")], [200, 300, 301]);
});

test("parseChunkSelection: the empty string selects nothing (dictionary-only build)", () => {
  assert.equal(parseChunkSelection("").size, 0);
  assert.equal(parseChunkSelection("   ").size, 0);
});

test("parseChunkSelection: rejects malformed specs instead of silently selecting nothing", () => {
  assert.throws(() => parseChunkSelection("abc"), /not a chunk index or range/);
  assert.throws(() => parseChunkSelection("-5"), /not a chunk index or range/);
  assert.throws(() => parseChunkSelection("1.5"), /not a chunk index or range/);
  assert.throws(() => parseChunkSelection("200,,300"), /empty entry/);
  assert.throws(() => parseChunkSelection("500-300"), /starts after it ends/);
});

// Same 4x4-grid fixture shape as parallel.test.ts: "Twins" is a MultiPolygon
// with one square in chunk 10 (col 2, row 2) and another in chunk 15 (col 3,
// row 3), so a selection can keep one and drop the other.
const hierarchy: HierarchyCountry[] = [{ code: "PL", name: "Parallelland", regions: ["Zone"] }];

const cities: FeatureCollection<Polygon | MultiPolygon, CityProperties> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "twins", name: "Twins", region: "Zone", country: "PL" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [10, 10],
              [11, 10],
              [11, 11],
              [10, 11],
              [10, 10],
            ],
          ],
          [
            [
              [100, 50],
              [101, 50],
              [101, 51],
              [100, 51],
              [100, 50],
            ],
          ],
        ],
      },
    },
  ],
};

const options = {
  attribution: "chunk selection fixture",
  widthExp: 2,
  heightExp: 2,
  maxDepth: 6,
  keyframeExp: 0,
};

const CHUNK_SQUARE_1 = 10;
const CHUNK_SQUARE_2 = 15;

test("onlyChunks builds just the selected chunk and leaves the other empty", () => {
  const all = buildCGeoDataFile(hierarchy, cities, options);
  const one = buildCGeoDataFile(hierarchy, cities, { ...options, onlyChunks: new Set([CHUNK_SQUARE_1]) });

  const allDir = readHeaderAndDirectory(openSource(all.bytes)).directory;
  const oneDir = readHeaderAndDirectory(openSource(one.bytes)).directory;

  // Both squares are real chunks in a full build...
  assert.ok(allDir.chunkLengths[CHUNK_SQUARE_1]! > 0);
  assert.ok(allDir.chunkLengths[CHUNK_SQUARE_2]! > 0);

  // ...but only the selected one survives, byte-for-byte unchanged.
  assert.deepEqual(oneDir.chunkLengths[CHUNK_SQUARE_1], allDir.chunkLengths[CHUNK_SQUARE_1]);
  assert.equal(oneDir.chunkLengths[CHUNK_SQUARE_2], 0);
  assert.equal(one.stats.nonEmptyChunkCount, 1);
  assert.equal(all.stats.nonEmptyChunkCount, 2);
});

test("an empty onlyChunks still writes a complete, readable place table", () => {
  const { bytes, stats } = buildCGeoDataFile(hierarchy, cities, { ...options, onlyChunks: new Set() });

  assert.equal(stats.nonEmptyChunkCount, 0);
  assert.equal(stats.totalRecords, 0);
  // The hierarchy is untouched by the flag -- that's the whole point of a
  // dictionary-only build.
  assert.equal(stats.countryCount, 1);
  assert.equal(stats.regionCount, 1);
  assert.equal(stats.cityCount, 1);

  const source = openSource(bytes);
  const { header, directory } = readHeaderAndDirectory(source);
  assert.ok(directory.chunkLengths.every((length) => length === 0), "every chunk should be empty");

  const placeTable = parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);
  assert.deepEqual(readNameEntry(source, placeTable, 0), ["Parallelland"]);
  assert.deepEqual(readNameEntry(source, placeTable, 1), ["Zone"]);
  assert.deepEqual(readNameEntry(source, placeTable, 2), ["Twins"]);
  assert.deepEqual(resolveIdentifier(placeTable, 2), { level: "city", countryId: 0, regionId: 0, cityId: 0 });
});

test("onlyChunks is byte-identical between the sequential and worker-pool paths", async () => {
  for (const selection of [new Set<number>(), new Set([CHUNK_SQUARE_1]), new Set([CHUNK_SQUARE_1, CHUNK_SQUARE_2])]) {
    const sequential = buildCGeoDataFile(hierarchy, cities, { ...options, onlyChunks: selection });
    const parallel = await buildCGeoDataFileParallel(hierarchy, cities, { ...options, onlyChunks: selection, workers: 4 });
    assert.ok(
      parallel.bytes.equals(sequential.bytes),
      `workers=4 differed from the sequential build for selection {${[...selection].join(",")}}`,
    );
    assert.deepEqual(parallel.stats, sequential.stats);
  }
});
