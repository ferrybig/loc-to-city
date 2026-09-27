export interface CountryAdminLevels {
  /** admin_level candidates for the country's region (province/state/
   * county-equivalent) tier, best-by-area-share wins if more than one. */
  region: number[];
  /** admin_level candidates for the country's city tier, same tie-break. */
  city: number[];
  /** Per-region city level override, keyed by the exact region name this
   * country's regions resolve to (the same string `region` above's chosen
   * level produces). A region listed here ignores `city`/the country-wide
   * coverage vote entirely -- its own list is `[primary, ...gapFill]`:
   * the first level is that region's primary, unconditionally (no
   * coverage threshold, unlike the country-wide vote -- deliberately
   * simpler, since an override is already a hand-picked exception, not
   * something to re-derive a vote for); every later level gap-fills
   * *within this region only*, on top of that region's own primary, the
   * same "not covered by any primary -> add it" rule `detectGapFill`
   * already applies country-wide. A region's own levels never compete
   * against the country's `city` level, or against another region's
   * override levels, or against each other except via that same primary-
   * then-gap-fill order -- see README's "New York" entry for the two
   * regressions this shape exists to avoid: a country-wide multi-level
   * `city` list let a large gap-fill level (NY's towns) out-vote real,
   * smaller cities it geographically contains elsewhere in the country
   * (Arkansas townships beating Arkansas towns); and a flat "every listed
   * level is primary" override let NY's own two real tiers (villages
   * inside towns) do the same thing to each other. `[primary, ...gapFill]`
   * order sidesteps both: a level only gap-fills where its own region's
   * primary has no coverage, never where a peer already does. A region
   * not listed here is unaffected and keeps using `city` as normal. */
  overrides?: Record<string, number[]>;
}

