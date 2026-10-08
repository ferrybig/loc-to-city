import assert from "node:assert/strict";
import { test } from "node:test";
import RBush from "rbush";
import { selectRegionLevels, selectPrimaryLevels, detectGapFill } from "../src/lib/adminLevelDetection.ts";
import type { PrimaryGeometryIndex, PrimaryGeometryItem, PrimaryLevelResult } from "../src/lib/adminLevelDetection.ts";
import type { AdminBoundaryIndex, CityCandidateMeta } from "../src/lib/adminBoundaryIndex.ts";
import { COUNTRY_ADMIN_LEVELS } from "../src/lib/countryAdminLevels.ts";
import type { CountryIndex } from "../src/lib/countryIndex.ts";

// selectRegionLevels/selectPrimaryLevels read COUNTRY_ADMIN_LEVELS directly
// (a per-country data table, not a parameter), so these tests exercise it
// through a handful of real, currently-stable entries rather than
// synthetic country codes -- there is no injection point left to fake it,
// which is the point: a country's own table row is the only thing that
// can ever change its own result.
function fakeCountries(areaByCode: Record<string, number>): CountryIndex {
  return {
    lookup: () => null,
    areaByCode: new Map(Object.entries(areaByCode)),
    nameByCode: new Map(),
    simplifiedFeatureByCode: new Map(),
  };
}

function fakeCandidate(country: string, level: number, area: number): CityCandidateMeta {
  return {
    id: `${country}-${level}-${area}`,
    name: "x",
    nameEn: undefined,
    country,
    level,
    area,
    repPoint: [0, 0],
    bbox: [0, 0, 0, 0],
  };
}

function fakeIndex(opts: {
  areaByCountryLevel?: Map<string, Map<number, number>>;
  regionAreaByCountryLevel?: Map<string, Map<number, number>>;
  cityCandidates?: CityCandidateMeta[];
}): AdminBoundaryIndex {
  return {
    cityCandidates: opts.cityCandidates ?? [],
    areaByCountryLevel: opts.areaByCountryLevel ?? new Map(),
    regionAreaByCountryLevel: opts.regionAreaByCountryLevel ?? new Map(),
    regionsByCountryName: new Map(),
    diagnostics: { scanned: 0, keptCity: 0, keptRegion: 0, noCountry: 0 },
  };
}

test("every country's region and city level lists are disjoint", () => {
  // The whole point of a per-country table over a shared worldwide range:
  // a level can still mean different things for different countries, but
  // it can never mean two different things for the *same* country. This
  // guards that invariant across every real entry, not just the ones a
  // test happens to construct by hand.
  const overlaps: string[] = [];
  for (const [code, levels] of Object.entries(COUNTRY_ADMIN_LEVELS)) {
    const shared = levels.region.filter((l) => levels.city.includes(l));
    if (shared.length > 0) overlaps.push(`${code}: ${shared.join(",")}`);
  }
  assert.deepEqual(overlaps, []);
});

test("selectRegionLevels: uses whatever level the country's own table entry lists (Iceland: region=[5])", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.IS?.region, [5], "test assumes IS's real table entry is still [5]");
  const countries = fakeCountries({ IS: 101723 });
  const index = fakeIndex({ regionAreaByCountryLevel: new Map([["IS", new Map([[5, 102066]])]]) });
  const { regionLevelByCountry } = selectRegionLevels(index, countries);
  assert.equal(regionLevelByCountry.get("IS"), 5);
});

test("selectRegionLevels: a level with real area data is still ignored if the country's table entry doesn't list it", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.SI?.region, [], "test assumes SI's real table entry has no region levels");
  const countries = fakeCountries({ SI: 20273 });
  // Level 8 has real, plausible-looking coverage, but SI's table entry
  // doesn't list 8 as a region candidate (only city) -- must not be picked.
  const index = fakeIndex({ regionAreaByCountryLevel: new Map([["SI", new Map([[8, 20000]])]]) });
  const { regionLevelByCountry } = selectRegionLevels(index, countries);
  assert.equal(regionLevelByCountry.has("SI"), false);
});

