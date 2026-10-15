import { test } from "node:test";
import assert from "node:assert/strict";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { clipper } from "../src/lib/clip.ts";
import type { Cities500Row } from "../src/lib/cities500.ts";
import { buildRegionHoles } from "../src/lib/regionHoles.ts";

const ring = (minX: number, minY: number, maxX: number, maxY: number): Position[][] => [
  [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]],
];
const box = (minX: number, minY: number, maxX: number, maxY: number): Polygon => ({
  type: "Polygon",
  coordinates: ring(minX, minY, maxX, maxY),
});
const row = (id: string, lon: number, lat: number, admin1Code: string): Cities500Row => ({
  geonameId: id,
  name: `P${id}`,
  point: [lon, lat],
  countryCode: "XX",
  admin1Code,
});
const inside = (outline: Position[][][], x: number, y: number) =>
  booleanPointInPolygon([x, y], { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: outline } });

// The country is 0..10 x 0..9; West (0..4) and East (6..10) leave the strip
// 4..6 uncovered. West's places are admin1 01, East's 02.
const outline: MultiPolygon = { type: "MultiPolygon", coordinates: [ring(0, 0, 10, 9)] };
const regions = [
  { name: "West", bbox: [0, 0, 4, 9] as [number, number, number, number], geometry: box(0, 0, 4, 9) },
  { name: "East", bbox: [6, 0, 10, 9] as [number, number, number, number], geometry: box(6, 0, 10, 9) },
];
const covered = [row("w1", 2, 2, "01"), row("w2", 2, 7, "01"), row("e1", 8, 2, "02"), row("e2", 8, 7, "02")];

test("a hole's places join the region of their admin1, else a new one named for it, else the nearest region", async () => {
  const points = [...covered, row("a", 5, 1, "01"), row("b", 5, 4.5, "03"), row("c", 5.2, 8, "")];
  const holes = await buildRegionHoles("XX", outline, regions, points, new Map([["XX.03", "Middle"]]), "Fallback", clipper());
  assert.deepEqual([...holes.extend.keys()].sort(), ["East", "West"]);
  assert.deepEqual([...holes.created.keys()], ["Middle"]);
  assert.ok(inside(holes.extend.get("West")!, 5, 1), "the hole land at West's place joins West");
  assert.ok(inside(holes.created.get("Middle")!, 5, 4.5));
  assert.ok(inside(holes.extend.get("East")!, 5.2, 8), "a place with no admin1 joins the nearest covered place's region");
  for (const outline of [...holes.extend.values(), ...holes.created.values()]) {
    assert.ok(!inside(outline, 3.9, 4.5) && !inside(outline, 6.1, 4.5), "no piece covers a region");
  }
  const total = [...holes.extend.values(), ...holes.created.values()].reduce(
    (sum, coordinates) => sum + area({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates } }),
    0,
  );
  const strip = area({ type: "Feature", properties: {}, geometry: box(4, 0, 6, 9) });
  assert.ok(total < strip * 1.001, "pieces stay in the hole");
});

test("the admin1 code beats distance; no region at all gives the fallback; no hole place changes nothing", async () => {
  const across = await buildRegionHoles("XX", outline, regions, [...covered, row("a", 5.5, 4.5, "01")], new Map(), "Fallback", clipper());
  assert.deepEqual([...across.extend.keys()], ["West"], "East's places are nearer, West's share the code");
  const bare = await buildRegionHoles("XX", outline, [], [row("a", 5, 4.5, "")], new Map(), "Fallback", clipper());
  assert.deepEqual([...bare.created.keys()], ["Fallback"]);
  const none = await buildRegionHoles("XX", outline, regions, covered, new Map(), "Fallback", clipper());
  assert.equal(none.extend.size + none.created.size, 0);
});