/**
 * Per-country admin_level choice for the region and city tiers, generated
 * against the real worldwide OSM corpus (see
 * data-ingest/scripts/build-world.sh's Pass 1 output) by picking, per
 * country, whichever admin_level's total candidate area best matches the
 * country's own Natural Earth area -- region levels scanned from [4, 5, 6]
 * (coarsest wins a tie), city levels from [5..11] (finest level clearing
 * 60% coverage wins, else largest single-level share), always excluding
 * whichever level the country's own region entry already claimed.
 *
 * This replaces a shared, worldwide REGION_CANDIDATE_LEVELS/
 * CITY_CANDIDATE_LEVELS range that every country was implicitly voting on
 * together -- widening that range to fix one country's edge case (e.g.
 * North Macedonia's real municipality tier sitting at admin_level=7)
 * risked changing another, already-correct country's pick (Latvia's real
 * city tier is also 7). A per-country table makes every entry independent:
 * correcting one country can never again change another's result.
 *
 * Empty arrays mean "no candidate found at any level in range" -- the
 * same graceful degradation the pipeline already had (that place still
 * resolves at country level, just with no region/city subdivision).
 *
 * Hand-reviewed overrides, on top of the generated defaults:
 * - MK: the only level-4/5/6 candidate is Град Скопје (City of Skopje),
 *   covering just 2.3% of the country -- not a real region tier, just one
 *   municipality's boundary happening to also carry a lower admin_level.
 *   City (level 8, 98.8% coverage, North Macedonia's real municipalities)
 *   already resolves correctly and is untouched.
 * - US: level 6 (counties, 103.0% coverage) auto-won the >=60% vote over
 *   level 8 (incorporated places, only 10.7% coverage -- unincorporated
 *   land is common in the US), but county is the wrong city tier: it
 *   resolves e.g. Cleveland as "Cuyahoga County" instead of "Cleveland".
 *   Overridden to level 8 despite its low coverage -- measured against
 *   GeoNames' cities500 US entries (21,785 places), level 8 fuzzy-name-
 *   matches 64.0% of them vs. county's 4.3% (county's own name is almost
 *   never what GeoNames calls the place). Uncovered (unincorporated)
 *   points gap-fill to region instead of showing a wrong county name --
 *   see README's "US resolved at county grain, not city". New York
 *   State is a further, region-scoped exception on top of that: its own
 *   real municipal tier is level 7 (towns, 92.8% of the state), not the
 *   nationally-correct 8 (villages, only 2.1% there) -- confirmed level 7
 *   resolves Manhattan/Brooklyn/the Bronx/Albany correctly where level 8
 *   returns nothing. Two earlier, simpler attempts each caused a real
 *   regression, both the same shape: a country-wide `city: [7, 8]`
 *   gap-fill let level-7 towns out-vote real, smaller level-8 towns they
 *   geographically contain *elsewhere in the US* (measured: 399 fewer
 *   correct cities500 matches nationally -- e.g. Wrightsville, AR lost to
 *   the Big Rock Township it sits inside); a single-level
 *   `overrides: { "New York": [7] }` fixed that, but then lost NY's own
 *   villages (Village of Clyde, Village of Akron, ...) to the towns they
 *   themselves sit inside, for the identical reason, just scoped to NY
 *   (measured: 80 fewer correct matches nationally, still a net loss
 *   versus the plain level-8 baseline). `overrides: { "New York": [8, 7] }`
 *   fixes both: `[primary, ...gapFill]` order means level 8 is NY's own
 *   primary (its villages, the more specific real answer wherever one
 *   exists) and level 7 only gap-fills *within New York*, never
 *   contesting a cell a village already covers -- see this file's
 *   `overrides` doc comment above for the general rule, and README's
 *   "New York" entry for both measured regressions this final shape
 *   avoids.
 * - CA: same shape as US -- level 6 (regional districts, 66.2%) auto-won
 *   over level 8 (municipalities, 31.4%), resolving Terrace, BC as
 *   "Regional District of Kitimat-Stikine". Overridden to level 8: against
 *   cities500's 3,298 Canadian entries it name-matches 31.3% vs 14.8%.
 * - ET, AF: the generated pick put regions one tier too fine (zones /
 *   districts, since their share edged out the real top tier by <0.5%)
 *   and cities on a sparse tier (ET woredas 12.6%, AF city nahias 0.6%).
 *   Both now use level 4 (Ethiopian regional states, Afghan provinces) and
 *   level 5 (zones / districts, ~100% coverage).
 * - SA: region was level 6 (governorates) and city level 10 (1.5%, urban
 *   neighbourhoods -- Riyadh split into hundreds). Now region 4 (the 13
 *   provinces), city 6 (governorates, 99.8%: Riyadh, Jeddah, ...).
 * - TW: level 9 is villages (里, 7,545 of them). The real municipal tier is
 *   split across two levels: districts (區, level 7) inside special
 *   municipalities, townships (鄉/鎮/市, level 8) inside counties. City
 *   [7, 8] makes 8 primary and gap-fills the level-7 districts it doesn't
 *   cover.
 * - GB: level 10 (civil parishes) leaves unparished areas -- all of
 *   London, unitary towns like Reading and Brighton, nearly all of
 *   Scotland -- with no city. City [6, 8, 10] keeps parishes primary and
 *   gap-fills level-8 districts/boroughs (City of Westminster, Redditch)
 *   and level-6 unitary authorities / Scottish council areas (Reading,
 *   City of Edinburgh, Fife) wherever no parish covers them. A two-tier
 *   county whose representative point is unparished (Worcestershire)
 *   also gets added, but it's the largest candidate, so it only surfaces
 *   where no parish or district covers a cell.
 * - DE: Germany's 3 city-states (Berlin, Hamburg, Bremen) are OSM
 *   admin_level=4 -- the same level as every other Land -- so they lost
 *   the city slot entirely to the region tier. Bremen has a separate,
 *   place=city-tagged admin_level=6 relation for the city itself
 *   (distinct from the Land); city [8, 6] gap-fills it in. Berlin and
 *   Hamburg have no relation below level 4 at all -- no level choice
 *   fixes those two, see README's "Open" list.
 *
 * Entries whose comment shows a coverage figure far over 100% (e.g. small
 * multi-island nations like the Maldives or Cook Islands) reflect
 * overlapping/duplicate OSM candidates at that level, not a wrong pick --
 * the final region layer is still deduplicated by name. Entries with very
 * low city coverage (Egypt, Mauritania, Niger, and similar) reflect a
 * genuine, confirmed absence of sub-region administrative *polygon* data
 * in OSM for that country (see README's "Known issues"), not a level
 * chosen incorrectly -- there is no better level to pick instead.
 */
