import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import RBush from "rbush";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { AdminBoundaryIndex, CityCandidateMeta } from "./adminBoundaryIndex.ts";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.ts";
import type { CountryIndex } from "./countryIndex.ts";
import { streamMergedAdminBoundaries } from "./mergeAdminBoundaries.ts";

const DEFAULT_COVERAGE_THRESHOLD = 0.6;
const DEFAULT_MEMORY_CEILING_BYTES = 8 * 1024 ** 3;
const RSS_CHECK_INTERVAL = 5000;

export interface RegionLevelResult {
  regionLevelByCountry: Map<string, number>;
}

/** Pass 1.5: picks each country's region (top subdivision) level from
 * `regionAreaByCountryLevel`, scanning only the levels that country's own
 * `COUNTRY_ADMIN_LEVELS` entry lists as region candidates (coarsest wins a
 * tie, since a region layer is meant to be the coarser of the two
 * subdivision tiers -- most entries list exactly one level anyway, so this
 * only matters for the handful that list more). No minimum-coverage
 * threshold: the old hardcoded-to-4 code unconditionally accepted every
 * admin_level=4 feature as a region regardless of how much of the country
 * it covered, so requiring a floor here would be a *stricter* rule than
 * what already shipped, not a generalization of it. */
export function selectRegionLevels(index: AdminBoundaryIndex, countries: CountryIndex): RegionLevelResult {
  const regionLevelByCountry = new Map<string, number>();

  for (const [country, byLevel] of index.regionAreaByCountryLevel) {
    const countryArea = countries.areaByCode.get(country);
    if (!countryArea) continue;
    const candidateLevels = COUNTRY_ADMIN_LEVELS[country]?.region ?? [];

    let bestLevel: number | undefined;
    let bestRatio = -Infinity;
    for (const level of [...candidateLevels].sort((a, b) => a - b)) {
      const levelArea = byLevel.get(level);
      if (levelArea === undefined) continue;
      const ratio = levelArea / countryArea;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestLevel = level;
      }
    }
    if (bestLevel !== undefined) regionLevelByCountry.set(country, bestLevel);
  }

  console.error(`selectRegionLevels: ${regionLevelByCountry.size} countries assigned a region level`);
  return { regionLevelByCountry };
}

export interface PrimaryLevelResult {
  primaryLevelByCountry: Map<string, number>;
  primaryIds: Set<string>;
}

/** Pass 2 of the 3-pass algorithm: pure computation over Pass 1's area
 * maps, no I/O. Per country, scanning only the levels that country's own
 * `COUNTRY_ADMIN_LEVELS` entry lists as city candidates, picks the finest
 * admin_level whose own area already covers >= `threshold` of the
 * country's Natural Earth area. If no level clears the threshold, falls
 * back to whichever level has the single largest share -- confirmed to
 * match the deleted Python pipeline's exact behavior (`chosen =
 * max(ratios, key=ratios.get)`, recovered via `git show
 * 55c4a6f:scripts/extract_boundaries_europe.py`), not a newly invented
 * rule.
 *
 * A country's `region` and `city` lists in `COUNTRY_ADMIN_LEVELS` are
 * already disjoint by construction (a hand-reviewable, per-country data
 * table, not a shared worldwide range), so unlike an earlier version of
 * this function there is no exclusion parameter to thread through -- the
 * same polygons can never accidentally end up eligible for both roles.
 *
 * `resolveRegion`, when given, decides `primaryIds` membership for a
 * region with its own `overrides` entry differently: such a region
 * ignores this function's area vote (and the country's `chosen` level)
 * entirely -- only the *first* level in its own `[primary, ...gapFill]`
 * list is primary here, unconditionally, no threshold, no competition
 * with the country-wide level. A candidate at one of that region's later
 * (gap-fill) levels is deliberately left out of `primaryIds` by this
 * function -- `detectGapFill` is what promotes those, region-scoped, the
 * same "not covered by any primary" rule it already applies country-
 * wide. See `CountryAdminLevels.overrides`'s doc comment for why this
 * primary-then-gap-fill order matters -- both a flat country-wide
 * multi-level `city` list and a flat "every override level is primary"
 * design were tried and caused real regressions (README's "New York"
 * entry has the measurements). */
