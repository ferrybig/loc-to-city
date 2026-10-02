import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTRY_ADMIN_LEVELS } from "../src/lib/countryAdminLevels.js";
import { findPlaceTagMismatches } from "../src/lib/placeTagSignal.js";
import type { PlaceTagCandidate } from "../src/lib/placeTagSignal.js";

function fakeCandidate(opts: {
  name: string;
  country: string;
  level: number;
  place?: string;
  bbox?: [number, number, number, number];
}): PlaceTagCandidate {
  return {
    name: opts.name,
    place: opts.place,
    country: opts.country,
    level: opts.level,
    bbox: opts.bbox ?? [0, 0, 0.01, 0.01],
  };
}

test("findPlaceTagMismatches: Bremen -- place=city at a level the country config doesn't list is a mismatch", () => {
  // DE's real table entry: city [8, 6] -- 6 is already a listed gap-fill
  // level (the fix this very signal would have found), so to exercise the
  // *pre-fix* shape this test uses a level DE's table genuinely excludes
  // (9) instead, keeping the real table untouched.
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.DE?.city, [8, 6], "test assumes DE's real table entry is still [8, 6]");
  const land = fakeCandidate({ name: "Bremen", country: "DE", level: 4 });
  const city = fakeCandidate({ name: "Bremen", country: "DE", level: 9, place: "city" });
  const [result] = findPlaceTagMismatches([land, city]);
  assert.equal(result?.isMismatch, true);
  assert.equal(result?.placeLevel, 9);
  assert.deepEqual(result?.otherLevels, [4]);
  assert.deepEqual(result?.configuredCityLevel, 8);
});

test("findPlaceTagMismatches: a place=city level already in the country's config is not a mismatch", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.DE?.city, [8, 6], "test assumes DE's real table entry is still [8, 6]");
  const land = fakeCandidate({ name: "Bremen", country: "DE", level: 4 });
  const city = fakeCandidate({ name: "Bremen", country: "DE", level: 6, place: "city" });
  const [result] = findPlaceTagMismatches([land, city]);
  assert.equal(result?.isMismatch, false);
  assert.equal(result?.placeLevel, 6);
});

test("findPlaceTagMismatches: a candidate alone at one level (no admin_level ambiguity) is not reported", () => {
  const onlyCandidate = fakeCandidate({ name: "Solo City", country: "FR", level: 8, place: "city" });
  assert.deepEqual(findPlaceTagMismatches([onlyCandidate]), []);
});

test("findPlaceTagMismatches: two same-name candidates at the same level (no level ambiguity) are not reported", () => {
  const a = fakeCandidate({ name: "Springfield", country: "US", level: 8, place: "city" });
  const b = fakeCandidate({ name: "Springfield", country: "US", level: 8 });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: no candidate carries a settlement place tag -- nothing to disambiguate with", () => {
  const a = fakeCandidate({ name: "X", country: "FR", level: 6 });
  const b = fakeCandidate({ name: "X", country: "FR", level: 8 });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: place tag itself spans more than one level -- still ambiguous, not actionable", () => {
  const a = fakeCandidate({ name: "X", country: "FR", level: 6, place: "town" });
  const b = fakeCandidate({ name: "X", country: "FR", level: 8, place: "city" });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: a non-settlement place value (e.g. islet) is not treated as a disambiguating tag", () => {
  const a = fakeCandidate({ name: "X", country: "FR", level: 6, place: "islet" });
  const b = fakeCandidate({ name: "X", country: "FR", level: 8 });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: same name, different country, far apart -- distinct settlements, not grouped together", () => {
  // Grouping is keyed by (country, name) already, so this mostly guards
  // that two different countries' same-named candidates never leak into
  // the same group even if a future change loosened the key.
  const a = fakeCandidate({ name: "San Jose", country: "US", level: 8, place: "city" });
  const b = fakeCandidate({ name: "San Jose", country: "CR", level: 4 });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: same (country,name) but geographically far apart -- coincidental collision, not grouped", () => {
  // Two unrelated US towns both named "Bremen" (Georgia and Indiana, say)
  // at different admin levels purely by coincidence -- bbox centers over
  // 0.5 degrees apart must not be treated as the same settlement.
  const a = fakeCandidate({ name: "Bremen", country: "US", level: 8, place: "city", bbox: [0, 0, 0.01, 0.01] });
  const b = fakeCandidate({ name: "Bremen", country: "US", level: 6, bbox: [5, 5, 5.01, 5.01] });
  assert.deepEqual(findPlaceTagMismatches([a, b]), []);
});