export const COUNTRY_ADMIN_LEVELS: Record<string, CountryAdminLevels> = {
  AD: { region: [], city: [7] }, // region 0.0%, city 103.5%
  AE: { region: [4], city: [8] }, // region 147.9%, city 93.1%
  AF: { region: [4], city: [5] }, // region 99.9%, city 99.9% -- see override note above
  AG: { region: [4], city: [6] }, // region 1947.0%, city 92.9%
  AL: { region: [6], city: [8] }, // region 100.8%, city 100.8%
  AM: { region: [4], city: [5] }, // region 100.4%, city 96.3%
  AO: { region: [4], city: [6] }, // region 102.9%, city 9.1%
  AR: { region: [4], city: [5] }, // region 101.1%, city 99.9%
  AS: { region: [4], city: [8] }, // region 834.7%, city 646.9%
  AT: { region: [4], city: [8] }, // region 99.9%, city 98.0%
  AU: { region: [4], city: [9] }, // region 105.3%, city 100.3%
  AW: { region: [], city: [8] }, // region 0.0%, city 23.0%
  AX: { region: [4], city: [8] }, // region 1415.9%, city 919.8%
  AZ: { region: [6], city: [8] }, // region 112.7%, city 4.2%
  BA: { region: [4], city: [9] }, // region 98.8%, city 61.3%
  BB: { region: [6], city: [9] }, // region 97.5%, city 19.6%
  BD: { region: [4], city: [6] }, // region 122.3%, city 111.4%
  BE: { region: [4], city: [9] }, // region 100.1%, city 99.9%
  BF: { region: [4], city: [6] }, // region 100.2%, city 67.2%
  BG: { region: [5], city: [8] }, // region 98.4%, city 46.5%
  BH: { region: [4], city: [10] }, // region 844.4%, city 0.6%
  BI: { region: [4], city: [6] }, // region 92.7%, city 25.3%
  BJ: { region: [4], city: [6] }, // region 99.2%, city 99.2%
  BL: { region: [], city: [8] }, // region 0.0%, city 84.8%
  BM: { region: [6], city: [] }, // region 86.8%, city 0.0%
  BN: { region: [4], city: [6] }, // region 155.6%, city 25.6%
  BO: { region: [4], city: [8] }, // region 99.7%, city 99.0%
  BR: { region: [4], city: [9] }, // region 103.1%, city 66.6%
  BS: { region: [], city: [8] }, // region 0.0%, city 759.4%
  BT: { region: [4], city: [8] }, // region 93.0%, city 91.2%
  BW: { region: [4], city: [6] }, // region 99.8%, city 18.1%
  BY: { region: [4], city: [8] }, // region 100.0%, city 99.5%
  BZ: { region: [4], city: [8] }, // region 115.9%, city 5.3%
  CA: { region: [4], city: [8] }, // region 128.2%, city 31.4% -- see override note above
  CD: { region: [4], city: [6] }, // region 100.2%, city 42.6%
  CF: { region: [4], city: [8] }, // region 100.1%, city 0.2%
  CG: { region: [4], city: [6] }, // region 99.3%, city 81.4%
  CH: { region: [4], city: [8] }, // region 99.6%, city 99.3%
  CI: { region: [4], city: [5] }, // region 100.3%, city 99.1%
  CK: { region: [4], city: [8] }, // region 2387.7%, city 629.5%
  CL: { region: [4], city: [8] }, // region 120.5%, city 120.5%
  CM: { region: [4], city: [8] }, // region 102.0%, city 100.3%
  CN: { region: [4], city: [6] }, // region 103.8%, city 102.5%
  CO: { region: [4], city: [6] }, // region 100.3%, city 100.1%
  CR: { region: [4], city: [8] }, // region 157.5%, city 100.0%
  CU: { region: [4], city: [6] }, // region 211.8%, city 97.7%
  CV: { region: [6], city: [9] }, // region 103.4%, city 6.3%
  CY: { region: [6], city: [8] }, // region 107.9%, city 104.7%
  CZ: { region: [4], city: [8] }, // region 100.1%, city 99.3%
  DE: { region: [4], city: [8, 6] }, // region 106.6%, city 97.8% (8) + gap-fill 6 -- see override note above
  DJ: { region: [4], city: [6] }, // region 99.2%, city 79.2%
  DK: { region: [4], city: [7] }, // region 100.8%, city 100.8%
  DM: { region: [4], city: [6] }, // region 102.9%, city 0.9%
  DO: { region: [4], city: [6] }, // region 99.5%, city 99.4%
  DZ: { region: [4], city: [8] }, // region 100.2%, city 99.9%
  EC: { region: [4], city: [8] }, // region 128.8%, city 100.5%
  EE: { region: [6], city: [9] }, // region 153.8%, city 94.6%
  EG: { region: [4], city: [6] }, // region 107.0%, city 0.1%
  EH: { region: [6], city: [8] }, // region 102.3%, city 87.1%
  ER: { region: [4], city: [] }, // region 130.6%, city 0.0%
  ES: { region: [4], city: [8] }, // region 99.8%, city 100.0%
  ET: { region: [4], city: [5] }, // region 100.0%, city 100.3% -- see override note above
  FI: { region: [4], city: [8] }, // region 113.4%, city 113.2%
  FJ: { region: [6], city: [] }, // region 516.8%, city 0.0%
  FK: { region: [], city: [10] }, // region 0.0%, city 100.8%
  FM: { region: [4], city: [8] }, // region 4261.6%, city 2033.4%
  FO: { region: [6], city: [9] }, // region 105.3%, city 101.1%
  FR: { region: [4], city: [8] }, // region 100.2%, city 100.1%
  GA: { region: [4], city: [6] }, // region 109.1%, city 101.2%
  GB: { region: [4], city: [6, 8, 10] }, // region 166.0%, city 64.7% (10) + gap-fill 8/6 -- see override note above
  GD: { region: [6], city: [] }, // region 101.8%, city 0.0%
  GE: { region: [6], city: [8] }, // region 102.9%, city 4.3%
  GG: { region: [4], city: [8] }, // region 107.6%, city 88.2%
  GH: { region: [4], city: [6] }, // region 100.1%, city 100.1%
  GL: { region: [4], city: [5] }, // region 71.9%, city 0.0%
  GM: { region: [4], city: [6] }, // region 107.3%, city 106.4%
  GN: { region: [4], city: [6] }, // region 100.5%, city 100.4%
  GQ: { region: [4], city: [8] }, // region 101.0%, city 93.6%
  GR: { region: [5], city: [7] }, // region 181.7%, city 100.3%
  GT: { region: [4], city: [6] }, // region 101.5%, city 98.6%
  GU: { region: [4], city: [6] }, // region 523.9%, city 99.3%
  GW: { region: [6], city: [] }, // region 121.8%, city 0.0%
  GY: { region: [4], city: [6] }, // region 100.0%, city 99.7%
  HK: { region: [4], city: [6] }, // region 265.9%, city 265.9%
  HM: { region: [4], city: [] }, // region 1668.5%, city 0.0%
  HN: { region: [4], city: [6] }, // region 136.4%, city 101.9%
  HR: { region: [4], city: [8] }, // region 160.2%, city 100.8%
  HT: { region: [4], city: [10] }, // region 100.6%, city 100.4%
  HU: { region: [4], city: [8] }, // region 99.8%, city 99.9%
  ID: { region: [4], city: [5] }, // region 280.1%, city 108.2%
  IE: { region: [6], city: [10] }, // region 101.2%, city 98.8%
  IL: { region: [5], city: [8] }, // region 100.4%, city 95.7%
  IM: { region: [6], city: [8] }, // region 99.7%, city 99.7%
  IN: { region: [4], city: [6] }, // region 100.2%, city 97.4%
  IQ: { region: [4], city: [7] }, // region 100.6%, city 98.3%
  IR: { region: [4], city: [7] }, // region 105.1%, city 104.4%
  IS: { region: [5], city: [6] }, // region 100.3%, city 100.3%
  IT: { region: [4], city: [8] }, // region 100.1%, city 100.1%
  JE: { region: [], city: [9] }, // region 0.0%, city 100.6%
  JM: { region: [5], city: [6] }, // region 99.4%, city 99.4%
  JO: { region: [4], city: [6] }, // region 100.0%, city 100.0%
  JP: { region: [4], city: [7] }, // region 204.2%, city 185.5%
  KE: { region: [4], city: [6] }, // region 99.7%, city 97.1%
  KG: { region: [4], city: [6] }, // region 99.8%, city 96.6%
  KH: { region: [4], city: [6] }, // region 112.3%, city 93.2%
  KI: { region: [], city: [8] }, // region 0.0%, city 2182.1%
  KM: { region: [4], city: [8] }, // region 98.8%, city 87.2%
  KN: { region: [6], city: [] }, // region 99.3%, city 0.0%
  KP: { region: [4], city: [6] }, // region 123.6%, city 109.2%
  KR: { region: [4], city: [6] }, // region 187.4%, city 178.4%
  KW: { region: [4], city: [6] }, // region 114.0%, city 93.4%
  KY: { region: [], city: [8] }, // region 0.0%, city 85.8%
  KZ: { region: [4], city: [6] }, // region 101.4%, city 100.4%
  LA: { region: [6], city: [7] }, // region 100.8%, city 0.2%
  LB: { region: [4], city: [7] }, // region 101.6%, city 63.2%
  LC: { region: [4], city: [] }, // region 99.6%, city 0.0%
  LI: { region: [6], city: [8] }, // region 116.9%, city 105.3%
  LK: { region: [4], city: [5] }, // region 146.5%, city 146.5%
  LR: { region: [6], city: [8] }, // region 101.6%, city 0.2%
  LS: { region: [5], city: [10] }, // region 101.5%, city 0.0%
  LT: { region: [5], city: [6] }, // region 100.6%, city 98.1%
  LU: { region: [6], city: [8] }, // region 99.4%, city 100.8%
  LV: { region: [5], city: [8] }, // region 100.0%, city 98.0%
  LY: { region: [4], city: [] }, // region 106.2%, city 0.0%
  MA: { region: [4], city: [8] }, // region 115.4%, city 102.1%
  MC: { region: [], city: [8] }, // region 0.0%, city 78.2%
  MD: { region: [4], city: [8] }, // region 102.0%, city 100.4%
  ME: { region: [6], city: [8] }, // region 99.5%, city 9.6%
  MF: { region: [], city: [8] }, // region 0.0%, city 78.4%
  MG: { region: [4], city: [6] }, // region 99.9%, city 99.8%
  MK: { region: [], city: [8] }, // region 2.3%, city 98.8% -- see override note above
  ML: { region: [4], city: [6] }, // region 100.0%, city 86.3%
  MM: { region: [6], city: [7] }, // region 115.3%, city 113.5%
  MN: { region: [4], city: [6] }, // region 100.0%, city 100.1%
  MO: { region: [6], city: [5] }, // region 125.0%, city 59.0%
  MP: { region: [6], city: [8] }, // region 1338.8%, city 3.1%
  MR: { region: [4], city: [6] }, // region 100.2%, city 0.0%
  MS: { region: [6], city: [] }, // region 103.1%, city 0.0%
  MT: { region: [], city: [8] }, // region 0.0%, city 97.0%
  MU: { region: [4], city: [8] }, // region 92.9%, city 95.7%
  MV: { region: [4], city: [8] }, // region 13257.9%, city 9.7%
  MW: { region: [4], city: [5] }, // region 80.4%, city 10.2%
  MX: { region: [4], city: [6] }, // region 100.3%, city 100.3%
  MY: { region: [4], city: [6] }, // region 133.4%, city 100.8%
  MZ: { region: [4], city: [5] }, // region 99.9%, city 99.1%
  NA: { region: [4], city: [8] }, // region 100.1%, city 0.1%
  NC: { region: [6], city: [8] }, // region 601.3%, city 103.1%
  NE: { region: [6], city: [8] }, // region 100.0%, city 0.0%
  NF: { region: [4], city: [9] }, // region 6022.3%, city 87.2%
  NG: { region: [4], city: [6] }, // region 100.4%, city 100.4%
  NI: { region: [4], city: [6] }, // region 130.6%, city 128.1%
  NL: { region: [4], city: [10] }, // region 111.1%, city 110.8%
  NO: { region: [4], city: [7] }, // region 164.2%, city 125.3%
  NP: { region: [6], city: [9] }, // region 100.3%, city 92.0%
  NR: { region: [6], city: [] }, // region 75.3%, city 0.0%
  NU: { region: [], city: [8] }, // region 0.0%, city 118.4%
  NZ: { region: [4], city: [6] }, // region 158.5%, city 109.1%
  OM: { region: [4], city: [6] }, // region 99.1%, city 99.1%
  PA: { region: [4], city: [8] }, // region 223.1%, city 73.5%
  PE: { region: [4], city: [8] }, // region 99.8%, city 99.7%
  PF: { region: [6], city: [10] }, // region 79.4%, city 567.6%
  PG: { region: [4], city: [5] }, // region 227.6%, city 99.5%
  PH: { region: [4], city: [6] }, // region 202.6%, city 113.8%
  PK: { region: [4], city: [7] }, // region 103.6%, city 102.0%
  PL: { region: [6], city: [7] }, // region 100.2%, city 100.1%
  PM: { region: [], city: [8] }, // region 0.0%, city 96.1%
  PR: { region: [4], city: [9] }, // region 246.1%, city 99.2%
  PS: { region: [4], city: [6] }, // region 100.6%, city 94.3%
  PT: { region: [6], city: [8] }, // region 97.5%, city 100.7%
  PW: { region: [4], city: [] }, // region 1896.1%, city 0.0%
  PY: { region: [4], city: [8] }, // region 99.9%, city 72.9%
  QA: { region: [4], city: [10] }, // region 103.9%, city 1.2%
  RO: { region: [4], city: [8] }, // region 100.8%, city 100.5%
  RS: { region: [4], city: [9] }, // region 100.0%, city 99.5%
  RU: { region: [4], city: [6] }, // region 108.2%, city 104.0%
  RW: { region: [6], city: [8] }, // region 99.9%, city 93.3%
  SA: { region: [4], city: [6] }, // region 100.2%, city 99.8% -- see override note above
  SB: { region: [4], city: [5] }, // region 768.5%, city 28.5%
  SC: { region: [6], city: [] }, // region 56.8%, city 0.0%
  SD: { region: [4], city: [6] }, // region 100.5%, city 72.2%
  SE: { region: [4], city: [7] }, // region 119.2%, city 119.2%
  SG: { region: [5], city: [7] }, // region 153.1%, city 119.4%
  SH: { region: [4], city: [10] }, // region 43.9%, city 0.0%
  SI: { region: [], city: [8] }, // region 0.0%, city 101.9%
  SK: { region: [6], city: [8] }, // region 101.2%, city 99.4%
  SL: { region: [4], city: [5] }, // region 101.4%, city 101.4%
  SM: { region: [], city: [8] }, // region 0.0%, city 84.2%
  SN: { region: [5], city: [8] }, // region 100.3%, city 100.1%
  SO: { region: [5], city: [6] }, // region 117.8%, city 115.7%
  SR: { region: [4], city: [6] }, // region 106.0%, city 100.3%
  SS: { region: [4], city: [5] }, // region 102.5%, city 100.7%
  ST: { region: [6], city: [7] }, // region 95.6%, city 82.1%
  SV: { region: [5], city: [6] }, // region 102.0%, city 101.3%
  SX: { region: [], city: [8] }, // region 0.0%, city 11.7%
  SY: { region: [5], city: [6] }, // region 100.3%, city 100.3%
  SZ: { region: [6], city: [] }, // region 101.5%, city 0.0%
  TC: { region: [6], city: [] }, // region 127.0%, city 0.0%
  TD: { region: [4], city: [8] }, // region 100.5%, city 0.7%
  TF: { region: [4], city: [10] }, // region 0.0%, city 153.2%
  TG: { region: [4], city: [6] }, // region 99.9%, city 58.6%
  TH: { region: [4], city: [6] }, // region 121.8%, city 100.1%
  TJ: { region: [4], city: [6] }, // region 99.4%, city 99.3%
  TL: { region: [4], city: [5] }, // region 98.6%, city 98.6%
  TM: { region: [4], city: [5] }, // region 107.6%, city 107.4%
  TN: { region: [5], city: [6] }, // region 99.4%, city 98.6%
  TO: { region: [4], city: [5] }, // region 1303.8%, city 99.4%
  TR: { region: [4], city: [6] }, // region 109.8%, city 100.0%
  TT: { region: [4], city: [9] }, // region 100.2%, city 0.1%
  TV: { region: [], city: [8] }, // region 0.0%, city 8089.5%
  TW: { region: [4], city: [7, 8] }, // region 82.3%, city 69.8% (8) + 30.9% (7) -- see override note above
  TZ: { region: [4], city: [5] }, // region 94.0%, city 94.0%
  UA: { region: [4], city: [7] }, // region 104.1%, city 99.7%
  UG: { region: [4], city: [6] }, // region 99.8%, city 6.4%
  US: {
    region: [4],
    city: [8], // region 106.6%, city 10.7% -- see override note above
    // NY has two real, nested tiers of its own: villages (8, the more
    // specific answer wherever one exists) inside towns (7, the state's
    // ~100% tessellation) -- 8 primary, 7 gap-fills the towns without a
    // village. Neither ever competes against the national level 8 list
    // (Cleveland, Wrightsville, ...), nor against each other outside
    // this primary/gap-fill order.
    overrides: { "New York": [8, 7] },
  },
  UY: { region: [4], city: [8] }, // region 99.7%, city 1.3%
  UZ: { region: [6], city: [8] }, // region 99.9%, city 1.3%
  VC: { region: [6], city: [] }, // region 106.2%, city 0.0%
  VE: { region: [4], city: [7] }, // region 103.6%, city 101.9%
  VG: { region: [4], city: [] }, // region 107.1%, city 0.0%
  VI: { region: [4], city: [6] }, // region 536.0%, city 536.0%
  VN: { region: [4], city: [6] }, // region 170.3%, city 99.6%
  VU: { region: [4], city: [] }, // region 1030.2%, city 0.0%
  WF: { region: [], city: [8] }, // region 0.0%, city 99.9%
  WS: { region: [4], city: [8] }, // region 102.0%, city 0.3%
  XK: { region: [6], city: [5] }, // region 99.9%, city 99.9%
  YE: { region: [4], city: [6] }, // region 115.4%, city 110.0%
  ZA: { region: [4], city: [10] }, // region 105.9%, city 99.5%
  ZM: { region: [4], city: [5] }, // region 99.8%, city 99.8%
  ZW: { region: [4], city: [6] }, // region 100.3%, city 100.3%
};

