import { test } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection, Polygon } from "geojson";
import {
  CGeoDataReader,
  openSource,
  readHeaderAndDirectory,
  parsePlaceTable,
  resolveIdentifier,
  readNameEntry,
} from "@loc-to-city/reader";
import { buildCGeoDataFile } from "../src/build.ts";
import type { HierarchyCountry } from "../src/hierarchy.ts";
import { assembleNameEntry, type CityProperties } from "../src/placeIds.ts";

// A tiny synthetic dataset: one country, two regions (only one of which has
// cities -- Section 7.2 explicitly allows a region's city count to be 0),
// and two adjacent, non-overlapping 1x1 degree city squares. This exercises
// full-containment leaves (well inside each square), ambiguous-cell
// resolution at max_depth (right along the shared border, where neither
// square fully contains the cell), and the empty-region path -- all without
// touching real OSM data.
const hierarchy: HierarchyCountry[] = [{ code: "TL", name: "Testland", regions: ["Alpha", "Beta"] }];

const cities: FeatureCollection<Polygon, CityProperties> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "springfield", name: "Springfield", region: "Alpha", country: "TL" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { id: "shelbyville", name: "Shelbyville", region: "Alpha", country: "TL" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [1, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 0],
          ],
        ],
      },
    },
  ],
};

const options = { attribution: "test fixture", widthExp: 0, heightExp: 0, maxDepth: 10, keyframeExp: 0 };

test("well inside Springfield resolves to Springfield / Alpha / Testland", () => {
  const { bytes } = buildCGeoDataFile(hierarchy, cities, options);
  const reader = CGeoDataReader.open(bytes);
  const result = reader.query(0.5, 0.25);
  assert.deepEqual(result.country, ["Testland"]);
  assert.deepEqual(result.region, ["Alpha"]);
  assert.deepEqual(result.city, ["Springfield"]);
});

test("well inside Shelbyville resolves to Shelbyville", () => {
  const { bytes } = buildCGeoDataFile(hierarchy, cities, options);
  const reader = CGeoDataReader.open(bytes);
  const result = reader.query(0.5, 1.75);
  assert.deepEqual(result.city, ["Shelbyville"]);
});

test("far from either square resolves to unknown", () => {
  const { bytes } = buildCGeoDataFile(hierarchy, cities, options);
  const reader = CGeoDataReader.open(bytes);
  const result = reader.query(50, 50);
  assert.deepEqual(
    { country: result.country, region: result.region, city: result.city },
    { country: null, region: null, city: null },
  );
});

test("a cell straddling the shared border still resolves to exactly one city", () => {
  const { bytes } = buildCGeoDataFile(hierarchy, cities, options);
  const reader = CGeoDataReader.open(bytes);
  // Right on the shared edge: neither square fully contains a cell here at
  // any depth, so this only succeeds if max-depth area-share resolution
  // picks a winner instead of leaving a gap.
  const result = reader.query(0.5, 1.0 - 1e-9);
  assert.ok(result.city?.[0] === "Springfield" || result.city?.[0] === "Shelbyville", `got ${result.city}`);
});

test("Beta (0 cities) is still present and resolvable by name", () => {
  const { bytes, stats } = buildCGeoDataFile(hierarchy, cities, options);
  assert.equal(stats.countryCount, 1);
  assert.equal(stats.regionCount, 2);
  assert.equal(stats.cityCount, 2);

  const source = openSource(bytes);
  const { header, directory } = readHeaderAndDirectory(source);
  const placeTable = parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  // Beta is region index 1 (Alpha is 0), global id = countryCount + 1 = 2.
  const resolved = resolveIdentifier(placeTable, 2);
  assert.deepEqual(resolved, { level: "region", countryId: 0, regionId: 1 });
  assert.deepEqual(readNameEntry(source, placeTable, 2), ["Beta"]);

  const betaCityCount = placeTable.cityRegionPrefix[2]! - placeTable.cityRegionPrefix[1]!;
  assert.equal(betaCityCount, 0);
});

test("assembleNameEntry", () => {
  assert.equal(assembleNameEntry("Nederland", "The Netherlands"), "Nederland|The Netherlands");
  assert.equal(assembleNameEntry("Amsterdam", undefined), "Amsterdam");
  // Writers SHOULD omit trailing empty fields (Section 7.4) -- an
  // international name identical to the local one carries no information.
  assert.equal(assembleNameEntry("Berlin", "Berlin"), "Berlin");
  // Section 7.4: fields must not contain "|" or NUL, and there's no escape
  // mechanism -- an international name that would violate that is dropped
  // rather than corrupting the wire format.
  assert.equal(assembleNameEntry("Local", "Bad|Name"), "Local");
  assert.equal(assembleNameEntry("Local", "Bad\0Name"), "Local");
});

test("a region's international name doesn't affect the region/city join, only its displayed name entry", () => {
  // Alpha's join key (used to match Springfield/Shelbyville) stays the
  // plain local "Alpha" throughout ingest -- regionNames only adds a
  // display-time international name, keyed by that same local name
  // (README.md's "International/local name pairs" item).
  const intlHierarchy: HierarchyCountry[] = [
    {
      code: "TL",
      name: "Testland",
      regions: ["Alpha", "Beta"],
      regionNames: { Alpha: "Alpha Province" },
    },
  ];
  const intlCities: FeatureCollection<Polygon, CityProperties> = {
    type: "FeatureCollection",
    features: cities.features.map((f) => ({
      ...f,
      properties: f.properties.name === "Springfield" ? { ...f.properties, nameEn: "Springfield City" } : f.properties,
    })),
  };

  const { bytes } = buildCGeoDataFile(intlHierarchy, intlCities, options);
  const reader = CGeoDataReader.open(bytes);

  // The join still resolves correctly -- Springfield is still found inside
  // Alpha despite both having gained an unrelated international name. The
  // reader returns the full split name array (local first, then
  // international), not just the local name.
  const result = reader.query(0.5, 0.25);
  assert.deepEqual(result.country, ["Testland"]);
  assert.deepEqual(result.region, ["Alpha", "Alpha Province"]);
  assert.deepEqual(result.city, ["Springfield", "Springfield City"]);

  const source = openSource(bytes);
  const { header, directory } = readHeaderAndDirectory(source);
  const placeTable = parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  // Alpha/Beta are region global ids 1/2 (after country id 0). Cities are
  // sorted by id within a region (placeIds.ts), and "shelbyville" sorts
  // before "springfield", so Shelbyville is city id 3, Springfield id 4.
  assert.deepEqual(readNameEntry(source, placeTable, 1), ["Alpha", "Alpha Province"]);
  assert.deepEqual(readNameEntry(source, placeTable, 2), ["Beta"]);
  assert.deepEqual(readNameEntry(source, placeTable, 3), ["Shelbyville"]);
  assert.deepEqual(readNameEntry(source, placeTable, 4), ["Springfield", "Springfield City"]);
});
