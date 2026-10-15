import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature, Polygon } from "geojson";
import { assignCityRegion, buildRegionIndex, shareInOtherRegions } from "../src/lib/regionPolygons.ts";
import type { RegionCandidate } from "../src/lib/adminBoundaryIndex.ts";

function region(name: string, country: string, box: [number, number, number, number]): [string, RegionCandidate] {
  const [x0, y0, x1, y1] = box;
  const feature: Feature<Polygon, { name: string }> = {
    type: "Feature",
    properties: { name },
    geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
  };
  return [`${country} 4 ${name}`, { id: name, name, nameEn: undefined, country, level: 4, bbox: box, feature }];
}

test("assignCityRegion: of overlapping regions the smaller one wins, whatever the order", () => {
  const entries = [region("Big", "XX", [0, 0, 10, 10]), region("Small", "XX", [4, 4, 6, 6]), region("Other", "YY", [4, 4, 5, 5])];
  for (const order of [entries, [...entries].reverse()]) {
    const index = buildRegionIndex(new Map(order));
    assert.equal(assignCityRegion([5, 5], "XX", index), "Small");
    assert.equal(assignCityRegion([1, 1], "XX", index), "Big");
    assert.equal(assignCityRegion([20, 20], "XX", index), null);
  }
});

test("assignCityRegion: equal regions are told apart by name", () => {
  const entries = [region("B", "XX", [0, 0, 10, 10]), region("A", "XX", [0, 0, 10, 10])];
  for (const order of [entries, [...entries].reverse()]) {
    assert.equal(assignCityRegion([5, 5], "XX", buildRegionIndex(new Map(order))), "A");
  }
});

test("shareInOtherRegions measures the part of a city in its country's other regions", () => {
  // West and East meet at x = 10, and Both overlaps them (a PH level-3 region
  // over its provinces); the strip 20..30 is in no region of XX, and YY's
  // region covers it.
  const index = buildRegionIndex(
    new Map([
      region("West", "XX", [0, 0, 10, 10]),
      region("East", "XX", [10, 0, 20, 10]),
      region("Both", "XX", [0, 0, 20, 10]),
      region("Abroad", "YY", [20, 0, 30, 10]),
    ]),
  );
  const share = (minX: number, maxX: number, own: string) =>
    shareInOtherRegions(
      { type: "Polygon", coordinates: [[[minX, 2], [maxX, 2], [maxX, 8], [minX, 8], [minX, 2]]] },
      [minX, 2, maxX, 8],
      "XX",
      own,
      index,
    );
  assert.equal(share(2, 8, "West"), 0, "a city inside its own region, which Both overlaps too");
  assert.ok(Math.abs(share(6, 16, "West") - 0.6) < 0.05, "60% of it is in East");
  assert.ok(Math.abs(share(6, 16, "East") - 0.4) < 0.05, "and 40% in West");
  assert.equal(share(22, 28, "West"), 0, "land in no region of the country counts for neither, another country's region neither");
});
