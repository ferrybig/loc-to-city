import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import RBush from "rbush";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { RegionCandidate } from "./adminBoundaryIndex.js";
import type { LonLat } from "./geo.js";

interface IndexedRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  name: string;
  country: string;
  feature: Feature<Polygon | MultiPolygon, { name?: string }>;
}

export interface RegionIndex {
  tree: RBush<IndexedRegion>;
}

export function buildRegionIndex(regionsByCountryName: Map<string, RegionCandidate>): RegionIndex {
  const items: IndexedRegion[] = [...regionsByCountryName.values()].map((region) => ({
    minX: region.bbox[0],
    minY: region.bbox[1],
    maxX: region.bbox[2],
    maxY: region.bbox[3],
    name: region.name,
    country: region.country,
    feature: region.feature,
  }));
  const tree = new RBush<IndexedRegion>();
  tree.load(items);
  return { tree };
}

/** Assigns a surviving city to its containing region using its
 * already-computed representative point (no recomputation, reused from
 * `AdminBoundaryIndex`'s Pass 1) plus a bbox prefilter and exact
 * point-in-polygon, scoped to the city's own country (region names aren't
 * globally unique, only within a country). Unlike `prepare-europe.ts`
 * (which already knew each city's region from a pre-resolved cities file
 * and only needed to *find the matching polygon*), this pipeline has to
 * make the assignment itself -- there is no such pre-resolved file at
 * world scale.
 *
 * Returns null if no region polygon contains the point -- the city still
 * resolves at country level, the same graceful degradation
 * `prepare-europe.ts` already exercises for Ireland/Estonia/Portugal
 * (those countries don't tag their primary division as admin_level=4 the
 * way most of Europe does; that's a data reality, not a bug). */
export function assignCityRegion(repPoint: LonLat, country: string, index: RegionIndex): string | null {
  const [x, y] = repPoint;
  const hits = index.tree.search({ minX: x, minY: y, maxX: x, maxY: y });
  for (const hit of hits) {
    if (hit.country === country && booleanPointInPolygon(repPoint, hit.feature)) return hit.name;
  }
  return null;
}
