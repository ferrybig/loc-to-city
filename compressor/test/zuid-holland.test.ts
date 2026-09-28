import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CGeoDataReader,
  openSource,
  readHeaderAndDirectory,
  parsePlaceTable,
  resolveIdentifier,
  readNameEntry,
  type QueryResult,
} from "@loc-to-city/reader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "../../data/03-final/zuid-holland.bin");

// This dataset is produced by `data-ingest/src/prepare-zuid-holland.ts`
// followed by the compressor CLI (see README for the exact command).
// Skip gracefully rather than failing if it hasn't been built yet.
const skip = !existsSync(BIN_PATH);

// boundingBox varies with exact geometry, so it isn't a useful thing to
// hardcode in most of these tests -- just check the three place fields.
function assertUnknown(result: QueryResult): void {
  assert.deepEqual(
    { country: result.country, region: result.region, city: result.city },
    { country: null, region: null, city: null },
  );
}

test("zuid-holland.bin: structural facts (1 country, 12 regions, 187 cities)", { skip }, () => {
  const source = openSource(BIN_PATH);
  const { header, directory } = readHeaderAndDirectory(source);
  const placeTable = parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  assert.equal(placeTable.countryCount, 1);
  assert.equal(placeTable.totalRegions, 12);
  assert.equal(placeTable.totalCities, 187);
  assert.equal(placeTable.totalPlaces, 1 + 12 + 187);

  assert.deepEqual(readNameEntry(source, placeTable, 0), ["Nederland", "The Netherlands"]);
});

test("zuid-holland.bin: Zuid-Holland has all 187 cities, the other 11 provinces have 0", { skip }, () => {
  const source = openSource(BIN_PATH);
  const { header, directory } = readHeaderAndDirectory(source);
  const placeTable = parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  let zuidHollandCityCount: number | undefined;
  let regionsWithZeroCities = 0;
  for (let r = 0; r < placeTable.totalRegions; r++) {
    const count = placeTable.cityRegionPrefix[r + 1]! - placeTable.cityRegionPrefix[r]!;
    const globalId = placeTable.countryCount + r;
    const [name] = readNameEntry(source, placeTable, globalId);
    if (name === "Zuid-Holland") zuidHollandCityCount = count;
    else if (count === 0) regionsWithZeroCities++;
  }

  assert.equal(zuidHollandCityCount, 187);
  assert.equal(regionsWithZeroCities, 11);
});

test("zuid-holland.bin: a resolved city's ancestor chain classifies correctly", { skip }, () => {
  const reader = CGeoDataReader.open(BIN_PATH);
  // Den Haag city hall, well inside its own boundary.
  const result = reader.query(52.0799, 4.3113);
  assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
  assert.deepEqual(result.region, ["Zuid-Holland"]);
  assert.ok(result.city, "expected a city-level result near Den Haag's city hall");
});

test("zuid-holland.bin: a point in Utrecht (no city data) still resolves to its region and country", { skip }, () => {
  // Regression test: the compressor used to only index city geometry, so
  // any point outside Zuid-Holland's 187 cities resolved to fully unknown
  // even when it was inside a real, named province. Utrecht has 0 cities
  // in this dataset (see the test above) but does have its own polygon.
  const reader = CGeoDataReader.open(BIN_PATH);
  const result = reader.query(52.146973, 5.465698);
  assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
  assert.deepEqual(result.region, ["Utrecht"]);
  assert.equal(result.city, null);
});

test("zuid-holland.bin: outside the Netherlands entirely is unknown", { skip }, () => {
  const reader = CGeoDataReader.open(BIN_PATH);
  assertUnknown(reader.query(53.5, 3.5)); // North Sea
  assertUnknown(reader.query(51.2, 4.4)); // Belgium
});