/** Countries with a genuine, confirmed absence of city-tier administrative
 * *polygon* data in OSM (per this file's own `city` coverage comments --
 * Libya 0%, Egypt 0.1%, Chad 0.7%, Eritrea 0%; see README's "Libya, Egypt,
 * Chad and Eritrea had no city tier"), not a wrong level pick -- there is
 * no OSM admin_level that would fix these, at any level.
 * `voronoiFallback.ts`'s `buildCityFallback` synthesizes a city polygon
 * per `cities500.txt` point instead, via a Voronoi diagram clipped to the
 * country outline. Explicit opt-in list, not automatic: a country only
 * ends up here after its OSM city coverage was hand-confirmed to be
 * unfixable by a level change, same philosophy as `COUNTRY_ADMIN_LEVELS`
 * itself -- never silently triggers just because a build's coverage
 * happens to come out low this run. Sudan is a confirmed same-class case
 * (Khartoum resolves to neither region nor city despite the region entry
 * claiming 100.5% coverage) but isn't listed yet -- its zero-city root
 * cause wasn't distinguished from the same still-open region-drop
 * question the README raises for it, so adding it here without checking
 * first could paper over a second, different bug the way Slovenia's
 * region gap once did for its city tier. */
export const VORONOI_CITY_FALLBACK: ReadonlySet<string> = new Set(["LY", "EG", "TD", "ER"]);

/** Countries with `region: []` -- no usable region tier in OSM at all --
 * where `voronoiFallback.ts`'s `buildRegionFallback` synthesizes one from
 * `cities500.txt`, grouped by GeoNames admin1 code (see that function's
 * doc comment for why cities500 rather than `admin1CodesASCII.txt`
 * directly). Slovenia is the one confirmed case so far: its real regional
 * tier, OSM `admin_level=7` ("Upravna Enota"), only covers 17.6% of the
 * country -- not a full tessellation, so no `region` level fixes it (see
 * README's "Slovenia has zero cities"). Same opt-in philosophy as
 * `VORONOI_CITY_FALLBACK`: added only after confirming no real OSM region
 * tier exists, not automatically. */
export const VORONOI_REGION_FALLBACK: ReadonlySet<string> = new Set(["SI"]);
