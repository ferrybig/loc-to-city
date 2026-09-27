import { test } from "node:test";
import assert from "node:assert/strict";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import area from "@turf/area";
import type { Feature, Polygon } from "geojson";
import { buildCityFallback, buildRegionFallback } from "../src/lib/voronoiFallback.js";
import type { Cities500Row } from "../src/lib/cities500.js";

function square(minX: number, minY: number, maxX: number, maxY: number): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    },
  };
}

function point(geonameId: string, name: string, lon: number, lat: number, admin1Code = "01"): Cities500Row {
  return { geonameId, name, point: [lon, lat], countryCode: "XX", admin1Code };
}

test("buildCityFallback: one point gets a cell covering the whole clip country", () => {
  const country = square(0, 0, 10, 10);
  const candidates = buildCityFallback(country, [point("1", "Solo", 5, 5)]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.name, "Solo");
  assert.equal(candidates[0]?.id, "voronoi:1");
  // A single site's Voronoi cell, clipped to the country, is the whole
  // country -- no other site to divide the plane against.
  assert.ok(area({ type: "Feature", properties: {}, geometry: candidates[0]!.geometry }) > area(country) * 0.99);
});

test("buildCityFallback: each point's own coordinate falls inside its own cell", () => {
  // Five points scattered across a country -- the defining Voronoi
  // property (a site is always the nearest site to itself) must hold for
  // every one of them, not just a hand-picked pair.
  const country = square(0, 0, 10, 10);
  const points = [
    point("1", "A", 2, 2),
    point("2", "B", 8, 2),
    point("3", "C", 2, 8),
    point("4", "D", 8, 8),
    point("5", "E", 5, 5),
  ];
  const candidates = buildCityFallback(country, points);
  assert.equal(candidates.length, points.length);
  for (const candidate of candidates) {
    const original = points.find((p) => `voronoi:${p.geonameId}` === candidate.id)!;
    assert.ok(
      booleanPointInPolygon(original.point, candidate.geometry),
      `${original.name}'s own point must fall inside its own cell`,
    );
  }
});

test("buildCityFallback: cells never extend past the country outline", () => {
  // A narrow country -- d3-delaunay's bbox clip alone would leave cells
  // spilling into the empty margin outside the real (narrower) outline;
  // @turf/intersect must clip that away.
  const narrowCountry = square(4, 0, 6, 10);
  const points = [point("1", "North", 5, 8), point("2", "South", 5, 2)];
  const candidates = buildCityFallback(narrowCountry, points);
  for (const candidate of candidates) {
    const cellArea = area({ type: "Feature", properties: {}, geometry: candidate.geometry });
    assert.ok(cellArea <= area(narrowCountry) + 1, `${candidate.name}'s cell must not exceed the country's own area`);
  }
});

test("buildCityFallback: two adjacent points split the country roughly in half, not overlapping", () => {
  const country = square(0, 0, 10, 10);
  const points = [point("1", "West", 2, 5), point("2", "East", 8, 5)];
  const candidates = buildCityFallback(country, points);
  assert.equal(candidates.length, 2);
  const west = candidates.find((c) => c.name === "West")!;
  const east = candidates.find((c) => c.name === "East")!;
  // The midline (x=5) is the Voronoi boundary between two points placed
  // symmetrically on the x-axis -- West's cell should be entirely x<=5,
  // East's entirely x>=5 (up to floating-point slack at the boundary).
  assert.ok(!booleanPointInPolygon([9, 5], west.geometry), "West's cell must not reach the far (East) side");
  assert.ok(!booleanPointInPolygon([1, 5], east.geometry), "East's cell must not reach the far (West) side");
  const combinedArea =
    area({ type: "Feature", properties: {}, geometry: west.geometry }) +
    area({ type: "Feature", properties: {}, geometry: east.geometry });
  assert.ok(Math.abs(combinedArea - area(country)) < area(country) * 0.01, "the two cells must tile the whole country");
});

test("buildCityFallback: no points produces no candidates", () => {
  const country = square(0, 0, 10, 10);
  assert.deepEqual(buildCityFallback(country, []), []);
});

test("buildRegionFallback: points sharing an admin1 code merge into one region", () => {
  // Slovenia's real shape: many points, few admin1 groups -- here two
  // points on the west side share code "01" (named region "West"), two
  // on the east side share "02" ("East").
  const country = square(0, 0, 10, 10);
  const points = [
    point("1", "Nw", 2, 8, "01"),
    point("2", "Sw", 2, 2, "01"),
    point("3", "Ne", 8, 8, "02"),
    point("4", "Se", 8, 2, "02"),
  ];
  const names = new Map([
    ["XX.01", "West"],
    ["XX.02", "East"],
  ]);
  const candidates = buildRegionFallback(country, points, names);
  assert.equal(candidates.length, 2);
  const west = candidates.find((c) => c.name === "West")!;
  const east = candidates.find((c) => c.name === "East")!;
  assert.ok(west);
  assert.ok(east);
  // Every one of the 4 original points must fall inside its own group's
  // merged region, and never inside the other group's.
  assert.ok(booleanPointInPolygon([2, 8], west.geometry) && booleanPointInPolygon([2, 2], west.geometry));
  assert.ok(booleanPointInPolygon([8, 8], east.geometry) && booleanPointInPolygon([8, 2], east.geometry));
  assert.ok(!booleanPointInPolygon([8, 8], west.geometry));
  assert.ok(!booleanPointInPolygon([2, 2], east.geometry));
  // The two regions must tile the whole country between them, same as
  // the city fallback's cells do individually.
  const combinedArea =
    area({ type: "Feature", properties: {}, geometry: west.geometry }) +
    area({ type: "Feature", properties: {}, geometry: east.geometry });
  assert.ok(Math.abs(combinedArea - area(country)) < area(country) * 0.01, "the two regions must tile the whole country");
});

test("buildRegionFallback: a point whose admin1 code has no name in the lookup is dropped, not left unnamed", () => {
  const country = square(0, 0, 10, 10);
  const points = [point("1", "Known", 3, 5, "01"), point("2", "Unknown", 7, 5, "99")];
  const names = new Map([["XX.01", "Known Region"]]);
  const candidates = buildRegionFallback(country, points, names);
  assert.deepEqual(
    candidates.map((c) => c.name),
    ["Known Region"],
  );
});

test("buildRegionFallback: a point with no admin1 code at all is excluded from every region", () => {
  const country = square(0, 0, 10, 10);
  const points = [point("1", "Grouped", 3, 5, "01"), point("2", "Loose", 7, 5, "")];
  const names = new Map([["XX.01", "Known Region"]]);
  const candidates = buildRegionFallback(country, points, names);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.name, "Known Region");
});

test("buildRegionFallback: no points produces no candidates", () => {
  const country = square(0, 0, 10, 10);
  assert.deepEqual(buildRegionFallback(country, [], new Map()), []);
});
