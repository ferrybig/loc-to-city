import bbox from "@turf/bbox";
import pointOnFeature from "@turf/point-on-feature";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.js";
import type { CountryIndex } from "./countryIndex.js";
import { streamMergedAdminBoundaries } from "./mergeAdminBoundaries.js";
import { resolvePolygonCountry } from "./polygonCountry.js";

const PLACE_SETTLEMENT_VALUES = new Set(["city", "town", "village"]);

// Same cheap worldwide prefilter adminBoundaryIndex.ts's Pass 1 uses --
// matches PLAUSIBLE_ADMIN_LEVELS there. Kept as its own constant (not
// imported) because the two serve different purposes that happen to
// currently agree: that one bounds what any country's COUNTRY_ADMIN_LEVELS
// entry could ever list; this one bounds what OSM's `place` tag could ever
// disambiguate between. Independent concerns, not meant to drift together
// automatically.
const PLAUSIBLE_ADMIN_LEVELS = new Set([4, 5, 6, 7, 8, 9, 10, 11]);

interface PlaceTagProps {
  admin_level?: string;
  name?: string;
  place?: string;
}

/** A single admin relation's metadata for this diagnostic -- deliberately
 * not `CityCandidateMeta`: that type only exists for relations whose level
 * already survived `adminBoundaryIndex.ts`'s `isCity` filter (a level the
 * country's *current* `COUNTRY_ADMIN_LEVELS` entry already lists), which
 * is exactly backwards for a tool whose job is finding levels that entry
 * is missing. This collects every plausible-admin_level relation,
 * independent of any country's current config. */
export interface PlaceTagCandidate {
  name: string;
  place: string | undefined;
  country: string;
  level: number;
  bbox: BBox;
}

/** Its own full streaming pass over the merged corpus (same source
 * `buildAdminBoundaryIndex` reads), collecting just enough metadata to run
 * `findPlaceTagMismatches` -- independent of `COUNTRY_ADMIN_LEVELS`, since
 * narrowing by a country's *current* city levels would hide exactly the
 * levels this diagnostic exists to surface. No area/geometry kept beyond a
 * bbox -- this never feeds a build, only a human-reviewed report. */
export async function collectPlaceTagCandidates(
  files: string[],
  countries: CountryIndex,
): Promise<PlaceTagCandidate[]> {
  const candidates: PlaceTagCandidate[] = [];
  for await (const { feature } of streamMergedAdminBoundaries(files)) {
    const props = feature.properties as PlaceTagProps | null;
    const levelRaw = props?.admin_level;
    const name = props?.name;
    if (!levelRaw || !name) continue;
    const level = Number(levelRaw);
    if (!PLAUSIBLE_ADMIN_LEVELS.has(level)) continue;

    const geometry = feature as Feature<Polygon | MultiPolygon>;
    const [repX, repY] = pointOnFeature(geometry).geometry.coordinates;
    const featureBbox = bbox(geometry);
    const country = resolvePolygonCountry(geometry, featureBbox, [repX ?? 0, repY ?? 0], countries);
    if (!country) continue;

    candidates.push({ name, place: props?.place, country, level, bbox: featureBbox });
  }
  return candidates;
}

/** A group of same-(country,name) candidate relations at more than one
 * admin_level, where OSM's `place` tag settles which level is "the real
 * settlement" -- the disambiguation signal README.md's "Known issues"
 * describes (place=city/town/village was rejected as a geometry source,
 * since 98.5% of matches are bare label nodes with no polygon at all, but
 * kept as a tie-break: Bremen's real city relation is `admin_level=6`
 * `place=city`, distinct from the `admin_level=4` Land with no `place` tag
 * that the country-wide level vote would otherwise pick alone). */
export interface PlaceTagMismatch {
  country: string;
  name: string;
  /** The admin_level OSM's place=city/town/village tag points to. */
  placeLevel: number;
  place: string;
  /** Every other admin_level a same-(country,name) candidate exists at,
   * none of which carry a settlement place tag -- typically a coarser
   * container (Bremen's Land) that the plain area vote would otherwise
   * prefer, or a finer subdivision gap-fill already reaches. */
  otherLevels: number[];
  /** The level `COUNTRY_ADMIN_LEVELS[country].city` (or a listed region
   * override's own primary) currently resolves this country to -- absent
   * when the country has no configured city level at all. undefined also
   * when the candidate sits in a region with its own `overrides` entry:
   * this function has no region geometry to resolve against, so it leaves
   * region-scoped countries for manual review rather than risk a false
   * mismatch report (see `hasRegionOverrides`). */
  configuredCityLevel: number | undefined;
  /** True when `placeLevel` is not among the levels this country's
   * current config would ever select as a city (primary or gap-fill) --
   * the actionable case, same shape as the Bremen fix (add placeLevel as
   * a gap-fill level, or replace configuredCityLevel with it). */
  isMismatch: boolean;
}

