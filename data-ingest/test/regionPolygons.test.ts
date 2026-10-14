import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature, Polygon } from "geojson";
import { assignCityRegion, buildRegionIndex } from "../src/lib/regionPolygons.ts";
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
