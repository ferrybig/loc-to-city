import { readFileSync } from "node:fs";
import RBush from "rbush";
import bbox from "@turf/bbox";
import area from "@turf/area";
import simplify from "@turf/simplify";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { LonLat } from "./geo.js";

interface NECountryProps {
  ISO_A2_EH?: string;
  ISO_A2?: string;
  NAME?: string;
  POP_EST?: number;
}

interface IndexedCountry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  code: string;
  feature: Feature<Polygon | MultiPolygon, NECountryProps>;
}

/** Worldwide, indexed country resolution from Natural Earth's admin-0
 * countries (`agent-resources/ne_10m_admin_0_countries.geojson`, already
 * worldwide in scope -- no changes needed there). Promoted out of
 * `prepare-europe.ts`'s inline `loadCountryPolygons` because world-scale
 * admin-boundary resolution runs millions of point tests, not a few
 * hundred, and needs a bbox prefilter to stay fast. */
export interface CountryIndex {
  /** Exact point-in-polygon lookup (bbox-prefiltered via rbush), against
   * unsimplified Natural Earth geometry. Returns the ISO_A2_EH code, or
   * null if the point falls inside no country (open ocean, a gap in NE's
   * coverage, etc.). */
  lookup(point: LonLat): string | null;
  /** Unsimplified area per country, km^2 -- the denominator for Pass 2's
   * "does this admin_level's area cover >=60% of the country" ratio. */
  areaByCode: Map<string, number>;
  nameByCode: Map<string, string>;
  /** Simplified (COUNTRY_SIMPLIFY_TOLERANCE) polygon per country, for the
   * compressor's country-polygon output layer -- same simplification
   * `prepare-europe.ts` already applies for the same reason (country
   * polygons are a coarse fallback layer, not precision-critical). */
  simplifiedFeatureByCode: Map<string, Feature<Polygon | MultiPolygon, { code: string }>>;
  /** Number of `lookup()` calls so far that matched no country. */
  missingCount(): number;
}

/** Country outlines are kept at Natural Earth's full 10m precision. They
 * used to be simplified to ~5.5km because vertex count drove the
 * compressor's dominant cost, but the segment/rectangle classifier made
 * that affordable: on Europe, full precision costs about four minutes
 * instead of thirty seconds and removes ~500 of 361,201 sampled points
 * that a 5.5km outline gets wrong -- all of them on coastlines and
 * borders, answering "unknown" where a country was meant, or the reverse.
 * Build time is paid once per rebuild; that error would ship in every
 * file. See README's "How much precision these tolerances cost".
 *
 * Regions are a different trade and stay simplified -- see
 * adminBoundaryIndex.ts. */
const COUNTRY_SIMPLIFY_TOLERANCE = 0; // 0 = keep every vertex

export function loadCountryIndex(neCountriesPath: string): CountryIndex {
  const data = JSON.parse(readFileSync(neCountriesPath, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    NECountryProps
  >;

  // A handful of ISO_A2_EH codes (France is the one that matters here)
  // have more than one Natural Earth feature (mainland + a dependency) --
  // keep the most populous one. ISO_A2 itself is literally "-99" for
  // France (a long-documented NE artifact), so ISO_A2_EH ("everywhere,
  // including disputed") is used instead -- same fix prepare-europe.ts
  // already applies.
  const byCode = new Map<string, Feature<Polygon | MultiPolygon, NECountryProps>>();
  for (const feature of data.features) {
    const code = feature.properties.ISO_A2_EH;
    if (!code || code === "-99") continue;
    const existing = byCode.get(code);
    if (!existing || (feature.properties.POP_EST ?? 0) > (existing.properties.POP_EST ?? 0)) {
      byCode.set(code, feature);
    }
  }

  const areaByCode = new Map<string, number>();
  const nameByCode = new Map<string, string>();
  const simplifiedFeatureByCode = new Map<string, Feature<Polygon | MultiPolygon, { code: string }>>();
  const items: IndexedCountry[] = [];

  for (const [code, feature] of byCode) {
    areaByCode.set(code, area(feature) / 1_000_000); // m^2 -> km^2
    nameByCode.set(code, feature.properties.NAME ?? code);
    const simplified =
      COUNTRY_SIMPLIFY_TOLERANCE <= 0 ? feature : simplify(feature, { tolerance: COUNTRY_SIMPLIFY_TOLERANCE });
    simplifiedFeatureByCode.set(code, { ...simplified, properties: { code } });

    const [minX, minY, maxX, maxY] = bbox(feature);
    items.push({ minX, minY, maxX, maxY, code, feature });
  }

  const tree = new RBush<IndexedCountry>();
  tree.load(items);

  let missing = 0;
  function lookup(point: LonLat): string | null {
    const [x, y] = point;
    const hits = tree.search({ minX: x, minY: y, maxX: x, maxY: y });
    for (const hit of hits) {
      if (booleanPointInPolygon(point, hit.feature)) return hit.code;
    }
    missing++;
    return null;
  }

  return {
    lookup,
    areaByCode,
    nameByCode,
    simplifiedFeatureByCode,
    missingCount: () => missing,
  };
}
