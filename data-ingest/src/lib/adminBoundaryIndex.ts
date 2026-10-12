import area from "@turf/area";
import simplify from "@turf/simplify";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.ts";
import type { CountryIndex } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";
import { streamMergedAdminBoundaries } from "./mergeAdminBoundaries.ts";
import { bboxAndPointOnFeature } from "./pointOnFeature.ts";
import { resolvePolygonCountry } from "./polygonCountry.ts";

// Matches prepare-europe.ts's REGION_SIMPLIFY_TOLERANCE: regions are a
// fallback layer, not precision-critical the way cities are, and holding
// thousands of full-precision multipolygons across the whole run would be
// wasted memory for geometry that's simplified before output anyway.
const REGION_SIMPLIFY_TOLERANCE = 0.01; // ~1.1km

// A cheap, purely worldwide (not per-country) prefilter, applied before
// the country is even known: any admin_level outside this range is never
// used as a region or city candidate by *any* country's entry in
// COUNTRY_ADMIN_LEVELS, so there's no reason to pay for country
// resolution on it. This is not itself a source of per-country coupling
// -- it only decides whether a feature is worth resolving at all, never
// which role it plays once resolved (that's COUNTRY_ADMIN_LEVELS, purely
// per-country, see there for why that separation matters).
const PLAUSIBLE_ADMIN_LEVELS = new Set([4, 5, 6, 7, 8, 9, 10, 11]);
// Levels any country ever uses as a *region* candidate -- used only to
// decide `resolvePolygonCountry`'s sampling care (regions matter more to
// get right than an ordinary city), not to decide role or acceptance.
const REGION_SAMPLE_LEVELS = new Set([4, 5, 6]);

/** Every level any of this country's region `overrides` lists, flattened
 * -- a level here needs to survive Pass 1's `isCity` test even when it's
 * absent from the country-wide `city` list, since a candidate's region
 * (and therefore whether an override applies to it) isn't known until
 * later. */
function overrideLevels(levels: { overrides?: Record<string, number[]> } | undefined): number[] {
  if (!levels?.overrides) return [];
  return Object.values(levels.overrides).flat();
}

const overrideLevelsByCountry = new Map<string, number[]>();
function cachedOverrideLevels(country: string): number[] {
  let levels = overrideLevelsByCountry.get(country);
  if (!levels) {
    levels = overrideLevels(COUNTRY_ADMIN_LEVELS[country]);
    overrideLevelsByCountry.set(country, levels);
  }
  return levels;
}

export interface CityCandidateMeta {
  id: string;
  /** Undefined for unnamed relations -- kept (not dropped) here since Pass
   * 1's area accumulation shouldn't be skewed by name availability; final
   * assembly in prepare-world.ts drops nameless survivors, mirroring
   * prepare-europe.ts's own null-name filtering. */
  name: string | undefined;
  /** OSM's `name:en` tag, when present (README.md's "International/local
   * name pairs" item). Purely a display addition -- never part of any
   * join/dedup key, so it can be missing or inconsistent without affecting
   * matching. */
  nameEn: string | undefined;
  country: string;
  level: number;
  area: number;
  repPoint: LonLat;
  bbox: BBox;
}

export interface RegionCandidate {
  id: string;
  name: string;
  /** OSM's `name:en` tag, when present -- see CityCandidateMeta.nameEn. */
  nameEn: string | undefined;
  country: string;
  /** The admin_level this candidate was tagged at. A country's own
   * COUNTRY_ADMIN_LEVELS entry keeps its region and city level lists
   * disjoint, so unlike before this never needs cross-checking against
   * what a *different* country does with the same level number. */
  level: number;
  bbox: BBox;
  feature: Feature<Polygon | MultiPolygon, { name?: string }>;
}

export interface AdminBoundaryIndexDiagnostics {
  scanned: number;
  keptCity: number;
  keptRegion: number;
  noCountry: number;
}

