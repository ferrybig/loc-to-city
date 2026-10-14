import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Feature } from "geojson";
import { buildAdminBoundaryIndex } from "../src/lib/adminBoundaryIndex.ts";
import type { CountryIndex } from "../src/lib/countryIndex.ts";

const box = (x: number, y: number, size: number, props: Record<string, string>, id: string): Feature => ({
  type: "Feature",
  id,
  properties: props,
  geometry: {
    type: "Polygon",
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
  },
});

async function indexOf(country: string, features: Feature[]) {
  const dir = mkdtempSync(join(tmpdir(), "name-en-"));
  const file = join(dir, "admin.geojsonseq");
  writeFileSync(file, features.map((f) => `\x1e${JSON.stringify(f)}\n`).join(""));
  const countries = { lookup: () => country } as unknown as CountryIndex;
  return buildAdminBoundaryIndex([file], countries);
}

test("a candidate without name:en borrows it from a relation with the same wikidata, at any level", async () => {
  const index = await indexOf("BE", [
    // The level the country is configured at (9): minimal tags, no name:en.
    box(4.3, 50.8, 0.1, { admin_level: "9", name: "Bruxelles - Brussel", wikidata: "Q239" }, "a2"),
    // Not a candidate level, but it has the name.
    box(4.3, 50.8, 0.1, { admin_level: "8", name: "Bruxelles - Brussel", wikidata: "Q239", "name:en": "Brussels" }, "a1"),
    // A different place without a match keeps nothing.
    box(5.0, 50.8, 0.1, { admin_level: "9", name: "Leuven", wikidata: "Q118958" }, "a3"),
  ]);
  const byName = new Map(index.cityCandidates.map((c) => [c.name, c.nameEn]));
  assert.equal(byName.get("Bruxelles - Brussel"), "Brussels");
  assert.equal(byName.get("Leuven"), undefined);
});

test("a country without the option borrows nothing", async () => {
  const index = await indexOf("NL", [
    box(4.3, 52.0, 0.1, { admin_level: "10", name: "Den Haag", wikidata: "Q36600" }, "a2"),
    box(4.3, 52.0, 0.1, { admin_level: "8", name: "Den Haag", wikidata: "Q36600", "name:en": "The Hague" }, "a1"),
  ]);
  assert.equal(index.cityCandidates.length, 1);
  assert.equal(index.cityCandidates[0]!.nameEn, undefined);
});
