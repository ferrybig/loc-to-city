import assert from "node:assert/strict";
import { test } from "node:test";
import type { BBox, Polygon } from "geojson";
import { buildCoverageGrid, coverGrid, uncoveredKm2 } from "../src/lib/coverageGrid.ts";
import { preparePolygon } from "../src/lib/preparedPolygon.ts";
import { createGapFillTracker, MIN_UNCOVERED_KM2 } from "../src/lib/adminLevelDetection.ts";
import type { PrimaryLevelResult } from "../src/lib/adminLevelDetection.ts";
import type { AdminBoundaryIndex, CityCandidateMeta } from "../src/lib/adminBoundaryIndex.ts";

function square(x0: number, y0: number, x1: number, y1: number): Polygon {
  return { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] };
}

// A 0.4 x 0.4 degree "district" (~1,200 km^2 at 52N), the way Norwich's looks:
// a parish covers its point but most of it is open.
const district = square(1, 52, 1.4, 52.4);
const districtBbox: BBox = [1, 52, 1.4, 52.4];

test("a parish covering the district's point leaves the rest of it uncovered", () => {
  const grid = buildCoverageGrid(district, districtBbox);
  const total = uncoveredKm2(grid, districtBbox);
  assert.ok(total > 1100, `district area ${total}`);
  coverGrid(grid, districtBbox, preparePolygon(square(1.1, 52.1, 1.2, 52.2)), [1.1, 52.1, 1.2, 52.2]);
  const left = uncoveredKm2(grid, districtBbox);
  assert.ok(left < total * 0.95 && left > total * 0.9, `uncovered ${left} of ${total}`);
});

test("primaries that tile the district cover it entirely", () => {
  const grid = buildCoverageGrid(district, districtBbox);
  coverGrid(grid, districtBbox, preparePolygon(square(0.9, 51.9, 1.5, 52.5)), [0.9, 51.9, 1.5, 52.5]);
  assert.equal(uncoveredKm2(grid, districtBbox), 0);
});

function gbCandidate(level: number, name: string, box: BBox, area: number): CityCandidateMeta {
  return {
    id: name,
    name,
    nameEn: undefined,
    country: "GB",
    level,
    area,
    repPoint: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    bbox: box,
    coverage: buildCoverageGrid(square(box[0], box[1], box[2], box[3]), box),
  };
}

function trackerFor(candidates: CityCandidateMeta[]) {
  const index = {
    cityCandidates: candidates,
    areaByCountryLevel: new Map(),
    regionAreaByCountryLevel: new Map(),
    regionsByCountryName: new Map(),
    diagnostics: { scanned: 0, keptCity: 0, keptRegion: 0, noCountry: 0 },
  } as AdminBoundaryIndex;
  const primary: PrimaryLevelResult = { primaryLevelByCountry: new Map([["GB", 10]]), primaryIds: new Set() };
  return createGapFillTracker(index, primary, () => "England");
}

test("gap-fill by coverage: a district with a parish at its point is added while enough is open", () => {
  const norwich = gbCandidate(8, "Norwich", districtBbox, 1900);
  const tracker = trackerFor([norwich]);
  const parish = { ...gbCandidate(10, "Kirby Bedon", [1.1, 52.1, 1.2, 52.2], 100) };
  tracker.observePrimary(parish, () => square(1.1, 52.1, 1.2, 52.2));
  assert.deepEqual(tracker.gapFill().map((c) => c.name), ["Norwich"]);
});

test("gap-fill by coverage: a district the parishes tile is not added", () => {
  const district2 = gbCandidate(8, "Broadland", districtBbox, 1900);
  const tracker = trackerFor([district2]);
  const parish = gbCandidate(10, "Everything", [0.9, 51.9, 1.5, 52.5], 5000);
  tracker.observePrimary(parish, () => square(0.9, 51.9, 1.5, 52.5));
  assert.deepEqual(tracker.gapFill(), []);
  assert.ok(MIN_UNCOVERED_KM2 > 0);
});

test("gap-fill by coverage: a county its districts tile is no city, a unitary authority is", () => {
  const county = gbCandidate(6, "Hampshire", districtBbox, 1900);
  const unitary = gbCandidate(6, "Portsmouth", [5, 50, 5.1, 50.1], 60);
  const east = gbCandidate(8, "East", [1.2, 52, 1.4, 52.4], 950);
  const west = gbCandidate(8, "West", [1, 52, 1.2, 52.4], 950);
  const names = trackerFor([county, unitary, east, west]).gapFill().map((c) => c.name);
  assert.deepEqual(names.sort(), ["East", "Portsmouth", "West"]);
});
