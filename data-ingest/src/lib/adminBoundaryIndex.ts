import area from "@turf/area";
import bbox from "@turf/bbox";
import pointOnFeature from "@turf/point-on-feature";
import simplify from "@turf/simplify";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import type { CountryIndex } from "./countryIndex.js";
import type { LonLat } from "./geo.js";
import { streamMergedAdminBoundaries } from "./mergeAdminBoundaries.js";
import { resolvePolygonCountry } from "./polygonCountry.js";

// Matches prepare-europe.ts's REGION_SIMPLIFY_TOLERANCE: regions are a
// fallback layer, not precision-critical the way cities are, and holding
// thousands of full-precision multipolygons across the whole run would be
// wasted memory for geometry that's simplified before output anyway.
const REGION_SIMPLIFY_TOLERANCE = 0.01; // ~1.1km

/** admin_level range the 3-pass algorithm ever considers as a candidate
 * "city" level (README.md's "Europe scaling test": Germany's kreisfreie
 * Städte at 6, Latvia at 7, most of Europe at 8, Poland's real level at 7,
 * the UK sometimes needing 10). */
export const CITY_CANDIDATE_LEVELS = [5, 6, 7, 8, 9, 10, 11] as const;
/** The admin_level treated as "region" (OSM's dominant convention for a
 * country's first-level subdivision) -- kept as a single fixed level
 * worldwide, same simplifying assumption `prepare-europe.ts` already made
 * for Europe. Countries with 0 matches here just get 0 regions and their
 * cities fall back to country-level resolution, the same graceful
 * degradation already exercised by Ireland/Estonia/Portugal in the Europe
 * build -- not attempting per-country region-level detection is a
 * deliberate scope decision, not an oversight. */
export const REGION_LEVEL = 4;

export interface CityCandidateMeta {
  id: string;
  /** Undefined for unnamed relations -- kept (not dropped) here since Pass
   * 1's area accumulation shouldn't be skewed by name availability; final
   * assembly in prepare-world.ts drops nameless survivors, mirroring
   * prepare-europe.ts's own null-name filtering. */
  name: string | undefined;
  country: string;
  level: number;
  area: number;
  repPoint: LonLat;
  bbox: BBox;
}

export interface RegionCandidate {
  id: string;
  name: string;
  country: string;
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
  /** Pass 1's area accumulation: country -> admin_level -> total area (km^2). */
  areaByCountryLevel: Map<string, Map<number, number>>;
  /** Final region polygons, deduped by (country, name) -- prefers the
   * larger bbox on a genuine duplicate/fragmentary match, same rule
   * `prepare-europe.ts`'s `extractRegionPolygons` already uses. Unlike
   * that function, country is resolved directly per relation (via
   * `resolvePolygonCountry`), not reverse-engineered from a pre-resolved
   * cities list -- there is no such list at world scale. */
  regionsByCountryName: Map<string, RegionCandidate>;
  diagnostics: AdminBoundaryIndexDiagnostics;
}

interface AdminBoundaryProps {
  admin_level?: string;
  name?: string;
}

/** Pass 1 of the 3-pass admin_level auto-detection (README.md's "Europe
 * scaling test"): one full streaming read of the merged, deduplicated
 * corpus, computing just enough per candidate relation (area,
 * representative point, bbox, resolved country) to run Pass 2/3's
 * selection logic without holding any full polygon geometry -- memory
 * bounded by candidate *count*, not corpus size. City candidates
 * (admin_level 5-11) and region candidates (admin_level 4) are collected
 * in the same pass since both need the same per-feature work. */
export async function buildAdminBoundaryIndex(files: string[], countries: CountryIndex): Promise<AdminBoundaryIndex> {
  const cityCandidates: CityCandidateMeta[] = [];
  const areaByCountryLevel = new Map<string, Map<number, number>>();
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
    const isCity = (CITY_CANDIDATE_LEVELS as readonly number[]).includes(level);
    const isRegion = level === REGION_LEVEL;
    if (!isCity && !isRegion) continue;

    const geometry = feature as Feature<Polygon | MultiPolygon>;
    // Still needed as a point known to lie on the feature (gap-fill and
    // region assignment test it for containment), but no longer trusted
    // to say which country the feature is in -- see polygonCountry.ts.
    const [repX, repY] = pointOnFeature(geometry).geometry.coordinates;
    const repPoint: LonLat = [repX ?? 0, repY ?? 0];
    const featureBbox = bbox(geometry);
    const country = resolvePolygonCountry(geometry, featureBbox, repPoint, countries, { alwaysSample: isRegion });
    if (!country) {
      diagnostics.noCountry++;
      continue;
    }

    if (isCity) {
      const featureArea = area(geometry) / 1_000_000; // m^2 -> km^2
      cityCandidates.push({ id, name: props?.name, country, level, area: featureArea, repPoint, bbox: featureBbox });
      let byLevel = areaByCountryLevel.get(country);
      if (!byLevel) {
        byLevel = new Map();
        areaByCountryLevel.set(country, byLevel);
      }
      byLevel.set(level, (byLevel.get(level) ?? 0) + featureArea);
      diagnostics.keptCity++;
      continue;
    }

    // isRegion
    const name = props?.name;
    if (!name) continue;
    const key = `${country} ${name}`;
    const existing = regionsByCountryName.get(key);
    if (!existing || bboxArea(featureBbox) > bboxArea(existing.bbox)) {
      const simplified = simplify(geometry, { tolerance: REGION_SIMPLIFY_TOLERANCE });
      regionsByCountryName.set(key, {
        id,
        name,
        country,
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

  return { cityCandidates, areaByCountryLevel, regionsByCountryName, diagnostics };
}

function bboxArea(b: BBox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