export interface AdminBoundaryIndex {
  cityCandidates: CityCandidateMeta[];
  /** Pass 1's area accumulation: country -> admin_level -> total area (km^2),
   * for whichever levels that country's own COUNTRY_ADMIN_LEVELS.city
   * lists. `selectPrimaryLevels` picks the best of just those levels. */
  areaByCountryLevel: Map<string, Map<number, number>>;
  /** Same accumulation, for each country's own COUNTRY_ADMIN_LEVELS.region
   * list -- `selectRegionLevels` picks the best of just those levels. */
  regionAreaByCountryLevel: Map<string, Map<number, number>>;
  /** Final region polygons, deduped by (country, level, name) -- prefers
   * the larger bbox on a genuine duplicate/fragmentary match, same rule
   * `prepare-europe.ts`'s `extractRegionPolygons` already uses. Unlike
   * that function, country is resolved directly per relation (via
   * `resolvePolygonCountry`), not reverse-engineered from a pre-resolved
   * cities list -- there is no such list at world scale. Includes every
   * level in a country's own `region` list, not just the level that ends
   * up winning; callers filter by `selectRegionLevels`'s result before
   * using these as the final region layer. */
  regionsByCountryName: Map<string, RegionCandidate>;
  diagnostics: AdminBoundaryIndexDiagnostics;
}

interface AdminBoundaryProps {
  admin_level?: string;
  name?: string;
  "name:en"?: string;
  natural?: string;
}

/** Pass 1 of the 3-pass admin_level auto-detection (README.md's "Europe
 * scaling test"): one full streaming read of the merged, deduplicated
 * corpus, computing just enough per candidate relation (area,
 * representative point, bbox, resolved country) to run Pass 2/3's
 * selection logic without holding any full polygon geometry -- memory
 * bounded by candidate *count*, not corpus size.
 *
 * Which role a feature plays (region candidate, city candidate, neither,
 * or -- at a level a country lists for both roles independently -- both)
 * is decided per country from `COUNTRY_ADMIN_LEVELS`, looked up only
 * after the country itself is resolved; `PLAUSIBLE_ADMIN_LEVELS` is just
 * a cheap, country-agnostic prefilter so country resolution -- the
 * expensive part -- is never attempted on a level nothing anywhere
 * uses.
 *
 * `outlineAt` places what Natural Earth places nowhere (see
 * `resolvePolygonCountry`). */
