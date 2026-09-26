import { readFileSync } from "node:fs";

/**
 * Input model for the place hierarchy (Section 7.1), independent of city
 * geometry. `code` is only used to match city features' `country` property
 * to the right entry -- it isn't stored in the output file, only `name` is.
 * This is what lets a country's full region list be present even when some
 * regions have no cities (Section 7.2: "A country's region count or a
 * region's city count MAY be 0").
 */
export interface HierarchyCountry {
  code: string;
  name: string;
  regions: string[];
  /** Region local name -> international/English name (README.md's
   * "International/local name pairs" item), for regions where OSM tagged
   * one. Deliberately keyed by the same local name used in `regions` --
   * that array stays the join key between a hierarchy region and its
   * cities (see placeIds.ts), so the international name rides along as a
   * side lookup instead of ever replacing it. Absent entirely, or missing
   * a given region's key, both mean "no international name known". */
  regionNames?: Record<string, string>;
}

export function loadHierarchy(path: string): HierarchyCountry[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("hierarchy file must be a JSON array of countries");
  }
  for (const entry of raw) {
    const e = entry as Partial<HierarchyCountry>;
    if (typeof e.code !== "string" || typeof e.name !== "string" || !Array.isArray(e.regions)) {
      throw new Error(`invalid hierarchy entry: ${JSON.stringify(entry)}`);
    }
    if (e.regionNames !== undefined && (typeof e.regionNames !== "object" || e.regionNames === null)) {
      throw new Error(`invalid hierarchy entry: ${JSON.stringify(entry)}`);
    }
  }
  return raw as HierarchyCountry[];
}