export function selectPrimaryLevels(
  index: AdminBoundaryIndex,
  countries: CountryIndex,
  threshold = DEFAULT_COVERAGE_THRESHOLD,
  resolveRegion?: (candidate: CityCandidateMeta) => string | null,
): PrimaryLevelResult {
  const primaryLevelByCountry = new Map<string, number>();

  for (const [country, byLevel] of index.areaByCountryLevel) {
    const countryArea = countries.areaByCode.get(country);
    if (!countryArea) continue;
    const candidateLevels = [...(COUNTRY_ADMIN_LEVELS[country]?.city ?? [])].sort((a, b) => b - a);

    let chosen: number | undefined;
    for (const level of candidateLevels) {
      const levelArea = byLevel.get(level);
      if (levelArea !== undefined && levelArea / countryArea >= threshold) {
        chosen = level;
        break;
      }
    }
    if (chosen === undefined) {
      let bestLevel: number | undefined;
      let bestRatio = -Infinity;
      for (const level of candidateLevels) {
        const levelArea = byLevel.get(level);
        if (levelArea === undefined) continue;
        const ratio = levelArea / countryArea;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestLevel = level;
        }
      }
      chosen = bestLevel;
    }
    if (chosen !== undefined) primaryLevelByCountry.set(country, chosen);
  }

  const primaryIds = new Set<string>();
  for (const candidate of index.cityCandidates) {
    const overrides = COUNTRY_ADMIN_LEVELS[candidate.country]?.overrides;
    const region = overrides && resolveRegion ? resolveRegion(candidate) : null;
    const overrideLevels = region ? overrides![region] : undefined;
    if (overrideLevels) {
      // An overridden region never falls through to the country-wide
      // level, even for a candidate at a level the override doesn't list
      // at all -- such a candidate simply isn't primary here (it can
      // never gap-fill either; see detectGapFill). Only the region's own
      // first (primary) level is added here -- a later, gap-fill-only
      // level in the same list is intentionally excluded from
      // primaryIds, even for a candidate that matches it exactly.
      if (overrideLevels[0] === candidate.level) primaryIds.add(candidate.id);
      // A whole unit sits at a *later* (gap-fill) level in the list, so the
      // line above doesn't catch it -- promoted by name instead.
      else if (isWholeUnit(candidate, region!)) primaryIds.add(candidate.id);
    } else if (primaryLevelByCountry.get(candidate.country) === candidate.level) {
      primaryIds.add(candidate.id);
    }
  }

  console.error(
    `selectPrimaryLevels: ${primaryLevelByCountry.size} countries assigned a primary level, ` +
      `${primaryIds.size} primary cities`,
  );
  return { primaryLevelByCountry, primaryIds };
}

function isWholeUnit(candidate: CityCandidateMeta, region: string): boolean {
  const unit = COUNTRY_ADMIN_LEVELS[candidate.country]?.wholeUnits?.[region];
  return !!unit && unit.level === candidate.level && candidate.name !== undefined && unit.names.includes(candidate.name);
}

export interface PrimaryGeometryItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  feature: Feature<Polygon | MultiPolygon>;
}

export interface PrimaryGeometryIndex {
  tree: RBush<PrimaryGeometryItem>;
  byId: Map<string, Feature<Polygon | MultiPolygon>>;
}

/** Second full streaming pass over the merged corpus: keeps real,
 * unsimplified geometry only for `id ∈ primaryIds` (cities are the
 * precision-critical layer -- same principle `prepare-europe.ts` already
 * documents for why they're never simplified). Guards peak memory with a
 * live RSS check every `RSS_CHECK_INTERVAL` kept records, failing fast
 * with an actionable message instead of repeating the original Python
 * pipeline's whole-machine OOM (README.md's "Europe scaling test", bug 1).
 * If this ever trips, call it again with a `primaryIds` subset restricted
 * to a handful of countries at a time (using `AdminBoundaryIndex`'s
 * per-country candidate counts to pick batches) -- trading wall-clock for
 * memory without touching Pass 1 or the output shape. */
