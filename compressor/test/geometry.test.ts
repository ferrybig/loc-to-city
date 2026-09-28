import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { classifyCell, containsPoint, type CellBounds, type CellRelation } from "../src/geometry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CELL: CellBounds = { lonMin: 0, lonMax: 10, latMin: 0, latMax: 10 };

function poly(rings: number[][][]): Feature<Polygon> {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings } };
}

function box(minX: number, minY: number, maxX: number, maxY: number): number[][] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

function bboxOf(feature: Feature<Polygon | MultiPolygon>): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const parts = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const part of parts) {
    for (const ring of part) {
      for (const [x, y] of ring as [number, number][]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

function classify(feature: Feature<Polygon | MultiPolygon>, bounds: CellBounds = CELL): CellRelation {
  const [minX, minY, maxX, maxY] = bboxOf(feature);
  return classifyCell(feature, bounds, minX, minY, maxX, maxY);
}

/** Ground truth, independent of any polygon algebra: sample a dense grid
 * strictly inside the cell (never on its edge, so no boundary ambiguity)
 * and see how many points land inside the candidate. */
function sampledTruth(feature: Feature<Polygon | MultiPolygon>, bounds: CellBounds, n = 120): "all" | "none" | "some" {
  let inside = 0;
  let total = 0;
  for (let iy = 0; iy < n; iy++) {
    const lat = bounds.latMin + ((iy + 0.5) / n) * (bounds.latMax - bounds.latMin);
    for (let ix = 0; ix < n; ix++) {
      const lon = bounds.lonMin + ((ix + 0.5) / n) * (bounds.lonMax - bounds.lonMin);
      total++;
      if (booleanPointInPolygon([lon, lat], feature)) inside++;
    }
  }
  if (inside === total) return "all";
  if (inside === 0) return "none";
  return "some";
}

// Cases whose truth a dense sample settles unambiguously (nothing here
// hinges on zero-area boundary contact, which sampling can't see).
const sampledCases: Array<{ name: string; feature: Feature<Polygon | MultiPolygon> }> = [
  { name: "far away", feature: poly([box(20, 20, 30, 30)]) },
  { name: "swallows the cell whole", feature: poly([box(-5, -5, 15, 15)]) },
  { name: "overlaps one corner", feature: poly([box(5, -5, 15, 5)]) },
  { name: "sits entirely inside the cell", feature: poly([box(2, 2, 8, 8)]) },
  { name: "cell falls in a hole", feature: poly([box(-5, -5, 15, 15), box(-1, -1, 11, 11)]) },
  { name: "a hole clips part of the cell", feature: poly([box(-5, -5, 15, 15), box(5, 5, 12, 12)]) },
  {
    name: "multipolygon, a far part plus one covering the cell",
    feature: {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: [[box(-5, -5, 15, 15)], [box(30, 30, 40, 40)]] },
    },
  },
  {
    name: "multipolygon whose only nearby part sits inside the cell",
    feature: {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: [[box(100, 100, 110, 110)], [box(2, 2, 8, 8)]] },
    },
  },
];

test("classifyCell matches densely-sampled ground truth", () => {
  for (const { name, feature } of sampledCases) {
    const truth = sampledTruth(feature, CELL);
    const expected: CellRelation = truth === "all" ? "contains" : truth === "some" ? "crosses" : "disjoint";
    assert.equal(classify(feature), expected, `${name}: sampled truth was "${truth}"`);
  }
});

// Zero-area contact is invisible to sampling, so these are pinned
// explicitly. They are also exactly where @turf/boolean-contains was found
// to be wrong on real data (it reported containment for cells whose
// boundary is genuinely clipped), which is why this file asserts against
// ground truth rather than against turf.
test("classifyCell handles boundary contact that sampling cannot see", () => {
  // Shares the cell's left edge and extends past it on every other side:
  // the cell really is inside, an edge running along it notwithstanding.
  assert.equal(classify(poly([box(0, -5, 20, 15)])), "contains", "coincident edge must not defeat containment");

  // Exactly the cell. A closed polygon contains its own boundary.
  assert.equal(classify(poly([box(0, 0, 10, 10)])), "contains", "an identical polygon contains the cell");

  // Flush against the cell's right edge, no overlapping area at all.
  assert.equal(classify(poly([box(10, 0, 20, 10)])), "crosses", "edge-to-edge neighbour touches but cannot contain");

  // Meets the cell at a single corner point only.
  assert.equal(classify(poly([box(10, 10, 20, 20)])), "crosses", "corner-to-corner neighbour touches but cannot contain");

  // Clear of the cell entirely, if only just.
  assert.equal(classify(poly([box(10.0001, 0, 20, 10)])), "disjoint", "a hair's gap is still a gap");
});

test("classifyCell is unaffected by which cell of the grid it is asked about", () => {
  // Same geometry, shifted cell: a candidate that contains one cell and
  // only clips its neighbour must be classified differently for each.
  const candidate = poly([box(0, 0, 10, 10)]);
  const inside: CellBounds = { lonMin: 2, lonMax: 4, latMin: 2, latMax: 4 };
  const straddling: CellBounds = { lonMin: 8, lonMax: 12, latMin: 2, latMax: 4 };
  const outside: CellBounds = { lonMin: 12, lonMax: 14, latMin: 2, latMax: 4 };

  assert.equal(classify(candidate, inside), "contains");
  assert.equal(classify(candidate, straddling), "crosses");
  assert.equal(classify(candidate, outside), "disjoint");

  for (const bounds of [inside, straddling, outside]) {
    const truth = sampledTruth(candidate, bounds);
    const expected: CellRelation = truth === "all" ? "contains" : truth === "some" ? "crosses" : "disjoint";
    assert.equal(classify(candidate, bounds), expected);
  }
});

// A deterministic LCG so a failure is reproducible without recording the
// exact random point that triggered it.
function makeRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("containsPoint agrees with turf on real, complex province geometry", () => {
  // nl-provinces.geojson is real OSM/BAG-derived data with exactly the
  // shapes that made this worth replacing turf for in the first place:
  // holes (a province with a city carved out), MultiPolygons (islands),
  // and enough vertices per ring to exercise the banded ray cast, not
  // just the plain one.
  const provinces = JSON.parse(readFileSync(path.resolve(__dirname, "../../data/02-resolved/nl/provinces.geojson"), "utf8")) as FeatureCollection<
    Polygon | MultiPolygon
  >;
  assert.ok(provinces.features.length > 0, "fixture must actually have provinces to test against");

  const rng = makeRng(42);
  let checked = 0;
  let onLand = 0;
  for (const feature of provinces.features) {
    const [minX, minY, maxX, maxY] = bbox(feature) as [number, number, number, number];
    for (let i = 0; i < 500; i++) {
      const x = minX + rng() * (maxX - minX);
      const y = minY + rng() * (maxY - minY);
      const expected = booleanPointInPolygon([x, y], feature);
      const actual = containsPoint(feature.geometry, x, y);
      checked++;
      if (expected) onLand++;
      assert.equal(actual, expected, `${feature.properties?.name ?? "?"} at ${x},${y}: turf said ${expected}, containsPoint said ${actual}`);
    }
  }
  // A province's bbox is mostly not the province (coastline concavity,
  // neighbouring provinces sharing the bbox) -- confirm the sample actually
  // exercised both the inside and outside path, not just one of them.
  assert.ok(onLand > 0 && onLand < checked, `sample should mix inside/outside points, got ${onLand}/${checked} inside`);
});
