import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CGeoDataReader } from "@loc-to-city/reader";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, "../../data/zuid-holland.bin");
const skip = !existsSync(BIN_PATH);

// The two known accuracy regressions this whole project exists to fix:
// a nearest-labelled-point system would misattribute both to a
// neighbouring settlement instead of the one whose actual boundary the
// point falls inside.
test("52.034656, 4.388124 resolves to Den Haag, not Nootdorp", { skip }, () => {
  const reader = CGeoDataReader.open(BIN_PATH);
  const result = reader.query(52.034656, 4.388124);
  assert.ok(result.city, "expected a city-level result");
  assert.equal(result.city![0], "Den Haag");
  assert.notEqual(result.city![0], "Nootdorp");
});

test("51.970738, 4.123725 resolves to Europoort, not Hoek van Holland", { skip }, () => {
  const reader = CGeoDataReader.open(BIN_PATH);
  const result = reader.query(51.970738, 4.123725);
  assert.ok(result.city, "expected a city-level result");
  assert.equal(result.city![0], "Europoort");
  assert.notEqual(result.city![0], "Hoek van Holland");
});

// Regression: a max-depth ambiguous cell near the Den Haag/Nootdorp border
// used to resolve to "region: Zuid-Holland, city: null" instead of a real
// city, because the region candidate (much bigger) always won the raw
// area-share tie-break against either nested city. Fixed by pruning a
// candidate whenever a more specific descendant also touches the same
// cell, so only Den Haag and Nootdorp compete for cells like this one --
// never their shared region.
test("52.035122, 4.390090 (Den Haag/Nootdorp border) resolves to a city, not just the region", { skip }, () => {
  const reader = CGeoDataReader.open(BIN_PATH);
  const result = reader.query(52.035122, 4.39009);
  assert.deepEqual(result.country, ["Nederland", "The Netherlands"]);
  assert.deepEqual(result.region, ["Zuid-Holland"]);
  assert.ok(result.city?.[0] === "Den Haag" || result.city?.[0] === "Nootdorp", `got city=${result.city}`);
});
