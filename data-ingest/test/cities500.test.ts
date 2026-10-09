import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamCities500 } from "../src/lib/cities500.ts";

function writeFixture(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cities500-test-"));
  const file = path.join(dir, "cities500.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// A real cities500.txt row, tab-separated, 19 GeoNames columns -- Andorra's
// "Vila" from reader/binary-format.md's own worked example corpus, so the exact
// field positions being parsed are the real ones, not a guessed shape.
const REAL_ROW =
  "3038832\tVila\tVila\tCasas Vila,Vila\t42.53176\t1.56654\tP\tPPL\tAD\t\t03\t\t\t\t1418\t\t1318\tEurope/Andorra\t2024-11-04";

test("streamCities500: parses a real row's id, name, point, country and admin1 code", async () => {
  const file = writeFixture([REAL_ROW]);
  const rows = [];
  for await (const row of streamCities500(file)) rows.push(row);
  assert.deepEqual(rows, [
    { geonameId: "3038832", name: "Vila", point: [1.56654, 42.53176], countryCode: "AD", admin1Code: "03" },
  ]);
});

test("streamCities500: skips a blank line", async () => {
  const file = writeFixture([REAL_ROW, "", REAL_ROW]);
  const rows = [];
  for await (const row of streamCities500(file)) rows.push(row);
  assert.equal(rows.length, 2);
});

test("streamCities500: skips a row with no name, no country code, or a non-numeric coordinate", async () => {
  const noName = "1\t\tX\t\t42.5\t1.5\tP\tPPL\tAD\t\t03\t\t\t\t1\t\t1\tEurope/Andorra\t2024-01-01";
  const noCountry = "2\tX\tX\t\t42.5\t1.5\tP\tPPL\t\t\t03\t\t\t\t1\t\t1\tEurope/Andorra\t2024-01-01";
  const badLat = "3\tX\tX\t\tnot-a-number\t1.5\tP\tPPL\tAD\t\t03\t\t\t\t1\t\t1\tEurope/Andorra\t2024-01-01";
  const file = writeFixture([noName, noCountry, badLat]);
  const rows = [];
  for await (const row of streamCities500(file)) rows.push(row);
  assert.deepEqual(rows, []);
});

test("streamCities500: a missing admin1 code column becomes an empty string, not undefined", async () => {
  // Andorra's own row above already has admin1Code "03" -- use a row with
  // the column genuinely blank (two consecutive tabs) instead.
  const noAdmin1 = "4\tX\tX\t\t42.5\t1.5\tP\tPPL\tAD\t\t\t\t\t\t1\t\t1\tEurope/Andorra\t2024-01-01";
  const file = writeFixture([noAdmin1]);
  const rows = [];
  for await (const row of streamCities500(file)) rows.push(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.admin1Code, "");
});