export async function loadPrimaryGeometries(
  files: string[],
  primaryIds: Set<string>,
  opts: { memoryCeilingBytes?: number } = {},
): Promise<PrimaryGeometryIndex> {
  const memoryCeilingBytes = opts.memoryCeilingBytes ?? DEFAULT_MEMORY_CEILING_BYTES;
  const items: PrimaryGeometryItem[] = [];
  const byId = new Map<string, Feature<Polygon | MultiPolygon>>();
  let kept = 0;

  for await (const { id, feature } of streamMergedAdminBoundaries(files)) {
    if (!primaryIds.has(id)) continue;
    const geometry = feature as Feature<Polygon | MultiPolygon>;
    const [minX, minY, maxX, maxY] = bbox(geometry);
    items.push({ minX, minY, maxX, maxY, id, feature: geometry });
    byId.set(id, geometry);
    kept++;

    if (kept % RSS_CHECK_INTERVAL === 0) {
      const rss = process.memoryUsage().rss;
      if (rss > memoryCeilingBytes) {
        throw new Error(
          `loadPrimaryGeometries: RSS ${(rss / 1024 ** 3).toFixed(1)}GB exceeded the ` +
            `${(memoryCeilingBytes / 1024 ** 3).toFixed(1)}GB ceiling after ${kept}/${primaryIds.size} primary ` +
            `geometries. Retry with a primaryIds subset restricted to fewer countries at a time.`,
        );
      }
    }
  }

  const tree = new RBush<PrimaryGeometryItem>();
  tree.load(items);
  console.error(`loadPrimaryGeometries: loaded ${kept}/${primaryIds.size} primary geometries`);
  return { tree, byId };
}

/** Pass 3: re-scans every non-primary city candidate and adds it as a
 * gap-fill only if nothing in the primary set covers its representative
 * point -- the literal README rule ("an ordinary Kreis's point falls
 * inside one of its own child Gemeinden, already covered -> skipped; a
 * kreisfreie Stadt's point falls inside nothing at all -> added"). Runs
 * entirely over Pass 1's already-collected `cityCandidates` metadata (no
 * additional file I/O) plus Pass 2's in-memory primary geometry index --
 * both are already exactly the data this test needs.
 *
 * `cityCandidates` contains every level any of a country's regions is
 * allowed to use -- the country's own `city` list *and* every level any
 * region's `overrides` list names, flattened (`adminBoundaryIndex.ts`'s
 * Pass 1, which can't yet know which region a given candidate belongs
 * to). Left unfiltered, that means a level meant only for one region (New
 * York's `[8, 7]`) shows up as an ordinary candidate everywhere else in
 * the same country too (an Arkansas level-7 township, say) -- uncovered
 * by any Arkansas level-8 primary on its own account, so it would
 * wrongly gap-fill in as if Arkansas also used level 7, contesting cells
 * against real level-8 towns it geographically contains (see README's
 * "New York" entry for the exact regression this caused before
 * `resolveRegion` was added here). `resolveRegion`, when given, excludes
 * exactly that case: a candidate whose own level is *some* region's
 * override level, but doesn't appear anywhere in the override list of
 * the region it itself resolves to, is skipped entirely -- neither
 * primary (already excluded by `selectPrimaryLevels`, which only ever
 * marks a region's *first* override level primary) nor gap-fill. A
 * candidate at a level that IS in its own region's list, but not first
 * (New York's level 7, behind its own primary level 8), reaches the
 * ordinary point-in-polygon check below exactly like any other gap-fill
 * candidate -- covered by a level-8 village -> skipped, not covered ->
 * added, the same rule, just correctly scoped to compete only against
 * that region's own primary set, never a peer region's or the country's.
 * A candidate at a plain country-level (never listed in any override) is
 * never affected by this check. */
