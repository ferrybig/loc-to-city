import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRegionLevels, selectPrimaryLevels } from "../src/lib/adminLevelDetection.js";
import type { AdminBoundaryIndex, CityCandidateMeta } from "../src/lib/adminBoundaryIndex.js";
import { COUNTRY_ADMIN_LEVELS } from "../src/lib/countryAdminLevels.js";
import type { CountryIndex } from "../src/lib/countryIndex.js";

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
  return { id: `${country}-${level}-${area}`, name: "x", country, level, area, repPoint: [0, 0], bbox: [0, 0, 0, 0] };
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
