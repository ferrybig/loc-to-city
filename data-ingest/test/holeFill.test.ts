import { test } from "node:test";
import assert from "node:assert/strict";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, Polygon } from "geojson";
import { clipper } from "../src/lib/clip.ts";
import { buildHoleFill } from "../src/lib/holeFill.ts";
import type { Cities500Row } from "../src/lib/cities500.ts";

const square = (minX: number, minY: number, maxX: number, maxY: number): Feature<Polygon> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]] },
});
const row = (id: string, lon: number, lat: number): Cities500Row => ({
  geonameId: id,
  name: `P${id}`,
  point: [lon, lat],
  countryCode: "XX",
  admin1Code: "01",
});

test("a point no real city covers gets a cell, the real city is cut out, a covered point gets none", async () => {
  const real = square(0, 0, 4, 10);
  const regions = new Map([["North", square(0, 0, 10, 10)]]);
  const cells = await buildHoleFill(
    regions,
    [{ bbox: [0, 0, 4, 10], geometry: real.geometry }],
    [row("1", 2, 2), row("2", 6, 5), row("3", 9, 9)],
    () => "North",
    clipper(),
  );
  assert.deepEqual(cells.map((c) => c.id).sort(), ["voronoi:2", "voronoi:3"], "the covered point 1 is no site");
  const cell2 = cells.find((c) => c.id === "voronoi:2")!;
  const feature = { type: "Feature" as const, properties: {}, geometry: cell2.geometry };
  assert.ok(booleanPointInPolygon([6, 5], feature), "a site is inside its own cell");
  assert.ok(!booleanPointInPolygon([2, 5], feature), "the real city is cut out of it");
  const total = cells.reduce((sum, c) => sum + area({ type: "Feature", properties: {}, geometry: c.geometry }), 0);
  assert.ok(Math.abs(total - area(square(4, 0, 10, 10))) < area(square(4, 0, 10, 10)) * 0.001, "the cells tile what the real city leaves");
});

test("a cell stays inside its site's region", async () => {
  const regions = new Map([["West", square(0, 0, 5, 10)], ["East", square(5, 0, 10, 10)]]);
  const cells = await buildHoleFill(regions, [], [row("1", 4, 5), row("2", 9, 5)], (p) => (p[0] < 5 ? "West" : "East"), clipper());
  const west = cells.find((c) => c.id === "voronoi:1")!;
  // Without the region clip the bisector at x = 6.5 would hand the west site the east land up to it.
  assert.ok(!booleanPointInPolygon([5.5, 5], { type: "Feature", properties: {}, geometry: west.geometry }));
});

test("a region with no site is left alone", async () => {
  const cells = await buildHoleFill(new Map([["Empty", square(0, 0, 1, 1)]]), [], [], () => "Empty", clipper());
  assert.deepEqual(cells, []);
});

test("a section of a populated place (PPLX) is no site", async () => {
  const regions = new Map([["North", square(0, 0, 10, 10)]]);
  const cells = await buildHoleFill(
    regions,
    [],
    [row("1", 2, 5), { ...row("2", 8, 5), featureCode: "PPLX" }],
    () => "North",
    clipper(),
  );
  assert.deepEqual(cells.map((c) => c.id), ["voronoi:1"], "the town's cell covers its neighbourhood");
});
