import assert from "node:assert/strict";
import { test } from "node:test";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Position } from "geojson";
import { cutCountriesOutOfForeignRegions, type Outline, resolveCountryOverlaps } from "../src/lib/countryOutlines.ts";
import type { LonLat } from "../src/lib/geo.ts";

function ring(minX: number, minY: number, maxX: number, maxY: number): Position[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

function contains(outline: Outline, point: LonLat): boolean {
  return booleanPointInPolygon(point, { type: "MultiPolygon", coordinates: outline });
}

test("resolveCountryOverlaps: a dependency inside its parent's outline is cut out of the parent", () => {
  const outlines = new Map<string, Outline>([
    ["US", [[ring(0, 0, 10, 10)], [ring(20, 0, 30, 10)]]],
    ["PR", [[ring(22, 2, 24, 4)]]],
  ]);
  // Natural Earth puts the island's land in PR and its waters in nothing.
  const ownerAt = ([x, y]: LonLat) => (x > 22.5 && x < 23.5 && y > 2.5 && y < 3.5 ? "PR" : null);
  const { outlines: result, cuts } = resolveCountryOverlaps(outlines, ownerAt);

  assert.deepEqual(
    cuts.map(({ from, owner }) => [from, owner]),
    [["US", "PR"]],
  );
  assert.ok(!contains(result.get("US")!, [23, 3]), "the island's land is no longer the parent's");
  assert.ok(!contains(result.get("US")!, [22.2, 2.2]), "nor its waters");
  assert.ok(contains(result.get("US")!, [25, 5]), "the rest of that part stays");
  assert.ok(contains(result.get("US")!, [5, 5]), "a part nowhere near it stays");
  assert.deepEqual(result.get("PR"), outlines.get("PR"), "the owner is untouched");
});

test("resolveCountryOverlaps: a disputed overlap goes to the country ownerAt names", () => {
  // RU and UA both claim [10,15]x[0,10]; ownerAt (Natural Earth) says RU.
  const outlines = new Map<string, Outline>([
    ["UA", [[ring(0, 0, 15, 10)]]],
    ["RU", [[ring(10, 0, 40, 10)]]],
  ]);
  const ownerAt = ([x]: LonLat) => (x < 10 ? "UA" : "RU");
  const { outlines: result, cuts } = resolveCountryOverlaps(outlines, ownerAt);

  assert.deepEqual(
    cuts.map(({ from, owner }) => [from, owner]),
    [["UA", "RU"]],
  );
  assert.ok(!contains(result.get("UA")!, [12, 5]));
  assert.ok(contains(result.get("UA")!, [5, 5]));
  assert.ok(contains(result.get("RU")!, [12, 5]));
});

test("resolveCountryOverlaps: a coarse (Natural Earth) outline never takes land from a precise one", () => {
  // Palestine's coarse outline overshoots onto Israeli land, where ownerAt
  // (Natural Earth too) of course names Palestine.
  const outlines = new Map<string, Outline>([
    ["IL", [[ring(0, 0, 10, 10)]]],
    ["PS", [[ring(8, 0, 20, 10)]]],
  ]);
  const ownerAt = ([x]: LonLat) => (x < 8 ? "IL" : "PS");
  const { outlines: result, cuts } = resolveCountryOverlaps(outlines, ownerAt, new Set(["PS"]));
  assert.deepEqual(
    cuts.map(({ from, owner }) => [from, owner]),
    [["PS", "IL"]],
  );
  assert.ok(contains(result.get("IL")!, [9, 5]));
  assert.ok(!contains(result.get("PS")!, [9, 5]));
  assert.ok(contains(result.get("PS")!, [15, 5]));
});

test("resolveCountryOverlaps: at sea, the smaller country keeps the overlap", () => {
  const outlines = new Map<string, Outline>([
    ["NL", [[ring(0, 0, 10, 10)]]],
    ["AW", [[ring(4, 4, 5, 5)]]],
  ]);
  const { outlines: result, cuts } = resolveCountryOverlaps(outlines, () => null);
  assert.deepEqual(
    cuts.map(({ from, owner }) => [from, owner]),
    [["NL", "AW"]],
  );
  assert.ok(!contains(result.get("NL")!, [4.5, 4.5]));
  assert.ok(contains(result.get("NL")!, [1, 1]));
});

test("resolveCountryOverlaps: neighbours that only share a border are left alone", () => {
  const outlines = new Map<string, Outline>([
    ["NL", [[ring(0, 0, 10, 10)]]],
    ["DE", [[ring(10, 0, 20, 10)]]],
  ]);
  const { outlines: result, cuts } = resolveCountryOverlaps(outlines, () => null);
  assert.deepEqual(cuts, []);
  assert.equal(result.get("NL"), outlines.get("NL"));
  assert.equal(result.get("DE"), outlines.get("DE"));
});

test("resolveCountryOverlaps: a small dependency's own land outvotes a strip where ownerAt names the parent", () => {
  // Hong Kong: Natural Earth's coarse border gives a strip of it to China.
  // China's huge outline has many far-away parts; Hong Kong has one.
  const outlines = new Map<string, Outline>([
    ["CN", [[ring(0, 0, 40, 40)], ...Array.from({ length: 50 }, (_, i) => [ring(50 + i, 0, 50.5 + i, 0.5)])]],
    ["HK", [[ring(10, 10, 10.5, 10.5)]]],
  ]);
  const ownerAt = ([x, y]: LonLat) =>
    x >= 10 && x <= 10.5 && y >= 10 && y <= 10.5 ? (y > 10.4 ? "CN" : "HK") : x < 40 ? "CN" : null;
  const { cuts } = resolveCountryOverlaps(outlines, ownerAt);
  assert.deepEqual(
    cuts.map(({ from, owner }) => [from, owner]),
    [["CN", "HK"]],
  );
});

test("cutCountriesOutOfForeignRegions: a microstate is cut out of the neighbour's region that swallowed it", () => {
  // Monaco: a land part [5,5]x[6,6] plus territorial waters south of it.
  // France's simplified region covers the land and runs to the coast.
  const outlines = new Map<string, Outline>([
    ["FR", [[ring(0, 5, 10, 10), ring(5, 5, 6, 6)]]],
    ["MC", [[ring(5, 3, 6, 6)]]],
  ]);
  const regions = new Map([
    ["FR paca", { country: "FR", geometry: { type: "Polygon" as const, coordinates: [ring(0, 5, 10, 10)] } }],
    ["MC monaco", { country: "MC", geometry: { type: "Polygon" as const, coordinates: [ring(5, 3, 6, 6)] } }],
  ]);
  const ownerAt = ([x, y]: LonLat) => (y < 5 ? null : x >= 5 && x <= 6 && y <= 6 ? "MC" : "FR");
  const { geometryByRegion, cuts } = cutCountriesOutOfForeignRegions(regions, outlines, ownerAt);
  assert.deepEqual(
    cuts.map(({ region, country }) => [region, country]),
    [["FR paca", "MC"]],
  );
  assert.deepEqual([...geometryByRegion.keys()], ["FR paca"], "only changed regions come back");
  assert.ok(!contains(geometryByRegion.get("FR paca")!, [5.5, 5.5]));
  assert.ok(contains(geometryByRegion.get("FR paca")!, [2, 7]));
});

test("cutCountriesOutOfForeignRegions: land ownerAt gives to the region's country, and sea, stay", () => {
  // Western Sahara's outline inside Morocco's region, which ownerAt (Natural
  // Earth) agrees with; and a region overlapping a neighbour's waters only.
  const outlines = new Map<string, Outline>([
    ["EH", [[ring(0, 0, 4, 4)]]],
    ["NL", [[ring(10, 0, 14, 4)]]],
  ]);
  const regions = new Map([
    ["MA sahara", { country: "MA", geometry: { type: "Polygon" as const, coordinates: [ring(0, 0, 4, 4)] } }],
    ["BE coast", { country: "BE", geometry: { type: "Polygon" as const, coordinates: [ring(12, 0, 16, 4)] } }],
  ]);
  const ownerAt = ([x]: LonLat) => (x < 5 ? "MA" : null);
  const { geometryByRegion, cuts } = cutCountriesOutOfForeignRegions(regions, outlines, ownerAt);
  assert.deepEqual(cuts, []);
  assert.equal(geometryByRegion.size, 0);
});
