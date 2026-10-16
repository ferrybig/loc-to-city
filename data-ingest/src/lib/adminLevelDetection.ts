import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import RBush from "rbush";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { AdminBoundaryIndex, CityCandidateMeta } from "./adminBoundaryIndex.ts";
import type { LonLat } from "./geo.ts";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.ts";
import type { CountryIndex } from "./countryIndex.ts";
import { splitOsmiumFeature } from "./geojsonseqStream.ts";
import { streamMergedAdminRecords } from "./mergeAdminBoundaries.ts";
import { preparePolygon } from "./preparedPolygon.ts";
import { coverGrid, uncoveredKm2 } from "./coverageGrid.ts";

/** Uncovered area (km^2) from which a `coverageGapFill` candidate is added. */
export const MIN_UNCOVERED_KM2 = 3;
/** A level-6 county is not a city when finer candidates of the country tile
 * at least this share of its area (by bbox containment, a cheap stand-in). */
const TILED_BY_FINER_SHARE = 0.5;

const DEFAULT_COVERAGE_THRESHOLD = 0.6;

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
 * function -- `createGapFillTracker` is what promotes those, region-scoped, the
 * same "not covered by any primary" rule it already applies country-
 * wide. See `CountryAdminLevels.overrides`'s doc comment for why this
 * primary-then-gap-fill order matters -- both a flat country-wide
 * multi-level `city` list and a flat "every override level is primary"
 * design were tried and caused real regressions (countries.md's United States
 * section has the measurements). */
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

    // A pinned level skips the vote (`CountryAdminLevels.primaryLevel`).
    let chosen: number | undefined = COUNTRY_ADMIN_LEVELS[country]?.primaryLevel;
    if (chosen === undefined) {
      for (const level of candidateLevels) {
        const levelArea = byLevel.get(level);
        if (levelArea !== undefined && levelArea / countryArea >= threshold) {
          chosen = level;
          break;
        }
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
      // never gap-fill either; see createGapFillTracker). Only the region's own
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

interface GapFillPoint {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  candidate: CityCandidateMeta;
  covered: boolean;
}

/** Pass 3's bookkeeping: every gap-fill-eligible candidate's
 * representative point, indexed, waiting to be covered by a primary. */
export interface GapFillTracker {
  /** The primaries `observePrimary` expects to see, by id. */
  primaryById: Map<string, CityCandidateMeta>;
  /** Marks every eligible point of the primary's own country that its
   * geometry covers. `geometry` is only called when some still-uncovered
   * point falls in the primary's bbox -- most primaries never need theirs
   * parsed at all. */
  observePrimary(primary: CityCandidateMeta, geometry: () => Polygon | MultiPolygon): void;
  /** Candidates no observed primary covered, in `cityCandidates` order. */
  gapFill(): CityCandidateMeta[];
}

/** Pass 3: re-scans every non-primary city candidate and adds it as a
 * gap-fill only if nothing in the primary set covers its representative
 * point -- the literal README rule ("an ordinary Kreis's point falls
 * inside one of its own child Gemeinden, already covered -> skipped; a
 * kreisfreie Stadt's point falls inside nothing at all -> added").
 *
 * Primaries are fed in one at a time (`observePrimary`, from
 * `streamPrimaries`) against an index of the candidates' points, instead
 * of indexing every primary polygon and probing it per candidate. The
 * answer is the same -- covered by *some* primary or not -- but no primary
 * geometry has to be held: holding it took batching the world by country
 * (~19GB for ~295k primaries otherwise) and one more full corpus read per
 * batch.
 *
 * Only a primary of the candidate's own country can cover it. A border
 * municipality's polygon routinely reaches over the line (rivers,
 * enclaves, slightly misaligned outlines), and the old batched pass let it
 * cover a neighbour's candidate only when both countries happened to share
 * a batch.
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
 * against real level-8 towns it geographically contains (see countries.md's
 * United States section for the exact regression this caused before
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
/** The point a coverage test checks a candidate by: strictly inside it.
 * `repPoint` can be a boundary vertex, which a neighbour on the other side
 * contains too (point-in-polygon counts the boundary), and then covered
 * the candidate: Bremen's vertex on the Lesum is Ritterhude's too, and
 * that level-8 Lower Saxony municipality kept Bremen's level-6 city out
 * of the gap-fill. */
function insidePoint(candidate: CityCandidateMeta): LonLat {
  return candidate.regionPoint ?? candidate.repPoint;
}

export function createGapFillTracker(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  resolveRegion?: (candidate: CityCandidateMeta) => string | null,
): GapFillTracker {
  const primaryById = new Map<string, CityCandidateMeta>();
  const points: GapFillPoint[] = [];
  const overrideLevelsByCountry = new Map<string, Set<number>>();
  const coverageCandidates: CityCandidateMeta[] = [];

  for (const candidate of index.cityCandidates) {
    if (primary.primaryIds.has(candidate.id)) {
      primaryById.set(candidate.id, candidate);
      continue;
    }

    const overrides = COUNTRY_ADMIN_LEVELS[candidate.country]?.overrides;
    if (overrides) {
      let overrideLevelsInCountry = overrideLevelsByCountry.get(candidate.country);
      if (!overrideLevelsInCountry) {
        overrideLevelsInCountry = new Set(Object.values(overrides).flat());
        overrideLevelsByCountry.set(candidate.country, overrideLevelsInCountry);
      }
      if (overrideLevelsInCountry.has(candidate.level)) {
        // This level only exists as a candidate at all because *some*
        // region in this country overrides to it -- only that region's
        // own candidates may gap-fill at it.
        const region = resolveRegion ? resolveRegion(candidate) : null;
        const ownOverride = region ? overrides[region] : undefined;
        if (!ownOverride?.includes(candidate.level)) continue;
      }
    }

    if (candidate.coverage) {
      coverageCandidates.push(candidate);
      continue;
    }
    const [x, y] = insidePoint(candidate);
    points.push({ minX: x, minY: y, maxX: x, maxY: y, candidate, covered: false });
  }

  const tree = new RBush<GapFillPoint>();
  tree.load(points);

  // `coverageGapFill` candidates: judged by uncovered area instead (see
  // `CountryAdminLevels.coverageGapFill`). A county that finer candidates
  // tile (Hampshire = its districts) is no city: its uncovered land is
  // already some district's, and left in it would only name slivers.
  const finerArea = (candidate: CityCandidateMeta): number => {
    const [minX, minY, maxX, maxY] = candidate.bbox;
    let total = 0;
    for (const other of index.cityCandidates) {
      if (other.country !== candidate.country || other.level <= candidate.level) continue;
      if (!COUNTRY_ADMIN_LEVELS[other.country]?.coverageGapFill?.includes(other.level)) continue;
      const [x0, y0, x1, y1] = other.bbox;
      if (x0 >= minX && y0 >= minY && x1 <= maxX && y1 <= maxY) total += other.area;
    }
    return total;
  };
  const coverageTree = new RBush<{ minX: number; minY: number; maxX: number; maxY: number; candidate: CityCandidateMeta }>();
  const eligibleCoverage = coverageCandidates.filter((c) => finerArea(c) < TILED_BY_FINER_SHARE * c.area);
  coverageTree.load(
    eligibleCoverage.map((candidate) => ({
      minX: candidate.bbox[0],
      minY: candidate.bbox[1],
      maxX: candidate.bbox[2],
      maxY: candidate.bbox[3],
      candidate,
    })),
  );

  return {
    primaryById,
    observePrimary(primaryCandidate, parse) {
      let parsed: Polygon | MultiPolygon | undefined;
      const geometry = (): Polygon | MultiPolygon => (parsed ??= parse());
      const [minX, minY, maxX, maxY] = primaryCandidate.bbox;
      const grids = coverageTree
        .search({ minX, minY, maxX, maxY })
        .filter((g) => g.candidate.country === primaryCandidate.country);
      if (grids.length > 0) {
        const prepared = preparePolygon(geometry());
        for (const { candidate } of grids) {
          coverGrid(candidate.coverage!, candidate.bbox, prepared, primaryCandidate.bbox);
        }
      }
      const open = tree
        .search({ minX, minY, maxX, maxY })
        .filter((p) => !p.covered && p.candidate.country === primaryCandidate.country);
      if (open.length === 0) return;
      // One point is one walk over the polygon either way; more are worth
      // an index.
      const polygon = geometry();
      if (open.length === 1) {
        if (booleanPointInPolygon(insidePoint(open[0]!.candidate), polygon)) open[0]!.covered = true;
        return;
      }
      const prepared = preparePolygon(polygon);
      for (const point of open) {
        const [x, y] = insidePoint(point.candidate);
        if (prepared.contains(x, y)) point.covered = true;
      }
    },
    gapFill() {
      const byPoint = new Set(points.filter((p) => !p.covered).map((p) => p.candidate));
      const byCoverage = new Set(
        eligibleCoverage.filter((c) => uncoveredKm2(c.coverage!, c.bbox) >= MIN_UNCOVERED_KM2),
      );
      return index.cityCandidates.filter((c) => byPoint.has(c) || byCoverage.has(c));
    },
  };
}

/** Passes 2 and 3 in one streaming read: hands every primary in the
 * corpus to `tracker.observePrimary`, then to `onPrimary` with its
 * geometry's source text, and drops it. A primary's geometry is parsed
 * only if the tracker needs it for a coverage test; everything else in the
 * corpus is skipped by id without being parsed. Returns how many of the
 * expected primaries were found. */
export async function streamPrimaries(
  files: string[],
  tracker: GapFillTracker,
  onPrimary: (candidate: CityCandidateMeta, geometryJson: string) => Promise<void>,
): Promise<number> {
  let found = 0;
  let parsed = 0;
  for await (const { id, geometryJson } of streamGeometries(files, tracker.primaryById)) {
    const candidate = tracker.primaryById.get(id)!;
    found++;
    tracker.observePrimary(candidate, () => {
      parsed++;
      return JSON.parse(geometryJson) as Polygon | MultiPolygon;
    });
    await onPrimary(candidate, geometryJson);
  }
  console.error(
    `streamPrimaries: ${found}/${tracker.primaryById.size} primaries streamed, ${parsed} parsed for a coverage test`,
  );
  return found;
}

/** A small, targeted final pass: the geometry source text of just `ids`
 * (the gap-fill cities, which Pass 1 only kept metadata for), read without
 * parsing anything else -- and no read at all when there's nothing to
 * fetch. */
export async function* streamGeometries(
  files: string[],
  ids: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): AsyncGenerator<{ id: string; geometryJson: string }> {
  if (ids.size === 0) return;
  for await (const { id, record, parsed } of streamMergedAdminRecords(files)) {
    if (!ids.has(id)) continue;
    const geometryJson =
      (!parsed && splitOsmiumFeature(record)?.geometryJson) ||
      JSON.stringify((parsed ?? (JSON.parse(record.toString("utf8")) as Feature)).geometry);
    yield { id, geometryJson };
  }
}

/** The primaries that are `wholeUnits` relations (`selectPrimaryLevels`
 * promoted them by name). Few enough -- three in Wales -- that their
 * geometry can be loaded on its own, ahead of the main primary stream. */
export function selectWholeUnits(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  resolveRegion: (candidate: CityCandidateMeta) => string | null,
): CityCandidateMeta[] {
  const units: CityCandidateMeta[] = [];
  for (const candidate of index.cityCandidates) {
    if (!COUNTRY_ADMIN_LEVELS[candidate.country]?.wholeUnits) continue;
    if (!primary.primaryIds.has(candidate.id)) continue;
    const region = resolveRegion(candidate);
    if (region && isWholeUnit(candidate, region)) units.push(candidate);
  }
  return units;
}

/** Ids of primary candidates to drop because a `wholeUnits` relation
 * contains them: every primary candidate of the same country, at any other
 * level, whose point (`insidePoint`) lies inside a whole unit. Only the
 * units' own geometry is needed -- the candidates are tested by the
 * point their metadata already carries. */
export function suppressedByWholeUnits(
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  units: readonly { candidate: CityCandidateMeta; geometry: Polygon | MultiPolygon }[],
): Set<string> {
  const suppressed = new Set<string>();
  if (units.length === 0) return suppressed;

  for (const candidate of index.cityCandidates) {
    if (!primary.primaryIds.has(candidate.id)) continue;
    for (const unit of units) {
      if (unit.candidate.country !== candidate.country || unit.candidate.id === candidate.id) continue;
      if (unit.candidate.level === candidate.level) continue;
      const [x, y] = insidePoint(candidate);
      const [minX, minY, maxX, maxY] = unit.candidate.bbox;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (booleanPointInPolygon([x, y], unit.geometry)) {
        suppressed.add(candidate.id);
        break;
      }
    }
  }
  return suppressed;
}

/** `selectWholeUnits` + one targeted read for their geometry (none when
 * no country has any) + `suppressedByWholeUnits`.
 *
 * The same read also hands `alsoFetch`'s geometry to `onFetched`, for a
 * caller that wants a few other relations before the primaries stream
 * past (prepare-world.ts' within-region fallback containers). */
export async function findSuppressedByWholeUnits(
  files: string[],
  index: AdminBoundaryIndex,
  primary: PrimaryLevelResult,
  resolveRegion: (candidate: CityCandidateMeta) => string | null,
  alsoFetch: ReadonlySet<string> = new Set(),
  onFetched?: (id: string, geometryJson: string) => void,
): Promise<Set<string>> {
  const candidates = selectWholeUnits(index, primary, resolveRegion);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const wanted = new Set([...byId.keys(), ...alsoFetch]);
  const units: { candidate: CityCandidateMeta; geometry: Polygon | MultiPolygon }[] = [];
  for await (const { id, geometryJson } of streamGeometries(files, wanted)) {
    if (alsoFetch.has(id)) onFetched?.(id, geometryJson);
    const unit = byId.get(id);
    if (unit) units.push({ candidate: unit, geometry: JSON.parse(geometryJson) as Polygon | MultiPolygon });
  }
  const suppressed = suppressedByWholeUnits(index, primary, units);
  console.error(`findSuppressedByWholeUnits: ${units.length} whole units, ${suppressed.size} sub-units suppressed`);
  return suppressed;
}
