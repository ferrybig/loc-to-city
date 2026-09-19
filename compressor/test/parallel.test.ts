import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { openSource, readHeaderAndDirectory } from "@loc-to-city/reader";
import { buildCGeoDataFileParallel } from "../src/buildParallel.js";
import type { HierarchyCountry } from "../src/hierarchy.js";
import type { CityProperties } from "../src/placeIds.js";

// A multi-chunk fixture, unlike build.test.ts's single-chunk one (that one
// can't exercise chunk dispatch/collection at all). width_exp = height_exp
// = 2 gives a 4x4 grid, 90deg lon x 45deg lat per chunk, columns at lon
// -180/-90/0/90/180 and rows at lat -90/-45/0/45/90.
//
// One city, "Twins", is a MultiPolygon with two small squares far apart:
// one at (10,10)-(11,11) (chunk col 2, row 2 -> index 10) and one at
// (100,50)-(101,51) (chunk col 3, row 3 -> index 15). Its combined bbox
// spans lon [10,101] x lat [10,51], which also overlaps chunk (col 3, row
// 2 -> index 11) and (col 2, row 3 -> index 14) -- neither of which
// contains any actual part of the MultiPolygon. Those two chunks are
// exactly the "bbox-non-empty, record-empty" case: a job gets created
// (the candidate's bbox overlaps), but `touches()` is false everywhere in
// that chunk, so it must produce zero records and stay `null` in the
// final file, not an empty-but-present compressed block.
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
  attribution: "parallel test fixture",
  widthExp: 2,
  heightExp: 2,
  maxDepth: 6,
  keyframeExp: 0,
};

const CHUNK_INDEX_SQUARE_1 = 10; // col 2, row 2
const CHUNK_INDEX_SQUARE_2 = 15; // col 3, row 3
const CHUNK_INDEX_BBOX_ONLY_A = 11; // col 3, row 2: bbox overlaps, no real area
const CHUNK_INDEX_BBOX_ONLY_B = 14; // col 2, row 3: bbox overlaps, no real area

test("bbox-only chunks stay empty (null), not a zero-record block", async () => {
  const { bytes } = await buildCGeoDataFileParallel(hierarchy, cities, { ...options, workers: 4 });
  const source = openSource(bytes);
  const { directory } = readHeaderAndDirectory(source);

  assert.ok(directory.chunkLengths[CHUNK_INDEX_SQUARE_1]! > 0, "square 1's chunk should have real records");
  assert.ok(directory.chunkLengths[CHUNK_INDEX_SQUARE_2]! > 0, "square 2's chunk should have real records");
  assert.equal(directory.chunkLengths[CHUNK_INDEX_BBOX_ONLY_A], 0, "bbox-only chunk A must stay empty");
  assert.equal(directory.chunkLengths[CHUNK_INDEX_BBOX_ONLY_B], 0, "bbox-only chunk B must stay empty");
});

test("output is byte-identical across worker counts (0, 1, 2, 3, 16)", async () => {
  const baseline = await buildCGeoDataFileParallel(hierarchy, cities, { ...options, workers: 0 });

  for (const workers of [1, 2, 3, 16]) {
    const result = await buildCGeoDataFileParallel(hierarchy, cities, { ...options, workers });
    assert.ok(result.bytes.equals(baseline.bytes), `workers=${workers} produced different bytes than workers=0`);
    assert.deepEqual(result.stats, baseline.stats, `workers=${workers} produced different stats than workers=0`);
  }
});

test("a worker pool cleans up and rejects on a malformed candidate geometry", async () => {
  const poisonCities: FeatureCollection<Polygon | MultiPolygon, CityProperties> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "poison", name: "Poison", region: "Zone", country: "PL" },
        // Not a valid ring (only two points) -- turf's boolean predicates
        // should throw on this rather than silently misbehave.
        geometry: {
          type: "Polygon",
          coordinates: [[[10, 10], [11, 11]]],
        } as unknown as Polygon,
      },
    ],
  };

  await assert.rejects(() => buildCGeoDataFileParallel(hierarchy, poisonCities, { ...options, workers: 2 }));
});