function bboxCenter(bbox: BBox): [number, number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

// Same-(country,name) candidates at different levels are only ever the
// same real-world settlement when their footprints actually overlap --
// two unrelated villages sharing a name within one large country are rare
// but real (the real corpus has several unrelated US/DE "Bremen"s at the
// same level, which the (country,name) key alone can't tell apart). A
// generous distance gate on bbox centers is enough to reject those without
// needing real polygon-in-polygon containment, which this diagnostic
// deliberately doesn't keep full geometry for (see `PlaceTagCandidate`).
const MAX_CENTER_DISTANCE_DEGREES = 0.5; // ~55km at the equator

function sameSettlement(a: PlaceTagCandidate, b: PlaceTagCandidate): boolean {
  const [ax, ay] = bboxCenter(a.bbox);
  const [bx, by] = bboxCenter(b.bbox);
  return Math.hypot(ax - bx, ay - by) <= MAX_CENTER_DISTANCE_DEGREES;
}

/** A country where any region has its own `overrides` entry -- this
 * function only has country-wide config to compare against (no region
 * geometry available at this stage), so such a country's candidates are
 * left out of `isMismatch` scoring entirely rather than risk a false
 * positive against a region-scoped level list (e.g. flagging New York's
 * own level-8 villages against the US's plain level-8 `city` entry would
 * happen to agree, but Wales/GB's level-6 override would not, purely by
 * accident of which region a candidate falls in). */
function hasRegionOverrides(country: string): boolean {
  const overrides = COUNTRY_ADMIN_LEVELS[country]?.overrides;
  return !!overrides && Object.keys(overrides).length > 0;
}

/** Every level this country's plain (non-override) config would accept as
 * a city, whether as the area-vote primary or a listed gap-fill level --
 * `COUNTRY_ADMIN_LEVELS[country].city` already lists both in one array
 * (see that file's own doc comment), so no separate primary/gap-fill
 * distinction is needed here. */
function configuredCityLevels(country: string): number[] {
  return COUNTRY_ADMIN_LEVELS[country]?.city ?? [];
}

/** Scans `candidates` (`collectPlaceTagCandidates`'s output -- every
 * plausible-admin_level relation, independent of any country's current
 * `COUNTRY_ADMIN_LEVELS` entry) for settlements with a candidate at more
 * than one admin_level, where OSM's `place` tag names exactly one of those
 * levels a real city/town/village. Pure, build-independent diagnostic:
 * never changes `COUNTRY_ADMIN_LEVELS` or any build output by itself -- a
 * human reviews `isMismatch` entries and decides whether to add an
 * override, the same workflow that found Bremen's fix. */
export function findPlaceTagMismatches(candidates: readonly PlaceTagCandidate[]): PlaceTagMismatch[] {
  const byCountryName = new Map<string, PlaceTagCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.name) continue;
    const key = `${candidate.country}\u0000${candidate.name}`;
    let group = byCountryName.get(key);
    if (!group) {
      group = [];
      byCountryName.set(key, group);
    }
    group.push(candidate);
  }

  const mismatches: PlaceTagMismatch[] = [];
  for (const group of byCountryName.values()) {
    if (group.length < 2) continue;
    const levels = new Set(group.map((c) => c.level));
    if (levels.size < 2) continue; // same level -> not an admin_level ambiguity

    const placeTagged = group.filter((c) => c.place && PLACE_SETTLEMENT_VALUES.has(c.place));
    if (placeTagged.length === 0) continue;
    const placeLevels = new Set(placeTagged.map((c) => c.level));
    if (placeLevels.size !== 1) continue; // ambiguous even with the place tag -- not actionable here

    const settlement = placeTagged[0];
    if (!settlement) continue; // placeLevels.size === 1 guarantees this, satisfies noUncheckedIndexedAccess
    const related = group.filter((c) => sameSettlement(c, settlement));
    if (related.length < 2) continue; // the place-tagged one and its "other level" are unrelated footprints

    const otherLevels = [...new Set(related.filter((c) => c.level !== settlement.level).map((c) => c.level))].sort(
      (a, b) => a - b,
    );
    if (otherLevels.length === 0) continue;

    const country = settlement.country;
    const configured = hasRegionOverrides(country) ? undefined : configuredCityLevels(country);
    const configuredCityLevel = configured?.[0];
    const isMismatch = configured !== undefined && !configured.includes(settlement.level);

    mismatches.push({
      country,
      name: settlement.name!,
      placeLevel: settlement.level,
      place: settlement.place!,
      otherLevels,
      configuredCityLevel,
      isMismatch,
    });
  }

  return mismatches.sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));
}
