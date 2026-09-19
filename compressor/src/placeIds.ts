import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { HierarchyCountry } from "./hierarchy.js";

export interface CityProperties {
  id?: string;
  name: string;
  region: string;
  country: string;
  [key: string]: unknown;
}

export type CityFeature = Feature<Polygon | MultiPolygon, CityProperties>;

export interface PlaceIdSpace {
  countryCount: number;
  /** Length countryCount; regionCounts[i] = number of regions in country i. */
  regionCounts: number[];
  /** Length totalRegions (global region index order). */
  cityCounts: number[];
  /** Length N, in id order: countries, then regions, then cities. */
  nameEntries: string[];
  /** City global id -> its polygon feature, for the spatial index. */
  cityFeaturesById: Map<number, CityFeature>;
  /** City global id -> [regionGlobalId, countryGlobalId], for pruning
   * ancestor candidates in the compressor's quadtree (see quadtree.ts). */
  cityAncestors: Map<number, [number, number]>;
  /** Region global id -> countryGlobalId. */
  regionAncestors: Map<number, number>;
  /** Input city features whose region/country didn't match any hierarchy entry. */
  unmatched: CityFeature[];
}

/** Builds the Section 7.1 id space: countries 0..C-1, then regions C..C+R-1
 * grouped by country (in hierarchy order), then cities grouped by region
 * (in the same global region order). */
export function buildPlaceIdSpace(
  hierarchy: HierarchyCountry[],
  cities: FeatureCollection<Polygon | MultiPolygon, CityProperties>,
): PlaceIdSpace {
  const countryCount = hierarchy.length;
  const regionCounts = hierarchy.map((country) => country.regions.length);
  const nameEntries: string[] = hierarchy.map((country) => country.name);

  const regionOwners: Array<{ countryCode: string; regionName: string; countryId: number }> = [];
  hierarchy.forEach((country, countryId) => {
    for (const regionName of country.regions) {
      regionOwners.push({ countryCode: country.code, regionName, countryId });
      nameEntries.push(regionName);
    }
  });
  const totalRegions = regionOwners.length;
  const regionAncestors = new Map<number, number>();
  regionOwners.forEach((owner, r) => {
    regionAncestors.set(countryCount + r, owner.countryId);
  });

  const featuresByKey = new Map<string, CityFeature[]>();
  for (const feature of cities.features) {
    const key = `${feature.properties.country} ${feature.properties.region}`;
    let list = featuresByKey.get(key);
    if (!list) {
      list = [];
      featuresByKey.set(key, list);
    }
    list.push(feature);
  }

  const cityCounts: number[] = new Array(totalRegions);
  const cityFeaturesById = new Map<number, CityFeature>();
  const cityAncestors = new Map<number, [number, number]>();
  let nextCityId = countryCount + totalRegions;
  const matchedKeys = new Set<string>();

  for (let r = 0; r < totalRegions; r++) {
    const owner = regionOwners[r]!;
    const key = `${owner.countryCode} ${owner.regionName}`;
    matchedKeys.add(key);
    const matched = [...(featuresByKey.get(key) ?? [])];
    // Deterministic order so re-running the compressor on the same input
    // reproduces the same file byte-for-byte.
    matched.sort((a, b) =>
      String(a.properties.id ?? a.properties.name).localeCompare(String(b.properties.id ?? b.properties.name)),
    );
    cityCounts[r] = matched.length;
    const regionGlobalId = countryCount + r;
    for (const feature of matched) {
      nameEntries.push(feature.properties.name);
      cityFeaturesById.set(nextCityId, feature);
      cityAncestors.set(nextCityId, [regionGlobalId, owner.countryId]);
      nextCityId++;
    }
  }

  const unmatched: CityFeature[] = [];
  for (const [key, features] of featuresByKey) {
    if (!matchedKeys.has(key)) unmatched.push(...features);
  }

  return {
    countryCount,
    regionCounts,
    cityCounts,
    nameEntries,
    cityFeaturesById,
    cityAncestors,
    regionAncestors,
    unmatched,
  };
}
