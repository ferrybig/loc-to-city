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
import { createWriteStream, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { discoverAdminGeoJsonFiles } from "./lib/osmFiles.js";
import { loadCountryIndex } from "./lib/countryIndex.js";
import { buildAdminBoundaryIndex } from "./lib/adminBoundaryIndex.js";
import type { AdminBoundaryIndex, CityCandidateMeta } from "./lib/adminBoundaryIndex.js";
import { selectPrimaryLevels, loadPrimaryGeometries, detectGapFill, fetchFinalGeometries } from "./lib/adminLevelDetection.js";
import type { PrimaryLevelResult } from "./lib/adminLevelDetection.js";
import { buildRegionIndex, assignCityRegion } from "./lib/regionPolygons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORK_DIR = path.join(REPO_ROOT, "data-ingest/work-world");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "agent-resources/ne_10m_admin_0_countries.geojson");

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/world-hierarchy.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/world-cities-filtered.geojsonseq");
const REGIONS_OUT = path.join(REPO_ROOT, "data/world-regions.geojson");
const COUNTRIES_OUT = path.join(REPO_ROOT, "data/world-country-polygons.geojson");

// 115,000 primaries measured at 8.2GB resident, so a batch is sized well
// under that -- the cost of one extra batch is one more read of the
// corpus, which is cheap next to being killed.
const MAX_PRIMARIES_PER_BATCH = 60_000;

interface CountryBatch {
  countries: Set<string>;
  primaryIds: Set<string>;
  primaryCount: number;
}

/** Splits countries into batches of roughly equal primary-city count, so
 * no batch blows the geometry budget while the number of corpus re-reads
 * stays small. Largest-country-first into whichever batch is currently
 * smallest -- crude, but it keeps a China or a Brazil from landing
 * together. */
function planCountryBatches(index: AdminBoundaryIndex, primary: PrimaryLevelResult): CountryBatch[] {
  const idsByCountry = new Map<string, string[]>();
  for (const candidate of index.cityCandidates) {
    if (!primary.primaryIds.has(candidate.id)) continue;
    let ids = idsByCountry.get(candidate.country);
    if (!ids) {
      ids = [];
      idsByCountry.set(candidate.country, ids);
    }
    ids.push(candidate.id);
  }

  const total = [...idsByCountry.values()].reduce((n, ids) => n + ids.length, 0);
  const batchCount = Math.max(1, Math.ceil(total / MAX_PRIMARIES_PER_BATCH));
  const batches: CountryBatch[] = Array.from({ length: batchCount }, () => ({
    countries: new Set<string>(),
    primaryIds: new Set<string>(),
    primaryCount: 0,
  }));

  const bySize = [...idsByCountry.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [country, ids] of bySize) {
    const target = batches.reduce((a, b) => (a.primaryCount <= b.primaryCount ? a : b));
    target.countries.add(country);
    for (const id of ids) target.primaryIds.add(id);
    target.primaryCount += ids.length;
  }
  return batches.filter((b) => b.primaryCount > 0);
}

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

  console.error("Pass 2/4: selecting primary admin levels...");
  const primary = selectPrimaryLevels(index, countries);
  const regionIndex = buildRegionIndex(index.regionsByCountryName);

  // Full-precision city geometry for the whole world does not fit in
  // memory at once -- ~295k primaries measured at roughly 60KB each, so
  // ~19GB. Countries are therefore processed in batches, which is sound
  // because every question left to answer is country-local: a candidate's
  // representative point can only fall inside a primary of its own
  // country, and its region can only be one of that country's regions.
  // Each batch costs one more read of the corpus, so batches are kept few
  // and balanced by primary count rather than split per country.
  const batches = planCountryBatches(index, primary);
  console.error(
    `processing ${batches.length} country batches (largest ${Math.max(...batches.map((b) => b.primaryCount)).toLocaleString()} primaries)`,
  );

  // Cities stream straight to disk as a GeoJSON Text Sequence (one
  // RS-delimited feature per record, the same shape osmium emits and
  // streamGeoJSONSeq reads). A single FeatureCollection is not an option
  // at this scale: the file runs to gigabytes, and Node cannot hold a
  // string past 512MB, so nothing downstream could ever JSON.parse it.
  const cityOut = createWriteStream(CITIES_OUT);
  const write = (chunk: string): Promise<void> =>
    cityOut.write(chunk) ? Promise.resolve() : new Promise((resolve) => cityOut.once("drain", () => resolve()));

  const regionsByCountry = new Map<string, Set<string>>();
  const skippedNoRegionByCountry = new Map<string, number>();
  let cityCount = 0;
  let skippedNoName = 0;
  let skippedNoGeometry = 0;
  const gapFillByCountryBatch: CityCandidateMeta[][] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    console.error(
      `  batch ${batchIndex + 1}/${batches.length}: ${batch.countries.size} countries, ${batch.primaryCount.toLocaleString()} primaries`,
    );
    const primaryGeom = await loadPrimaryGeometries(files, batch.primaryIds);
    const gapFill = detectGapFill(index, primary, primaryGeom, batch.countries);
    gapFillByCountryBatch.push(gapFill);

    for (const candidate of index.cityCandidates) {
      if (!batch.primaryIds.has(candidate.id)) continue;
      const geometry = primaryGeom.byId.get(candidate.id);
      if (!geometry) {
        skippedNoGeometry++;
        continue;
      }
      const emitted = await emitCity(candidate, geometry);
      if (emitted) cityCount++;
    }
  }

  console.error("Pass 3/4: gap-fill geometry...");
  const gapFillById = new Map<string, CityCandidateMeta>();
  for (const batch of gapFillByCountryBatch) {
    for (const candidate of batch) gapFillById.set(candidate.id, candidate);
  }
  console.error(`  ${gapFillById.size.toLocaleString()} gap-fill cities across all batches`);

  // One final corpus read covers every batch's gap-fill at once, and each
  // feature is written and released immediately.
  for await (const { id, feature } of fetchFinalGeometries(files, new Set(gapFillById.keys()))) {
    const candidate = gapFillById.get(id);
    if (!candidate) continue;
    const emitted = await emitCity(candidate, feature);
    if (emitted) cityCount++;
  }

  await new Promise<void>((resolve, reject) => cityOut.end((err?: Error | null) => (err ? reject(err) : resolve())));

  async function emitCity(candidate: CityCandidateMeta, geometry: Feature<Polygon | MultiPolygon>): Promise<boolean> {
    if (!candidate.name) {
      skippedNoName++;
      return false;
    }
    const region = assignCityRegion(candidate.repPoint, candidate.country, regionIndex);
    if (!region) {
      skippedNoRegionByCountry.set(candidate.country, (skippedNoRegionByCountry.get(candidate.country) ?? 0) + 1);
      return false;
    }
    let regions = regionsByCountry.get(candidate.country);
    if (!regions) {
      regions = new Set();
      regionsByCountry.set(candidate.country, regions);
    }
    regions.add(region);

    const feature: Feature<Polygon | MultiPolygon, CityProperties> = {
      type: "Feature",
      properties: { id: candidate.id, name: candidate.name, region, country: candidate.country },
      geometry: geometry.geometry,
    };
    await write("\x1e" + JSON.stringify(feature) + "\n");
    return true;
  }

  console.error("Pass 4/4: hierarchy, regions and country polygons...");
  const skippedNoRegion = [...skippedNoRegionByCountry.values()].reduce((a, b) => a + b, 0);
  console.error(
    `cities: ${cityCount} kept, ${skippedNoName} skipped (no name), ${skippedNoGeometry} skipped ` +
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
  console.error(
    `wrote ${HIERARCHY_OUT} (${hierarchy.length} countries, ${hierarchy.reduce((n, c) => n + c.regions.length, 0)} regions) and ${CITIES_OUT} (${cityCount} cities)`,
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

  console.error(`admin relations resolving to no country: ${index.diagnostics.noCountry}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
