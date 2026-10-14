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

test("a level named in regionGapFill is a region candidate too, outside the area vote", async () => {
  const index = await indexOf("PH", [
    box(120.9, 14.4, 0.3, { admin_level: "3", name: "Metro Manila" }, "a1"),
    box(121.2, 14.4, 0.3, { admin_level: "4", name: "Rizal" }, "a2"),
    box(120.9, 14.4, 0.1, { admin_level: "6", name: "Manila" }, "a3"),
  ]);
  assert.deepEqual([...index.regionsByCountryName.values()].map((r) => `${r.level} ${r.name}`).sort(), ["3 Metro Manila", "4 Rizal"]);
  assert.equal(index.regionAreaByCountryLevel.get("PH")?.has(3), true);
  const other = await indexOf("NL", [box(5, 52, 0.3, { admin_level: "3", name: "Nope" }, "a1")]);
  assert.equal(other.regionsByCountryName.size, 0);
});
