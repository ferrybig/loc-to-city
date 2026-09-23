import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import RBush from "rbush";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { AdminBoundaryIndex, CityCandidateMeta } from "./adminBoundaryIndex.js";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.js";
import type { CountryIndex } from "./countryIndex.js";
import { streamMergedAdminBoundaries } from "./mergeAdminBoundaries.js";

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
 * same polygons can never accidentally end up eligible for both roles. */
export function selectPrimaryLevels(
  index: AdminBoundaryIndex,
  countries: CountryIndex,
  threshold = DEFAULT_COVERAGE_THRESHOLD,
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
    if (primaryLevelByCountry.get(candidate.country) === candidate.level) primaryIds.add(candidate.id);
  }

  console.error(
    `selectPrimaryLevels: ${primaryLevelByCountry.size} countries assigned a primary level, ` +
      `${primaryIds.size} primary cities`,
  );
  return { primaryLevelByCountry, primaryIds };
}

interface PrimaryGeometryItem {
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
 * `cityCandidates` only ever contains levels a country's own
 * `COUNTRY_ADMIN_LEVELS` entry lists under `city` (see
 * `adminBoundaryIndex.ts`), so a level that instead won that country's
 * region vote was never added here in the first place -- no separate
 * exclusion is needed to keep it out of gap-fill. */
export function detectGapFill(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  primaryGeom: PrimaryGeometryIndex,
  countries?: ReadonlySet<string> | undefined,
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
