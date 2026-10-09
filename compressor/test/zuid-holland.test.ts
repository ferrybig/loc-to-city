import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CGeoDataReader,
  readHeaderAndDirectory,
  parsePlaceTable,
  readNameEntry,
  type QueryResult,
} from "@loc-to-city/reader";
import { FileSource, nodeInflater, openFile } from "@loc-to-city/reader/node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "../../data/03-final/zuid-holland.bin");

// This dataset is produced by `data-ingest/src/filter-by-scope.ts --only-country NL`
// (filtering the worldwide pipeline's already-resolved output down to the
// Netherlands, see data/00-raw/orphan/README.md) followed by the
// compressor CLI (see README for the exact command). Skip gracefully
// rather than failing if it hasn't been built yet.
const skip = !existsSync(BIN_PATH);

// boundingBox varies with exact geometry, so it isn't a useful thing to
// hardcode in most of these tests -- just check the three place fields.
function assertUnknown(result: QueryResult): void {
  assert.deepEqual(
    { country: result.country, region: result.region, city: result.city },
    { country: null, region: null, city: null },
  );
}

test("zuid-holland.bin: structural facts (1 country, 12 regions)", { skip }, async () => {
  const source = await FileSource.open(BIN_PATH);
  const { header, directory } = await readHeaderAndDirectory(source);
  const placeTable = await parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  assert.equal(placeTable.countryCount, 1);
  assert.equal(placeTable.totalRegions, 12);
  // Sourced from the worldwide pipeline's per-country resolution, not the
  // deleted Python prototype -- every province has real cities now (see
  // "every province has real cities" test below), so this is a floor, not
  // an exact historical count the way the old Python-derived fixture had.
  assert.ok(placeTable.totalCities > 2000, `expected >2000 cities, got ${placeTable.totalCities}`);

  assert.deepEqual(await readNameEntry(source, placeTable, 0, nodeInflater), ["Netherlands"]);
});

test("zuid-holland.bin: every province has real cities, not just Zuid-Holland", { skip }, async () => {
  // Regression check for the "0-cities-elsewhere" fixture shape: it used
  // to be deliberate (the old Python-derived dataset only had Zuid-Holland's
  // cities), but the worldwide pipeline resolves every Dutch province's
  // cities correctly, so a real dataset built from it should reflect that
  // -- see compressor/test/build.test.ts's "Beta (0 cities)" for a
  // synthetic fixture that still exercises Section 7.2's "a region MAY
  // have 0 cities" rule independent of this real-world dataset.
  const source = await FileSource.open(BIN_PATH);
  const { header, directory } = await readHeaderAndDirectory(source);
  const placeTable = await parsePlaceTable(source, directory.placeTableStart, directory.placeTableLength, header.keyframeExp);

  let zuidHollandCityCount: number | undefined;
  let regionsWithZeroCities = 0;
  for (let r = 0; r < placeTable.totalRegions; r++) {
    const count = placeTable.cityRegionPrefix[r + 1]! - placeTable.cityRegionPrefix[r]!;
    const globalId = placeTable.countryCount + r;
    const [name] = await readNameEntry(source, placeTable, globalId, nodeInflater);
    if (name === "Zuid-Holland") zuidHollandCityCount = count;
    if (count === 0) regionsWithZeroCities++;
  }

  assert.ok(zuidHollandCityCount && zuidHollandCityCount > 100, `expected >100 Zuid-Holland cities, got ${zuidHollandCityCount}`);
  assert.equal(regionsWithZeroCities, 0);
});

test("zuid-holland.bin: a resolved city's ancestor chain classifies correctly", { skip }, async () => {
  const reader = await openFile(BIN_PATH);
  // Den Haag city hall, well inside its own boundary.
  const result = await reader.query(52.0799, 4.3113);
  assert.deepEqual(result.country, ["Netherlands"]);
  assert.deepEqual(result.region, ["Zuid-Holland", "South Holland"]);
  assert.ok(result.city, "expected a city-level result near Den Haag's city hall");
});

test("zuid-holland.bin: a point in Utrecht resolves to a real city, not just the region", { skip }, async () => {
  // The old Python-derived fixture only ever had Zuid-Holland's cities, so
  // this same coordinate used to resolve to just `region: Utrecht, city:
  // null` (the original regression test for the compressor never
  // indexing region/country geometry at all -- see README's "Two real
  // bugs found by browser testing"). The worldwide pipeline resolves a
  // real city here too, now.
  const reader = await openFile(BIN_PATH);
  const result = await reader.query(52.146973, 5.465698);
  assert.deepEqual(result.country, ["Netherlands"]);
  assert.deepEqual(result.region, ["Utrecht"]);
  assert.ok(result.city, "expected a city-level result in Utrecht");
});

test("zuid-holland.bin: outside the Netherlands entirely is unknown", { skip }, async () => {
  const reader = await openFile(BIN_PATH);
  assertUnknown(await reader.query(53.5, 3.5)); // North Sea
  assertUnknown(await reader.query(51.2, 4.4)); // Belgium
});