test("selectRegionLevels: North Macedonia's hand-reviewed override (empty region list) is respected even with area data present", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.MK?.region, [], "test assumes MK's override is still in place");
  const countries = fakeCountries({ MK: 25349 });
  // The real corpus does have a level-6 region candidate for MK (Град
  // Скопје / City of Skopje, ~2.3% coverage) -- the override must still
  // win over it, since the table lists no region levels for MK at all.
  const index = fakeIndex({ regionAreaByCountryLevel: new Map([["MK", new Map([[6, 571]])]]) });
  const { regionLevelByCountry } = selectRegionLevels(index, countries);
  assert.equal(regionLevelByCountry.has("MK"), false);
});

test("selectPrimaryLevels: uses whatever level the country's own table entry lists (Iceland: city=[6])", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.IS?.city, [6], "test assumes IS's real table entry is still [6]");
  const countries = fakeCountries({ IS: 101723 });
  const candidate = fakeCandidate("IS", 6, 102050);
  const index = fakeIndex({
    areaByCountryLevel: new Map([["IS", new Map([[6, 102050]])]]),
    cityCandidates: [candidate],
  });
  const { primaryLevelByCountry, primaryIds } = selectPrimaryLevels(index, countries);
  assert.equal(primaryLevelByCountry.get("IS"), 6);
  assert.deepEqual([...primaryIds], [candidate.id]);
});

test("selectPrimaryLevels: a level with real area data is still ignored if the country's table entry doesn't list it", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.IS?.city, [6], "test assumes IS's real table entry is still [6]");
  const countries = fakeCountries({ IS: 101723 });
  // Level 5 is IS's *region* level, not its city level -- even with area
  // data at 5 and none at 6, city selection must not fall back to 5.
  const index = fakeIndex({ areaByCountryLevel: new Map([["IS", new Map([[5, 102066]])]]) });
  const { primaryLevelByCountry } = selectPrimaryLevels(index, countries);
  assert.equal(primaryLevelByCountry.has("IS"), false);
});

test("selectPrimaryLevels: a region override's first level is primary regardless of the country-wide vote", () => {
  assert.deepEqual(
    COUNTRY_ADMIN_LEVELS.US?.overrides,
    { "New York": [8, 7] },
    "test assumes US's real table entry still overrides New York to [8, 7]",
  );
  const countries = fakeCountries({ US: 9834000 });
  // Deliberately no level-8 area data at all for US -- the country-wide
  // vote would resolve nothing -- so a level-8 NY candidate becoming
  // primary can only be the override, never a coincidental country pick.
  const nyCandidate = fakeCandidate("US", 8, 5);
  const otherCandidate = fakeCandidate("US", 6, 50);
  const index = fakeIndex({ cityCandidates: [nyCandidate, otherCandidate] });
  const { primaryIds } = selectPrimaryLevels(index, countries, undefined, (candidate) =>
    candidate === nyCandidate ? "New York" : "Ohio",
  );
  assert.equal(primaryIds.has(nyCandidate.id), true);
  assert.equal(primaryIds.has(otherCandidate.id), false);
});

test("selectPrimaryLevels: a region override's later (gap-fill-only) level is never primary, even matching the country's own chosen level", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  const countries = fakeCountries({ US: 9834000 });
  // Level 8 is both the country's own chosen level here (real area data)
  // AND New York's own primary -- but this candidate is level 7, New
  // York's *second* (gap-fill-only) override level. It must not become
  // primary just because 8 happens to also be what non-NY candidates use
  // -- selectPrimaryLevels only ever promotes a region's first override
  // level to primary; a later one is detectGapFill's job.
  const nyLevel7Candidate = fakeCandidate("US", 7, 5);
  const index = fakeIndex({
    areaByCountryLevel: new Map([["US", new Map([[8, 1000000]])]]),
    cityCandidates: [nyLevel7Candidate],
  });
  const { primaryIds } = selectPrimaryLevels(index, countries, undefined, () => "New York");
  assert.equal(primaryIds.has(nyLevel7Candidate.id), false);
});