export function detectGapFill(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  primaryGeom: PrimaryGeometryIndex,
  countries?: ReadonlySet<string> | undefined,
  resolveRegion?: (candidate: CityCandidateMeta) => string | null,
): CityCandidateMeta[] {
  const gapFill: CityCandidateMeta[] = [];

  for (const candidate of index.cityCandidates) {
    // When primaries were loaded for only some countries, only those
    // countries' candidates can be judged: a candidate elsewhere would
    // find nothing covering it and be wrongly promoted to a gap-fill.
    // Restricting by country is sound because a candidate's
    // representative point can only fall inside a primary of its own
    // country.
    if (countries && !countries.has(candidate.country)) continue;
    if (primary.primaryIds.has(candidate.id)) continue;

    const overrides = COUNTRY_ADMIN_LEVELS[candidate.country]?.overrides;
    if (overrides) {
      const overrideLevelsInCountry = new Set(Object.values(overrides).flat());
      if (overrideLevelsInCountry.has(candidate.level)) {
        // This level only exists as a candidate at all because *some*
        // region in this country overrides to it -- only that region's
        // own candidates may gap-fill at it.
        const region = resolveRegion ? resolveRegion(candidate) : null;
        const ownOverride = region ? overrides[region] : undefined;
        if (!ownOverride?.includes(candidate.level)) continue;
      }
    }

    const [x, y] = candidate.repPoint;
    const hits = primaryGeom.tree.search({ minX: x, minY: y, maxX: x, maxY: y });
    let covered = false;
    for (const hit of hits) {
      if (booleanPointInPolygon(candidate.repPoint, hit.feature)) {
        covered = true;
        break;
      }
    }
    if (!covered) gapFill.push(candidate);
  }

  console.error(`detectGapFill: ${gapFill.length} gap-fill cities added on top of ${primary.primaryIds.size} primary`);
  return gapFill;
}

/** A small, targeted fourth pass: fetches full geometry for a specific id
 * set that Pass 1 only kept metadata for (the gap-fill cities detected
 * above). Primary cities never need this -- their geometry already sits in
 * `PrimaryGeometryIndex.byId` from Pass 2. */
export async function* fetchFinalGeometries(
  files: string[],
  ids: Set<string>,
): AsyncGenerator<{ id: string; feature: Feature<Polygon | MultiPolygon> }> {
  for await (const { id, feature } of streamMergedAdminBoundaries(files)) {
    if (ids.has(id)) yield { id, feature: feature as Feature<Polygon | MultiPolygon> };
  }
}

/** Ids of primary candidates to drop because a `wholeUnits` relation
 * contains them: every primary candidate of the same country, at any other
 * level, whose representative point lies inside a promoted whole unit
 * (`selectPrimaryLevels` put the unit itself in `primaryIds`). Needs the
 * batch's loaded primary geometry for the unit outline, so it runs per
 * batch, after `loadPrimaryGeometries`. `countries` restricts the scan to
 * the batch, same as `detectGapFill`. */
export function findSuppressedByWholeUnits(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  primaryGeom: PrimaryGeometryIndex,
  countries?: ReadonlySet<string> | undefined,
  resolveRegion?: (candidate: CityCandidateMeta) => string | null,
): Set<string> {
  const suppressed = new Set<string>();
  if (!resolveRegion) return suppressed;

  const units: { candidate: CityCandidateMeta; feature: Feature<Polygon | MultiPolygon> }[] = [];
  for (const candidate of index.cityCandidates) {
    if (countries && !countries.has(candidate.country)) continue;
    if (!COUNTRY_ADMIN_LEVELS[candidate.country]?.wholeUnits) continue;
    if (!primary.primaryIds.has(candidate.id)) continue;
    const region = resolveRegion(candidate);
    if (!region || !isWholeUnit(candidate, region)) continue;
    const feature = primaryGeom.byId.get(candidate.id);
    if (feature) units.push({ candidate, feature });
  }
  if (units.length === 0) return suppressed;

  for (const candidate of index.cityCandidates) {
    if (!primary.primaryIds.has(candidate.id)) continue;
    for (const unit of units) {
      if (unit.candidate.country !== candidate.country || unit.candidate.id === candidate.id) continue;
      if (unit.candidate.level === candidate.level) continue;
      const [x, y] = candidate.repPoint;
      const [minX, minY, maxX, maxY] = unit.candidate.bbox;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (booleanPointInPolygon(candidate.repPoint, unit.feature)) {
        suppressed.add(candidate.id);
        break;
      }
    }
  }

  console.error(`findSuppressedByWholeUnits: ${units.length} whole units, ${suppressed.size} sub-units suppressed`);
  return suppressed;
}
