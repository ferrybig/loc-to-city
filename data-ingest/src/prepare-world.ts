// Prepares worldwide compressor inputs from the outputs of
// scripts/extract-boundaries.sh (data-ingest/work-world/*-admin.geojson,
// one per data-ingest/osm/*.osm.pbf continent extract).
//
// Unlike prepare-europe.ts, there is no pre-computed cities.geojson to
// reuse -- that file was produced by a deleted Python pipeline that only
// ever ran for Europe. This script does the full job itself: merges and
// deduplicates administrative relations across however many continent
// files are present (dedup is by OSM relation id, not by any per-country
// priority -- see mergeAdminBoundaries.ts for why that's both correct and
// general, verified empirically against Russia/Turkey's real cross-file
// split), then ports README.md's 3-pass per-country admin_level
// auto-detection (area-accumulate by (country,level) -> pick the finest
// level covering >=60% of the country as primary -> gap-fill by
// representative-point containment) to assemble the city layer, plus a
// region layer (admin_level=4) and a country layer (Natural Earth,
// already worldwide).
//
// See data-ingest/src/lib/{osmFiles,countryIndex,mergeAdminBoundaries,
// adminBoundaryIndex,adminLevelDetection,regionPolygons}.ts for the
// pieces; this file just orchestrates them and writes the same output
// shapes prepare-europe.ts already produces, so the compressor CLI needs
// no changes at all.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { discoverAdminGeoJsonFiles } from "./lib/osmFiles.js";
import { loadCountryIndex } from "./lib/countryIndex.js";
import { buildAdminBoundaryIndex } from "./lib/adminBoundaryIndex.js";
import { selectPrimaryLevels, loadPrimaryGeometries, detectGapFill, fetchFinalGeometries } from "./lib/adminLevelDetection.js";
import { buildRegionIndex, assignCityRegion } from "./lib/regionPolygons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORK_DIR = path.join(REPO_ROOT, "data-ingest/work-world");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "agent-resources/ne_10m_admin_0_countries.geojson");

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/world-hierarchy.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/world-cities-filtered.geojson");
const REGIONS_OUT = path.join(REPO_ROOT, "data/world-regions.geojson");
const COUNTRIES_OUT = path.join(REPO_ROOT, "data/world-country-polygons.geojson");

