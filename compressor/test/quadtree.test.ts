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

test("a gap-fill city takes no cell a primary city contains, not even along its own edge", () => {
  // A corporation (30) and a smaller mandal (31) that reaches into it, drawn
  // from another source (Hyderabad). The mandal's west edge, x = 1.51, lies
  // inside a depth-6 cell that the corporation contains whole.
  const mandal = (gapFill: boolean): CandidateEntry => ({
    globalId: 31,
    shape: packFeature(square(1.51, 0.5, 4, 2.5)),
    ancestorIds: [1, 0],
    ...(gapFill ? { gapFill: true } : {}),
  });
  const corporation: CandidateEntry = { globalId: 30, shape: packFeature(square(0, 0, 3.01, 3)), ancestorIds: [1, 0] };
  const cellsOf = (mandalIsGapFill: boolean) => {
    const candidates = new CandidateIndex([entries[0]!, entries[1]!, corporation, mandal(mandalIsGapFill)]).candidatesForBbox(0, 0, 4, 4);
    const records = buildChunkRecords(candidates, bounds, 6);
    return (lon: number, lat: number) => {
      const x = Math.floor((lon / 4) * 64);
      const y = Math.floor((lat / 4) * 64);
      return records.find((r) => {
        const { x: cx, y: cy } = mortonDecode(r.code, 6);
        const size = 2 ** (6 - r.depth);
        return x >= cx && x < cx + size && y >= cy && y < cy + size;
      })!.globalId;
    };
  };
  const before = cellsOf(false);
  assert.equal(before(2, 1), 31, "two primaries: the smaller wins the overlap");
  const after = cellsOf(true);
  assert.equal(after(2, 1), 30, "the overlap stays the corporation's");
  assert.equal(after(1.52, 1), 30, "so does the cell the mandal's edge crosses inside it");
  assert.equal(after(3.5, 1), 31, "the mandal names the land outside the corporation");
  assert.equal(after(3.03, 1), 31, "and the corporation's edge cell, where it holds under a quarter");
});

test("a region's border does not cut through a city of another region", () => {
  // Regions 1 and 2 meet at x = 2.01, inside a depth-6 cell; city 40 belongs
  // to region 1 but reaches across that border (a Voronoi city spanning two
  // governorates, Egypt). Region 2 crosses that cell with most of it, the
  // city contains it.
  const regionEntries: CandidateEntry[] = [
    entries[0]!,
    { globalId: 1, shape: packFeature(square(0, 0, 2.01, 4)), ancestorIds: [0] },
    { globalId: 2, shape: packFeature(square(2.01, 0, 4, 4)), ancestorIds: [0] },
    { globalId: 40, shape: packFeature(square(1, 1, 3, 3)), ancestorIds: [1, 0] },
  ];
  const candidates = new CandidateIndex(regionEntries).candidatesForBbox(0, 0, 4, 4);
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
  assert.equal(cellOf(2.03, 2), 40, "the city keeps the cell the other region's border crosses");
  assert.equal(cellOf(2.03, 0.5), 2, "below the city, the border cell goes to the region holding most of it");
  assert.equal(cellOf(1.03, 2), 40, "the city's own edge cell, where it holds most of it");
});

test("two regions' border does not cut through a bigger city of a third region either", () => {
  // City 50 (region 3) is bigger than regions 1 and 2 and reaches into both:
  // where it overlaps them the smaller region wins, so their shared border at
  // x = 2.01 goes to them by share, not to the city as a line through them.
  const regionEntries: CandidateEntry[] = [
    { globalId: 0, shape: packFeature(square(0, 0, 4, 4)), ancestorIds: [] },
    { globalId: 1, shape: packFeature(square(0, 0, 2.01, 2)), ancestorIds: [0] },
    { globalId: 2, shape: packFeature(square(2.01, 0, 4, 2)), ancestorIds: [0] },
    { globalId: 3, shape: packFeature(square(0, 2, 4, 4)), ancestorIds: [0] },
    { globalId: 50, shape: packFeature(square(0, 1, 4, 4)), ancestorIds: [3, 0] },
  ];
  const candidates = new CandidateIndex(regionEntries).candidatesForBbox(0, 0, 4, 4);
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
  assert.equal(cellOf(1, 1.5), 1, "the smaller region wins where it overlaps the city");
  assert.equal(cellOf(2.03, 1.5), 2, "the regions' border cell goes to the region holding most of it");
  assert.equal(cellOf(2.03, 3), 50, "the city keeps its own region");
});

test("a city reaching into a smaller region draws no line along that region's own city", () => {
  // City 60 (region 1) reaches into region 2, which is smaller, so region 2
  // wins where they overlap. City 61 is region 2's own; the two cities meet
  // at x = 3.05, inside a depth-6 cell where region 2 is pruned for 61.
  const regionEntries: CandidateEntry[] = [
    entries[0]!,
    { globalId: 1, shape: packFeature(square(0, 0, 2, 4)), ancestorIds: [0] },
    { globalId: 2, shape: packFeature(square(2, 0, 4, 2)), ancestorIds: [0] },
    { globalId: 3, shape: packFeature(square(2, 2, 4, 4)), ancestorIds: [0] },
    { globalId: 60, shape: packFeature(square(0, 0, 3.05, 4)), ancestorIds: [1, 0] },
    { globalId: 61, shape: packFeature(square(3.05, 0, 4, 2)), ancestorIds: [2, 0] },
  ];
  const candidates = new CandidateIndex(regionEntries).candidatesForBbox(0, 0, 4, 4);
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
  assert.equal(cellOf(2.5, 1), 2, "the smaller region wins where it overlaps the city");
  assert.equal(cellOf(3.03, 1), 2, "and the cell on the cities' edge, mostly that overlap");
  assert.equal(cellOf(3.5, 1), 61);
  assert.equal(cellOf(1, 1), 60);
});

test("a city's own region does not take its coast for the sea it holds", () => {
  // Region 1 reaches into the sea east of x = 2.01, its city 70 ends there:
  // the cell at the coast is mostly sea, but the region is the city's own.
  const coastEntries: CandidateEntry[] = [
    entries[0]!,
    { globalId: 1, shape: packFeature(square(0, 0, 4, 4)), ancestorIds: [0] },
    { globalId: 70, shape: packFeature(square(0, 0, 2.01, 4)), ancestorIds: [1, 0] },
  ];
  const candidates = new CandidateIndex(coastEntries).candidatesForBbox(0, 0, 4, 4);
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
  assert.equal(cellOf(2.03, 1), 70, "the coast cell stays the city's");
  assert.equal(cellOf(3, 1), 1, "the sea beyond is the region's");
});
