import assert from "node:assert/strict";
import { test } from "node:test";
import type { Feature, Polygon } from "geojson";
import { selectRegionLevels, selectPrimaryLevels, createGapFillTracker, selectWholeUnits, suppressedByWholeUnits } from "../src/lib/adminLevelDetection.ts";
import type { PrimaryLevelResult } from "../src/lib/adminLevelDetection.ts";
import type { AdminBoundaryIndex, CityCandidateMeta } from "../src/lib/adminBoundaryIndex.ts";
import { classifyAdminFeature } from "../src/lib/adminBoundaryIndex.ts";
import { COUNTRY_ADMIN_LEVELS, isNotPlace } from "../src/lib/countryAdminLevels.ts";
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

test("selectRegionLevels: North Macedonia's region level is 7, not the 2.3% Skopje relation at 6", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.MK?.region, [7], "test assumes MK's table entry is still [7]");
  const countries = fakeCountries({ MK: 25349 });
  // The real corpus has a level-6 candidate for MK (Град Скопје / City of
  // Skopje, ~2.3% coverage); the table doesn't list 6, so it must not win.
  const index = fakeIndex({ regionAreaByCountryLevel: new Map([["MK", new Map([[6, 571], [7, 25000]])]]) });
  const { regionLevelByCountry } = selectRegionLevels(index, countries);
  assert.equal(regionLevelByCountry.get("MK"), 7);
});

test("selectPrimaryLevels: primaryLevel wins over the area vote (Bulgaria: 8 at 46%, 5 at 100%)", () => {
  assert.equal(COUNTRY_ADMIN_LEVELS.BG?.primaryLevel, 8, "test assumes BG's table entry still pins level 8");
  const countries = fakeCountries({ BG: 110000 });
  const settlement = fakeCandidate("BG", 8, 50000);
  const municipality = fakeCandidate("BG", 5, 110000);
  const index = fakeIndex({
    areaByCountryLevel: new Map([["BG", new Map([[8, 50000], [5, 110000]])]]),
    cityCandidates: [settlement, municipality],
  });
  const { primaryLevelByCountry, primaryIds } = selectPrimaryLevels(index, countries);
  assert.equal(primaryLevelByCountry.get("BG"), 8);
  assert.deepEqual([...primaryIds], [settlement.id]);
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

test("gap-fill: a candidate at another region's override level, in a region without that override, is never gap-fill-eligible", () => {
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
  const tracker = createGapFillTracker(index, primary, () => "Arkansas");
  assert.deepEqual(tracker.gapFill(), []);
});

test("gap-fill: a New York candidate at its region's own gap-fill level (7) IS eligible when uncovered by its region's own primary (8)", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  // Town of Galen, NY, say -- a level-7 town with no level-8 village
  // covering this particular point.
  const nyTownCandidate = fakeCandidate("US", 7, 5);
  const index = fakeIndex({ cityCandidates: [nyTownCandidate] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([["US", 8]]),
    primaryIds: new Set(),
  };
  const tracker = createGapFillTracker(index, primary, () => "New York"); // no primary observed -- nothing covers this point
  assert.deepEqual(
    tracker.gapFill().map((c) => c.id),
    [nyTownCandidate.id],
  );
});

test("gap-fill: a New York candidate at its region's own gap-fill level (7) is skipped when its region's own primary (8) already covers the point", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.US?.overrides, { "New York": [8, 7] }, "test assumes US's override is still [8, 7]");
  // Village of Clyde inside Town of Galen: the exact regression this
  // guards -- the town (level 7, gap-fill) must lose to a village
  // (level 8, primary) that already covers the same point, not out-vote
  // it via the quadtree's coverage-share tie-break.
  const townCandidate = fakeCandidate("US", 7, 1000); // large, contains the village
  townCandidate.repPoint = [0, 0]; // inside the village polygon below
  const village = { ...fakeCandidate("US", 8, 5), bbox: [-1, -1, 1, 1] as [number, number, number, number] };
  const index = fakeIndex({ cityCandidates: [townCandidate, village] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([["US", 8]]),
    primaryIds: new Set([village.id]),
  };
  const tracker = createGapFillTracker(index, primary, () => "New York");
  assert.equal(tracker.primaryById.get(village.id), village);
  tracker.observePrimary(village, () => square(-1, -1, 1, 1));
  assert.deepEqual(tracker.gapFill(), []);
});

function square(minX: number, minY: number, maxX: number, maxY: number): Polygon {
  return {
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
  };
}

test("gap-fill: only a primary of the candidate's own country can cover it", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.DE?.city, [8, 6], "test assumes DE's city levels are still [8, 6]");
  // A Kreis whose representative point sits just inside a Dutch
  // municipality's polygon, where the two outlines don't quite line up at
  // the border: that municipality is no reason to drop the Kreis.
  const kreis = { ...fakeCandidate("DE", 6, 100), repPoint: [0, 0] as [number, number] };
  const dutch = { ...fakeCandidate("NL", 10, 5), bbox: [-1, -1, 1, 1] as [number, number, number, number] };
  const german = { ...fakeCandidate("DE", 8, 5), bbox: [-1, -1, 1, 1] as [number, number, number, number] };
  const index = fakeIndex({ cityCandidates: [kreis, dutch, german] });
  const primary: PrimaryLevelResult = {
    primaryLevelByCountry: new Map([
      ["DE", 8],
      ["NL", 10],
    ]),
    primaryIds: new Set([dutch.id, german.id]),
  };

  const tracker = createGapFillTracker(index, primary);
  let parsed = 0;
  tracker.observePrimary(dutch, () => {
    parsed++;
    return square(-1, -1, 1, 1);
  });
  assert.equal(parsed, 0, "a foreign primary's geometry isn't even needed");
  assert.deepEqual(
    tracker.gapFill().map((c) => c.id),
    [kreis.id],
  );

  tracker.observePrimary(german, () => square(-1, -1, 1, 1));
  assert.deepEqual(tracker.gapFill(), []);
});