async function main(): Promise<void> {
  const files = discoverAdminGeoJsonFiles(WORK_DIR);
  if (files.length === 0) {
    throw new Error(`no *-admin.geojson files found in ${WORK_DIR} -- run scripts/extract-boundaries.sh first`);
  }
  console.error(`found ${files.length} admin files: ${files.map((f) => path.basename(f)).join(", ")}`);

  console.error("Loading country index (Natural Earth, worldwide)...");
  const countries = loadCountryIndex(COUNTRIES_SOURCE);

  console.error("Pass 1/4: scanning merged corpus for city/region candidates...");
  const index = await buildAdminBoundaryIndex(files, countries);

  console.error("Pass 2/4: selecting primary admin levels, loading primary geometry...");
  const primary = selectPrimaryLevels(index, countries);
  const primaryGeom = await loadPrimaryGeometries(files, primary.primaryIds);

  console.error("Pass 3/4: gap-fill detection...");
  const gapFill = detectGapFill(index, primary, primaryGeom);
  const gapFillIds = new Set(gapFill.map((c) => c.id));

  console.error("Pass 4/4: fetching gap-fill geometry, assembling cities/regions/hierarchy...");
  const gapFillGeomById = new Map<string, Feature<Polygon | MultiPolygon>>();
  for await (const { id, feature } of fetchFinalGeometries(files, gapFillIds)) {
    gapFillGeomById.set(id, feature);
  }

  const regionIndex = buildRegionIndex(index.regionsByCountryName);

  const survivors = [...index.cityCandidates.filter((c) => primary.primaryIds.has(c.id)), ...gapFill];

  const cityFeatures: Feature<Polygon | MultiPolygon, CityProperties>[] = [];
  const regionsByCountry = new Map<string, Set<string>>();
  let skippedNoName = 0;
  let skippedNoGeometry = 0;
  const skippedNoRegionByCountry = new Map<string, number>();

  for (const candidate of survivors) {
    if (!candidate.name) {
      skippedNoName++;
      continue;
    }
    const geometry = primaryGeom.byId.get(candidate.id) ?? gapFillGeomById.get(candidate.id);
    if (!geometry) {
      skippedNoGeometry++;
      continue;
    }
    const region = assignCityRegion(candidate.repPoint, candidate.country, regionIndex);
    if (!region) {
      skippedNoRegionByCountry.set(candidate.country, (skippedNoRegionByCountry.get(candidate.country) ?? 0) + 1);
      continue;
    }
    let regions = regionsByCountry.get(candidate.country);
    if (!regions) {
      regions = new Set();
      regionsByCountry.set(candidate.country, regions);
    }
    regions.add(region);

    cityFeatures.push({
      type: "Feature",
      properties: { id: candidate.id, name: candidate.name, region, country: candidate.country },
      geometry: geometry.geometry,
    });
  }

  const skippedNoRegion = [...skippedNoRegionByCountry.values()].reduce((a, b) => a + b, 0);
  console.error(
    `cities: ${cityFeatures.length} kept, ${skippedNoName} skipped (no name), ${skippedNoGeometry} skipped ` +
      `(no geometry found), ${skippedNoRegion} skipped (no region -- city/region resolution unavailable there)`,
  );
  if (skippedNoRegionByCountry.size > 0) {
    const worst = [...skippedNoRegionByCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.error(`  no-region counts by country (top 10): ${worst.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  }

  // Every Natural Earth country gets a hierarchy entry, even with 0
  // regions/cities (Section 7.2 explicitly allows this) -- unlike
  // prepare-europe.ts (which derives its hierarchy purely from observed
  // city regions, fine at Europe's scale since essentially every European
  // country has at least one successfully-matched city), worldwide is far
  // more likely to have a country with 0 matched cities/regions in OSM's
  // admin_level tagging. Including it anyway means such a country still
  // resolves at country level via the compressor's spatial fallback,
  // instead of silently vanishing from the output entirely.
  const hierarchy: HierarchyCountry[] = [...countries.nameByCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, name]) => ({
      code,
      name,
      regions: [...(regionsByCountry.get(code) ?? [])].sort((a, b) => a.localeCompare(b)),
    }));
  writeFileSync(HIERARCHY_OUT, JSON.stringify(hierarchy));
  writeFileSync(CITIES_OUT, JSON.stringify({ type: "FeatureCollection", features: cityFeatures } satisfies FeatureCollection<Polygon | MultiPolygon, CityProperties>));
  console.error(
    `wrote ${HIERARCHY_OUT} (${hierarchy.length} countries, ${hierarchy.reduce((n, c) => n + c.regions.length, 0)} regions) and ${CITIES_OUT} (${cityFeatures.length} cities)`,
  );

  const countryCollection: FeatureCollection<Polygon | MultiPolygon, { code: string }> = {
    type: "FeatureCollection",
    features: [...countries.simplifiedFeatureByCode.values()],
  };
  writeFileSync(COUNTRIES_OUT, JSON.stringify(countryCollection));
  console.error(`wrote ${COUNTRIES_OUT} (${countryCollection.features.length} countries)`);

  const regionCollection: FeatureCollection<Polygon | MultiPolygon, { name: string; country: string }> = {
    type: "FeatureCollection",
    features: [...index.regionsByCountryName.values()].map((r) => ({
      type: "Feature",
      properties: { name: r.name, country: r.country },
      geometry: r.feature.geometry,
    })),
  };
  writeFileSync(REGIONS_OUT, JSON.stringify(regionCollection));
  console.error(`wrote ${REGIONS_OUT} (${regionCollection.features.length} regions)`);

  console.error(`country lookups with no match: ${countries.missingCount()}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