export async function buildAdminBoundaryIndex(
  files: string[],
  countries: CountryIndex,
  outlineAt?: (point: LonLat) => string | null,
): Promise<AdminBoundaryIndex> {
  const cityCandidates: CityCandidateMeta[] = [];
  const areaByCountryLevel = new Map<string, Map<number, number>>();
  const regionAreaByCountryLevel = new Map<string, Map<number, number>>();
  const regionsByCountryName = new Map<string, RegionCandidate>();
  const diagnostics: AdminBoundaryIndexDiagnostics = { scanned: 0, keptCity: 0, keptRegion: 0, noCountry: 0 };

  for await (const { id, feature } of streamMergedAdminBoundaries(files)) {
    diagnostics.scanned++;
    if (diagnostics.scanned % 500_000 === 0) {
      console.error(
        `adminBoundaryIndex: ${diagnostics.scanned} scanned, ${diagnostics.keptCity} city candidates, ` +
          `${diagnostics.keptRegion} region candidates, ${diagnostics.noCountry} no-country`,
      );
    }

    const props = feature.properties as AdminBoundaryProps | null;
    const levelRaw = props?.admin_level;
    if (!levelRaw) continue;
    const level = Number(levelRaw);
    if (!PLAUSIBLE_ADMIN_LEVELS.has(level)) continue;
    // An island's coastline multipolygon with admin tags added (Penghu's
    // islets at admin_level=4, Indonesia's at 5), not an administrative
    // unit. Worldwide that is 143 named region candidates and 1,103 city
    // candidates, all of them islands, islets or skerries by name; as a
    // region each became a "province" of its country.
    if (props?.natural === "coastline") continue;

    const geometry = feature as Feature<Polygon | MultiPolygon>;
    // Still needed as a point known to lie on the feature (gap-fill and
    // region assignment test it for containment), but no longer trusted
    // to say which country the feature is in -- see polygonCountry.ts.
    const { bbox: featureBbox, repPoint } = bboxAndPointOnFeature(geometry.geometry);
    const country = resolvePolygonCountry(geometry, featureBbox, repPoint, countries, {
      alwaysSample: REGION_SAMPLE_LEVELS.has(level),
      ...(outlineAt ? { outlineAt } : {}),
    });
    if (!country) {
      diagnostics.noCountry++;
      continue;
    }

    const levels = COUNTRY_ADMIN_LEVELS[country];
    // A superset check: a level that's only an override level for one of
    // this country's regions (not in the country-wide `city` list) still
    // needs to survive Pass 1, since which region a candidate belongs to
    // isn't known until regions are resolved, later in prepare-world.ts.
    // Routing a surviving candidate to its actual region/level (override
    // vs. country-wide) happens there, not here.
    const isCity = (levels?.city.includes(level) ?? false) || cachedOverrideLevels(country).includes(level);
    const isRegionLevel = levels?.region.includes(level) ?? false;
    if (!isCity && !isRegionLevel) continue;

    // Computed at most once, though a level a country lists for both roles
    // needs it twice.
    let areaKm2: number | undefined;
    const getFeatureArea = (): number => (areaKm2 ??= area(geometry) / 1_000_000); // m^2 -> km^2

    if (isCity) {
      const featureArea = getFeatureArea();
      cityCandidates.push({
        id,
        name: props?.name,
        nameEn: props?.["name:en"],
        country,
        level,
        area: featureArea,
        repPoint,
        bbox: featureBbox,
      });
      // Area accumulates here only for the country-wide `city` vote --
      // an override-only level (a candidate that survived solely because
      // some region's override list includes it) never competes for the
      // country's own primary level, so it's excluded from this tally.
      // `cityCandidates` above still holds it either way; routing happens
      // once each candidate's region is known, in prepare-world.ts.
      if (levels?.city.includes(level)) {
        let byLevel = areaByCountryLevel.get(country);
        if (!byLevel) {
          byLevel = new Map();
          areaByCountryLevel.set(country, byLevel);
        }
        byLevel.set(level, (byLevel.get(level) ?? 0) + featureArea);
      }
      diagnostics.keptCity++;
    }

    if (!isRegionLevel) continue;
    const name = props?.name;
    if (!name) continue;
    const regionArea = getFeatureArea();
    let regionByLevel = regionAreaByCountryLevel.get(country);
    if (!regionByLevel) {
      regionByLevel = new Map();
      regionAreaByCountryLevel.set(country, regionByLevel);
    }
    regionByLevel.set(level, (regionByLevel.get(level) ?? 0) + regionArea);

    const key = `${country} ${level} ${name}`;
    const existing = regionsByCountryName.get(key);
    if (!existing || bboxArea(featureBbox) > bboxArea(existing.bbox)) {
      const simplified = simplify(geometry, { tolerance: REGION_SIMPLIFY_TOLERANCE });
      regionsByCountryName.set(key, {
        id,
        name,
        nameEn: props?.["name:en"],
        country,
        level,
        bbox: featureBbox,
        feature: { ...simplified, properties: { name } },
      });
    }
    diagnostics.keptRegion++;
  }

  console.error(
    `adminBoundaryIndex: done -- ${diagnostics.scanned} scanned, ${diagnostics.keptCity} city candidates, ` +
      `${diagnostics.keptRegion} region matches (${regionsByCountryName.size} unique), ${diagnostics.noCountry} no-country`,
  );

  return { cityCandidates, areaByCountryLevel, regionAreaByCountryLevel, regionsByCountryName, diagnostics };
}

function bboxArea(b: BBox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
