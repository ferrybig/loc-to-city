import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { PackedShape } from "./candidateIndex.ts";
import type { HierarchyCountry } from "./hierarchy.ts";

export interface CityProperties {
  id?: string;
  name: string;
  /** International/English name (README.md's "International/local name
   * pairs" item), when OSM tagged one. Never part of the region/country
   * join key -- only `name` is (see featuresByKey below) -- so it's purely
   * a display addition folded into the name entry at the very end. */
  nameEn?: string;
  region: string;
  country: string;
  /** Added by data-ingest's gap-fill from a coarser level than the
   * country's primary city level (India's talukas around its corporations),
   * to name what the primaries leave: it never takes a cell a primary city
   * contains (quadtree.ts's `preferred`). */
  gapFill?: boolean;
  [key: string]: unknown;
}

/** Assembles a Section 7.4 name entry from a local name and an optional
 * international name: `local|international`, or just `local` when there's
 * no international name or it's identical to the local one (writers
 * SHOULD omit trailing empty fields). Fields must not contain `|` or NUL
 * (Section 7.4); a name carrying either is passed through as the local
 * name only, since there is no escape mechanism to represent it. */
export function assembleNameEntry(local: string, international: string | undefined): string {
  if (!international || international === local) return local;
  if (international.includes("|") || international.includes("\0")) return local;
  return `${local}|${international}`;
}

export type CityFeature = Feature<Polygon | MultiPolygon, CityProperties>;

/** A city whose polygon was packed as it was read (see `loadCities`), so
 * its GeoJSON coordinates never had to be held at all. */
export interface PackedCityFeature {
  properties: CityProperties;
  shape: PackedShape;
}

/** What the build accepts as the city layer: plain GeoJSON features,
 * already-packed ones, or a mix -- only `properties` matter until the
 * candidate index is built. A GeoJSON `FeatureCollection` of cities is one. */
export type CityInput = CityFeature | PackedCityFeature;
export interface CityCollection {
  features: CityInput[];
}

export interface PlaceIdSpace {
  countryCount: number;
  /** Length countryCount; regionCounts[i] = number of regions in country i. */
  regionCounts: number[];
  /** Length totalRegions (global region index order). */
  cityCounts: number[];
  /** Length N, in id order: countries, then regions, then cities. */
  nameEntries: string[];
  /** City global id -> its polygon feature, for the spatial index. */
  cityFeaturesById: Map<number, CityInput>;
  /** City global id -> [regionGlobalId, countryGlobalId], for pruning
   * ancestor candidates in the compressor's quadtree (see quadtree.ts). */
  cityAncestors: Map<number, [number, number]>;
  /** Region global id -> countryGlobalId. */
  regionAncestors: Map<number, number>;
  /** Input city features whose region/country didn't match any hierarchy entry. */
  unmatched: CityInput[];
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Builds the Section 7.1 id space: countries 0..C-1, then regions C..C+R-1
 * grouped by country (in hierarchy order), then cities grouped by region
 * (in the same global region order). */
export function buildPlaceIdSpace(
  hierarchy: HierarchyCountry[],
  cities: CityCollection,
): PlaceIdSpace {
  const countryCount = hierarchy.length;
  const regionCounts = hierarchy.map((country) => country.regions.length);
  const nameEntries: string[] = hierarchy.map((country) => country.name);

  const regionOwners: Array<{ countryCode: string; regionName: string; countryId: number }> = [];
  hierarchy.forEach((country, countryId) => {
    for (const regionName of country.regions) {
      regionOwners.push({ countryCode: country.code, regionName, countryId });
      const localName = country.regionLocalNames?.[regionName] ?? regionName;
      nameEntries.push(assembleNameEntry(localName, country.regionNames?.[regionName]));
    }
  });
  const totalRegions = regionOwners.length;
  const regionAncestors = new Map<number, number>();
  regionOwners.forEach((owner, r) => {
    regionAncestors.set(countryCount + r, owner.countryId);
  });

  const featuresByKey = new Map<string, CityInput[]>();
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
  const cityFeaturesById = new Map<number, CityInput>();
  const cityAncestors = new Map<number, [number, number]>();
  let nextCityId = countryCount + totalRegions;
  const matchedKeys = new Set<string>();

  for (let r = 0; r < totalRegions; r++) {
    const owner = regionOwners[r]!;
    const key = `${owner.countryCode} ${owner.regionName}`;
    matchedKeys.add(key);
    const matched = [...(featuresByKey.get(key) ?? [])];
    // Deterministic order so re-running the compressor on the same input
    // reproduces the same file byte-for-byte -- on any machine, which is
    // why this is plain code-unit order and not localeCompare: that
    // collates by the build machine's default locale (and its ICU
    // version), so the same input could get different city ids elsewhere.
    matched.sort((a, b) =>
      compareCodeUnits(String(a.properties.id ?? a.properties.name), String(b.properties.id ?? b.properties.name)),
    );
    cityCounts[r] = matched.length;
    const regionGlobalId = countryCount + r;
    for (const feature of matched) {
      nameEntries.push(assembleNameEntry(feature.properties.name, feature.properties.nameEn));
      cityFeaturesById.set(nextCityId, feature);
      cityAncestors.set(nextCityId, [regionGlobalId, owner.countryId]);
      nextCityId++;
    }
  }

  const unmatched: CityInput[] = [];
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