test("detectGapFill: a candidate at another region's override level, in a region without that override, is never gap-fill-eligible", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  // Big Rock Township, AR: a real regression this guards -- level 7 only
  // exists as a US city candidate at all because New York overrides to
  // it, but nothing in COUNTRY_ADMIN_LEVELS.US ever meant "level 7 is
  // also a legitimate Arkansas city level." Left unfiltered, this
  // candidate's own point is uncovered by any Arkansas level-8 primary
  // (no incorporated town's boundary happens to cover a rural township's
  // centroid), so it would wrongly gap-fill in and contest cells against
  // real, smaller level-8 towns it geographically contains.
  const arkansasCandidate = fakeCandidate("US", 7, 1119.58);
  const index = fakeIndex({ cityCandidates: [arkansasCandidate] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([["US", 8]]),
    primaryIds: new Set(), // not primary -- otherwise gap-fill wouldn't even consider it
  };
  const primaryGeom: PrimaryGeometryIndex = { tree: new RBush<PrimaryGeometryItem>(), byId: new Map() };
  const gapFill = detectGapFill(index, primary, primaryGeom, undefined, () => "Arkansas");
  assert.deepEqual(gapFill, []);
});

test("detectGapFill: a New York candidate at its region's own gap-fill level (7) IS eligible when uncovered by its region's own primary (8)", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  // Town of Galen, NY, say -- a level-7 town with no level-8 village
  // covering this particular point.
  const nyTownCandidate = fakeCandidate("US", 7, 5);
  const index = fakeIndex({ cityCandidates: [nyTownCandidate] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([["US", 8]]),
    primaryIds: new Set(),
  };
  const primaryGeom: PrimaryGeometryIndex = { tree: new RBush<PrimaryGeometryItem>(), byId: new Map() }; // empty tree -- nothing covers this point
  const gapFill = detectGapFill(index, primary, primaryGeom, undefined, () => "New York");
  assert.deepEqual(
    gapFill.map((c) => c.id),
    [nyTownCandidate.id],
  );
});

test("detectGapFill: a New York candidate at its region's own gap-fill level (7) is skipped when its region's own primary (8) already covers the point", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  // Village of Clyde inside Town of Galen: the exact regression this
  // guards -- the town (level 7, gap-fill) must lose to a village
  // (level 8, primary) that already covers the same point, not out-vote
  // it via the quadtree's coverage-share tie-break.
  const townCandidate = fakeCandidate("US", 7, 1000); // large, contains the village
  const index = fakeIndex({ cityCandidates: [townCandidate] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([["US", 8]]),
    primaryIds: new Set(["US-8-5"]), // a village primary already "loaded"
  };
  const villagePolygon = {
    type: "Polygon" as const,
    coordinates: [
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ],
    ],
  };
  const primaryGeom: PrimaryGeometryIndex = {
    tree: new RBush<PrimaryGeometryItem>().load([{ minX: -1, minY: -1, maxX: 1, maxY: 1, id: "US-8-5", feature: { type: "Feature" as const, properties: {}, geometry: villagePolygon } }]),
    byId: new Map(),
  };
  townCandidate.repPoint = [0, 0]; // inside the village polygon above
  const gapFill = detectGapFill(index, primary, primaryGeom, undefined, () => "New York");
  assert.deepEqual(gapFill, []);
});

test("selectPrimaryLevels: a non-overridden region in the same country is unaffected by another region's override", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  const countries = fakeCountries({ US: 9834000 });
  const ohioCandidate = fakeCandidate("US", 8, 50);
  const index = fakeIndex({
    areaByCountryLevel: new Map([["US", new Map([[8, 1000000]])]]),
    cityCandidates: [ohioCandidate],
  });
  const { primaryIds } = selectPrimaryLevels(index, countries, undefined, () => "Ohio");
  assert.equal(primaryIds.has(ohioCandidate.id), true);
});