test("findPlaceTagMismatches: a region-scoped country (US, GB) is left unscored -- no region geometry to check against", () => {
  assert.ok(
    COUNTRY_ADMIN_LEVELS.US?.overrides && Object.keys(COUNTRY_ADMIN_LEVELS.US.overrides).length > 0,
    "test assumes US still has a region override entry",
  );
  const a = fakeCandidate({ name: "X", country: "US", level: 6 });
  const b = fakeCandidate({ name: "X", country: "US", level: 8, place: "town" });
  const [result] = findPlaceTagMismatches([a, b]);
  assert.equal(result?.configuredCityLevel, undefined);
  assert.equal(result?.isMismatch, false);
});

test("findPlaceTagMismatches: Brazil -- a place=village level not configured is NOT a mismatch when the same name already resolves at the configured level", () => {
  // Real shape (Mombuca, SP): the whole municipality is admin_level=8,
  // place=village -- not configured ([9]) -- but its own single
  // municipal-seat district carries the identical name at admin_level=9,
  // the already-configured level, with no place tag at all. The
  // settlement already resolves correctly today via the district; the
  // place tag on the municipality relation isn't evidence of anything
  // broken, so this must NOT be flagged as a mismatch.
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.BR?.city, [9], "test assumes BR's real table entry is still [9]");
  const municipality = fakeCandidate({ name: "Mombuca", country: "BR", level: 8, place: "village" });
  const district = fakeCandidate({ name: "Mombuca", country: "BR", level: 9 });
  const [result] = findPlaceTagMismatches([municipality, district]);
  assert.equal(result?.isMismatch, false);
  assert.equal(result?.alreadyResolvedAtLevel, 9);
  assert.equal(result?.configuredCityLevel, 9);
});

test("findPlaceTagMismatches: alreadyResolvedAtLevel is undefined when no same-settlement candidate sits at a configured level", () => {
  assert.deepEqual(COUNTRY_ADMIN_LEVELS.DE?.city, [8, 6], "test assumes DE's real table entry is still [8, 6]");
  const land = fakeCandidate({ name: "Bremen", country: "DE", level: 4 });
  const city = fakeCandidate({ name: "Bremen", country: "DE", level: 9, place: "city" });
  const [result] = findPlaceTagMismatches([land, city]);
  assert.equal(result?.alreadyResolvedAtLevel, undefined);
  assert.equal(result?.isMismatch, true);
});

test("findPlaceTagMismatches: results are sorted by country then name", () => {
  const groups: PlaceTagCandidate[] = [
    fakeCandidate({ name: "Zeta", country: "FR", level: 6 }),
    fakeCandidate({ name: "Zeta", country: "FR", level: 8, place: "city" }),
    fakeCandidate({ name: "Alpha", country: "FR", level: 6 }),
    fakeCandidate({ name: "Alpha", country: "FR", level: 8, place: "city" }),
    fakeCandidate({ name: "Mid", country: "AT", level: 6 }),
    fakeCandidate({ name: "Mid", country: "AT", level: 8, place: "city" }),
  ];
  const results = findPlaceTagMismatches(groups);
  assert.deepEqual(
    results.map((r) => `${r.country} ${r.name}`),
    ["AT Mid", "FR Alpha", "FR Zeta"],
  );
});
