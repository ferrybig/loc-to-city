import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature, Polygon } from "geojson";
import { buildPlaceIdSpace, type CityProperties } from "../src/placeIds.ts";

function city(name: string): Feature<Polygon, CityProperties> {
  return {
    type: "Feature",
    properties: { name, region: "Örebro län", country: "SE" },
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  };
}

test("cities get ids in code-unit order, not the build machine's collation", () => {
  // localeCompare would put Örebro between Askersund and Zinkgruvan on an
  // en-US machine and after both on a Swedish one -- the same input, two
  // different sets of city ids.
  const ids = buildPlaceIdSpace([{ code: "SE", name: "Sweden", regions: ["Örebro län"] }], {
    features: [city("Örebro"), city("Zinkgruvan"), city("Askersund")],
  });
  assert.deepEqual(ids.nameEntries, ["Sweden", "Örebro län", "Askersund", "Zinkgruvan", "Örebro"]);
});
