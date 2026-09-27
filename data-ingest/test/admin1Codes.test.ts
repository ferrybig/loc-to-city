import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAdmin1Names } from "../src/lib/admin1Codes.js";

function writeFixture(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "admin1-test-"));
  const file = path.join(dir, "admin1CodesASCII.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

// Real admin1CodesASCII.txt rows (Andorra's own, from the same corpus
// cities500.test.ts's fixture uses): code, name, asciiname, geonameid.
const REAL_ROWS = [
  "AD.06\tSant Julià de Loria\tSant Julia de Loria\t3039162",
  "AD.05\tOrdino\tOrdino\t3039676",
];

test("loadAdmin1Names: maps the country.code join key to the (non-ASCII) display name", async () => {
  const file = writeFixture(REAL_ROWS);
  const names = await loadAdmin1Names(file);
  assert.equal(names.get("AD.06"), "Sant Julià de Loria");
  assert.equal(names.get("AD.05"), "Ordino");
  assert.equal(names.size, 2);
});

test("loadAdmin1Names: skips a blank line", async () => {
  const file = writeFixture([REAL_ROWS[0]!, "", REAL_ROWS[1]!]);
  const names = await loadAdmin1Names(file);
  assert.equal(names.size, 2);
});

test("loadAdmin1Names: an unknown code is simply absent, not an empty string", async () => {
  const file = writeFixture(REAL_ROWS);
  const names = await loadAdmin1Names(file);
  assert.equal(names.get("XX.99"), undefined);
});
