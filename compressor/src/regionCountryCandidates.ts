import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { HierarchyCountry } from "./hierarchy.js";
import type { CandidateEntry } from "./candidateIndex.js";

/** Builds the country/region entries of the candidate list (Section 7.1
 * ids: countries 0..C-1, then regions C..C+R-1 in hierarchy order), so that
 * a cell not inside any more specific place still resolves to its region or
 * country instead of "unknown". Uses the exact same id assignment order as
 * buildPlaceIdSpace, and attaches each entry's ancestor chain so the
 * quadtree can prune a region/country whenever a more specific descendant
 * is also a candidate for the same cell. */
export function buildRegionCountryCandidates(
  hierarchy: HierarchyCountry[],
  countries: FeatureCollection<Polygon | MultiPolygon, { code: string }> | undefined,
  regions: FeatureCollection<Polygon | MultiPolygon, { name: string }> | undefined,
): CandidateEntry[] {
  const entries: CandidateEntry[] = [];

  const countryByCode = new Map<string, Feature<Polygon | MultiPolygon>>();
  for (const feature of countries?.features ?? []) countryByCode.set(feature.properties.code, feature);

  const regionByName = new Map<string, Feature<Polygon | MultiPolygon>>();
  for (const feature of regions?.features ?? []) regionByName.set(feature.properties.name, feature);

  const countryCount = hierarchy.length;
  hierarchy.forEach((country, countryId) => {
    const feature = countryByCode.get(country.code);
    if (feature) entries.push({ globalId: countryId, feature, ancestorIds: [] });
  });

  let regionId = countryCount;
  hierarchy.forEach((country, countryId) => {
    for (const regionName of country.regions) {
      const feature = regionByName.get(regionName);
      if (feature) entries.push({ globalId: regionId, feature, ancestorIds: [countryId] });
      regionId++;
    }
  });

  return entries;
}