test("gap-fill: a primary whose bbox holds no open candidate point is never parsed", () => {
  const kreis = { ...fakeCandidate("DE", 6, 100), repPoint: [5, 5] as [number, number] };
  const far = { ...fakeCandidate("DE", 8, 5), bbox: [-1, -1, 1, 1] as [number, number, number, number] };
  const index = fakeIndex({ cityCandidates: [kreis, far] });
  const primary: PrimaryLevelResult = { primaryLevelByCountry: new Map([["DE", 8]]), primaryIds: new Set([far.id]) };
  const tracker = createGapFillTracker(index, primary);
  tracker.observePrimary(far, () => assert.fail("geometry should not be needed"));
  assert.deepEqual(
    tracker.gapFill().map((c) => c.id),
    [kreis.id],
  );
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

test("whole units: Welsh Cardiff is promoted to primary and its communities are suppressed, Pontypridd is not", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.GB?.overrides?.["Cymru / Wales"], [10, 6, 8], "test assumes Wales' real override");
  const unit = (id: string, level: number, name: string, repPoint: [number, number], bbox: [number, number, number, number]) => ({
    ...fakeCandidate("GB", level, 1),
    id,
    name,
    repPoint,
    bbox,
  });
  const cardiff = unit("cardiff", 6, "Cardiff", [-3.18, 51.48], [-3.3, 51.4, -3.1, 51.56]);
  const castle = unit("castle", 10, "Castle", [-3.18, 51.48], [-3.19, 51.47, -3.17, 51.49]);
  const pontypridd = unit("pontypridd", 10, "Pontypridd", [-3.34, 51.6], [-3.4, 51.55, -3.3, 51.65]);
  const rct = unit("rct", 6, "Rhondda Cynon Taf", [-3.4, 51.65], [-3.7, 51.5, -3.2, 51.8]);
  const index = fakeIndex({ cityCandidates: [cardiff, castle, pontypridd, rct] });
  const resolveRegion = () => "Cymru / Wales";

  const primary = selectPrimaryLevels(index, fakeCountries({ GB: 243_000 }), undefined, resolveRegion);
  assert.deepEqual([...primary.primaryIds].sort(), ["cardiff", "castle", "pontypridd"]);

  const box = (b: [number, number, number, number]): Polygon => ({
    type: "Polygon",
    coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]],
  });
  const units = selectWholeUnits(index, primary, resolveRegion);
  assert.deepEqual(units.map((u) => u.id), ["cardiff"]);

  const suppressed = suppressedByWholeUnits(
    index,
    primary,
    units.map((candidate) => ({ candidate, geometry: box(candidate.bbox as [number, number, number, number]) })),
  );
  assert.deepEqual([...suppressed], ["castle"]);
});

test("gap-fill: a candidate is judged by a point inside it, not a boundary vertex a neighbour shares", () => {
  // Bremen: its representative point is a vertex on the border with
  // Ritterhude, a level-8 primary, which contains that vertex too. Its
  // inside point is in no primary, so it is gap-filled.
  const bremen = {
    ...fakeCandidate("DE", 6, 100),
    repPoint: [1, 0] as [number, number],
    regionPoint: [0.5, 0] as [number, number],
  };
  const ritterhude = { ...fakeCandidate("DE", 8, 5), bbox: [1, -1, 2, 1] as [number, number, number, number] };
  const index = fakeIndex({ cityCandidates: [bremen, ritterhude] });
  const primary: PrimaryLevelResult = { primaryLevelByCountry: new Map([["DE", 8]]), primaryIds: new Set([ritterhude.id]) };
  const tracker = createGapFillTracker(index, primary);
  tracker.observePrimary(ritterhude, () => square(1, -1, 2, 1));
  assert.deepEqual(
    tracker.gapFill().map((c) => c.id),
    [bremen.id],
  );
});

test("NOT_PLACES: the German-Luxembourg condominium is no candidate, by its area id", () => {
  // Relation 3659532 is osmium's area a7319065 (2 * id + 1); a7319064 would be a way.
  assert.equal(isNotPlace("a7319065"), true);
  assert.equal(isNotPlace("a7319064"), false);
  assert.equal(isNotPlace("a3659532"), false);
  const condominium = {
    type: "Feature",
    id: "a7319065",
    properties: { admin_level: "6", boundary: "administrative", name: "Condominium Lëtzebuerg-Deutschland" },
    geometry: { type: "Polygon", coordinates: [[[6.36, 49.49], [6.37, 49.49], [6.37, 49.5], [6.36, 49.5], [6.36, 49.49]]] },
  } as Feature;
  assert.equal(classifyAdminFeature(condominium, { lookup: () => "DE" }), null);
});
