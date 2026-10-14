import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feature, Polygon } from "geojson";
import { CandidateIndex, packFeature, type CandidateEntry, type IndexedCandidate } from "../src/candidateIndex.ts";
import { buildChunkRecords } from "../src/quadtree.ts";
import { mortonDecode } from "@ferrybig/cgeodata-reader/format";

function polygon(ring: [number, number][]): Feature<Polygon> {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

const square = (x0: number, y0: number, x1: number, y1: number) =>
  polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
// A diagonal edge, so cells along it stay mixed down to max depth and are
// decided by the sampled share, not by full containment.
const triangle = polygon([[1, 1], [3, 1], [1, 3], [1, 1]]);

// Country 0 > region 1 > cities 10 and 11, two OSM relations with the same
// geometry (Alix and "Village of Alix"); region 2 is a second region drawn
// exactly like city 12 (Bamako - Koulikoro and the city of Bamako).
const entries: CandidateEntry[] = [
  { globalId: 0, shape: packFeature(square(0, 0, 4, 4)), ancestorIds: [] },
  { globalId: 1, shape: packFeature(square(0, 0, 4, 4)), ancestorIds: [0] },
  { globalId: 2, shape: packFeature(square(3, 3, 3.5, 3.5)), ancestorIds: [0] },
  { globalId: 10, shape: packFeature(triangle), ancestorIds: [1, 0] },
  { globalId: 11, shape: packFeature(triangle), ancestorIds: [1, 0] },
  { globalId: 12, shape: packFeature(square(3, 3, 3.5, 3.5)), ancestorIds: [1, 0] },
];
const bounds = { lonMin: 0, lonMax: 4, latMin: 0, latMax: 4 };

/** Deterministic Fisher-Yates, so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test("buildChunkRecords gives the same records for any candidate order", () => {
  const candidates: IndexedCandidate[] = new CandidateIndex(entries).candidatesForBbox(0, 0, 4, 4);
  const expected = buildChunkRecords(candidates, bounds, 6);
  for (let seed = 1; seed <= 50; seed++) {
    assert.deepEqual(buildChunkRecords(shuffled(candidates, seed), bounds, 6), expected, `order ${seed}`);
  }
});

test("identical polygons go to the finer tier, then the lower id", () => {
  const candidates = new CandidateIndex(entries).candidatesForBbox(0, 0, 4, 4);
  for (const order of [candidates, [...candidates].reverse()]) {
    const ids = new Set(buildChunkRecords(order, bounds, 6).map((r) => r.globalId));
    assert.ok(ids.has(10), "the lower-id duplicate city gets cells");
    assert.ok(!ids.has(11), "the higher-id duplicate gets none");
    assert.ok(ids.has(12), "the city beats the region drawn the same");
    assert.ok(!ids.has(2), "the region drawn like a city gets none");
  }
});

test("a district holding two parishes does not take their border cells", () => {
  // Parishes meet at x = 2.01, inside a depth-6 cell, so that cell is decided
  // by share; the district contains it whole and used to win it by scoring 100%.
  const parishEntries: CandidateEntry[] = [
    { globalId: 20, shape: packFeature(square(0, 0, 4, 4)), ancestorIds: [] },
    { globalId: 21, shape: packFeature(square(0, 0, 2.01, 2)), ancestorIds: [] },
    { globalId: 22, shape: packFeature(square(2.01, 0, 4, 2)), ancestorIds: [] },
  ];
  const candidates = new CandidateIndex(parishEntries).candidatesForBbox(0, 0, 4, 4);
  const records = buildChunkRecords(candidates, bounds, 6);
  const cellOf = (lon: number, lat: number) => {
    const x = Math.floor((lon / 4) * 64);
    const y = Math.floor((lat / 4) * 64);
    return records.find((r) => {
      const { x: cx, y: cy } = mortonDecode(r.code, 6);
      const size = 2 ** (6 - r.depth);
      return x >= cx && x < cx + size && y >= cy && y < cy + size;
    })!.globalId;
  };
  assert.equal(cellOf(2.03, 1), 22, "the border cell goes to the parish holding most of it");
  assert.equal(cellOf(1, 1), 21);
  assert.equal(cellOf(3, 1), 22);
  assert.equal(cellOf(2, 3), 20, "the district keeps the land no parish covers");
});
