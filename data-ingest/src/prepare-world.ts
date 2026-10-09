// Prepares worldwide compressor inputs from the outputs of
// scripts/extract-boundaries.sh (data/01-extracted/world/*-admin.geojson,
// one per data/00-raw/osm/*.osm.pbf continent extract).
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
// region layer and a country layer (Natural Earth, already worldwide).
// The region layer's own admin_level is auto-detected per country too
// (selectRegionLevels), not assumed to always be 4 -- see
// adminLevelDetection.ts's doc comment for why that matters.
//
// See data-ingest/src/lib/{osmFiles,countryIndex,mergeAdminBoundaries,
// adminBoundaryIndex,adminLevelDetection,regionPolygons}.ts for the
// pieces; this file just orchestrates them and writes the same output
// shapes prepare-europe.ts already produces, so the compressor CLI needs
// no changes at all.
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { discoverAdminGeoJsonFiles } from "./lib/osmFiles.ts";
import { loadCountryIndex } from "./lib/countryIndex.ts";
import { loadOsmCountryBorders, withOsmCountryBorders } from "./lib/osmCountryBorders.ts";
import { buildAdminBoundaryIndex } from "./lib/adminBoundaryIndex.ts";
import type { CityCandidateMeta } from "./lib/adminBoundaryIndex.ts";
import {
  selectRegionLevels,
  selectPrimaryLevels,
  createGapFillTracker,
  streamPrimaries,
  findSuppressedByWholeUnits,
  streamGeometries,
} from "./lib/adminLevelDetection.ts";
import { buildRegionIndex, assignCityRegion } from "./lib/regionPolygons.ts";
import { streamCities500 } from "./lib/cities500.ts";
import type { Cities500Row } from "./lib/cities500.ts";
import { loadAdmin1Names } from "./lib/admin1Codes.ts";
import { buildCityFallback, buildContainerFallback, buildRegionFallback } from "./lib/voronoiFallback.ts";
import {
  VORONOI_CITY_FALLBACK,
  VORONOI_CITY_FALLBACK_WITHIN_REGIONS,
  VORONOI_REGION_FALLBACK,
} from "./lib/countryAdminLevels.ts";
import type { LonLat } from "./lib/geo.ts";
import type { RegionCandidate } from "./lib/adminBoundaryIndex.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORK_DIR = path.join(REPO_ROOT, "data/01-extracted/world");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");
const CITIES500_SOURCE = path.join(REPO_ROOT, "data/00-raw/geonames/cities500.txt");
const ADMIN1_CODES_SOURCE = path.join(REPO_ROOT, "data/00-raw/geonames/admin1CodesASCII.txt");

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/02-resolved/world/hierarchy.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/02-resolved/world/cities-filtered.geojsonseq");
const REGIONS_OUT = path.join(REPO_ROOT, "data/02-resolved/world/regions.geojson");
const COUNTRIES_OUT = path.join(REPO_ROOT, "data/02-resolved/world/country-polygons.geojson");

async function main(): Promise<void> {
  mkdirSync(path.dirname(HIERARCHY_OUT), { recursive: true });

  const files = discoverAdminGeoJsonFiles(WORK_DIR);
  if (files.length === 0) {
    throw new Error(`no *-admin.geojson files found in ${WORK_DIR} -- run scripts/extract-boundaries.sh first`);
  }
  console.error(`found ${files.length} admin files: ${files.map((f) => path.basename(f)).join(", ")}`);

  console.error("Loading country index (Natural Earth, worldwide)...");
  const naturalEarth = loadCountryIndex(COUNTRIES_SOURCE);
  // Natural Earth has no room for enclaves (Baarle-Hertog) and only
  // approximates land borders; OSM's own country borders, already in the
  // corpus, correct it where the two disagree (see withOsmCountryBorders).
  console.error("Loading OSM country borders (admin_level=2)...");
  const countries = withOsmCountryBorders(
    naturalEarth,
    await loadOsmCountryBorders(files, new Set(naturalEarth.nameByCode.keys())),
  );

  console.error("Pass 1/4: scanning merged corpus for city/region candidates...");
  const index = await buildAdminBoundaryIndex(files, countries);

  console.error("Pass 1.5/4: selecting each country's region level...");
  const region = selectRegionLevels(index, countries);
  // Only the level that won each country's vote becomes its actual region
  // layer -- a country's own COUNTRY_ADMIN_LEVELS.region entry can list
  // more than one candidate level for selectRegionLevels to compare, so a
  // losing level's candidates must not leak into region assignment or
  // output. (In practice almost every entry lists exactly one level, so
  // this filter is close to a no-op for most countries.)
  const finalRegions = new Map(
    [...index.regionsByCountryName].filter(([, r]) => region.regionLevelByCountry.get(r.country) === r.level),
  );

  // README's "Voronoi-from-cities500" fallback, region half
  // (VORONOI_REGION_FALLBACK's doc comment has the full rationale): for a
  // country with no usable OSM region tier at all, synthesize one from
  // cities500.txt grouped by admin1 code. Must run before regionIndex is
  // built below -- every downstream region assignment (real OSM
  // candidates, the region-override routing, and the city Voronoi
  // fallback later) depends on finalRegions already being complete.
  if (VORONOI_REGION_FALLBACK.size > 0) {
    console.error(`Voronoi fallback: synthesizing regions for ${[...VORONOI_REGION_FALLBACK].join(", ")}...`);
    const admin1Names = await loadAdmin1Names(ADMIN1_CODES_SOURCE);
    const regionPointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of streamCities500(CITIES500_SOURCE)) {
      if (!VORONOI_REGION_FALLBACK.has(row.countryCode)) continue;
      let points = regionPointsByCountry.get(row.countryCode);
      if (!points) {
        points = [];
        regionPointsByCountry.set(row.countryCode, points);
      }
      points.push(row);
    }
    let voronoiRegionCount = 0;
    for (const [countryCode, points] of regionPointsByCountry) {
      const countryPolygon = countries.simplifiedFeatureByCode.get(countryCode);
      if (!countryPolygon) continue;
      const candidates = buildRegionFallback(countryPolygon, points, admin1Names);
      for (const candidate of candidates) {
        const key = `${candidate.country} voronoi ${candidate.name}`;
        const feature: Feature<Polygon | MultiPolygon, { name: string }> = {
          type: "Feature",
          properties: { name: candidate.name },
          geometry: candidate.geometry,
        };
        const regionCandidate: RegionCandidate = {
          id: `voronoi:${candidate.country}.${candidate.name}`,
          name: candidate.name,
          nameEn: undefined,
          country: candidate.country,
          level: -1, // not a real OSM admin_level -- never matched against COUNTRY_ADMIN_LEVELS
          bbox: bbox(feature),
          feature,
        };
        finalRegions.set(key, regionCandidate);
        voronoiRegionCount++;
      }
    }
    console.error(`Voronoi fallback: ${voronoiRegionCount.toLocaleString()} synthesized regions added`);
  }

  console.error("Pass 2/4: selecting primary admin levels...");
  const regionIndex = buildRegionIndex(finalRegions);
  // Only needed to route a region-override candidate (see
  // COUNTRY_ADMIN_LEVELS.overrides) to its region's own level instead of
  // the country-wide one -- resolves the same way emitCity's own region
  // assignment does later, just early enough for selectPrimaryLevels to
  // use it.
  const resolveCandidateRegion = (candidate: CityCandidateMeta): string | null =>
    assignCityRegion(candidate.repPoint, candidate.country, regionIndex);
  const primary = selectPrimaryLevels(index, countries, undefined, resolveCandidateRegion);

  // Cities stream straight to disk as a GeoJSON Text Sequence (one
  // RS-delimited feature per record, the same shape osmium emits and
  // streamGeoJSONSeq reads). A single FeatureCollection is not an option
  // at this scale: the file runs to gigabytes, and Node cannot hold a
  // string past 512MB, so nothing downstream could ever JSON.parse it.
  const cityOut = createWriteStream(CITIES_OUT);
  const write = (chunk: string): Promise<void> =>
    cityOut.write(chunk) ? Promise.resolve() : new Promise((resolve) => cityOut.once("drain", () => resolve()));

  // Every region polygon enters the hierarchy, not just those that end up
  // holding a city: the compressor only builds regions the hierarchy
  // lists, so a region with no cities (all of Libya/Egypt, whose OSM data
  // has no city tier, or Khartoum State) would otherwise vanish and its
  // points resolve at country level only.
  const regionsByCountry = new Map<string, Set<string>>();
  // Local region name -> international name (README.md's "International/
  // local name pairs" item), keyed by the exact same local name used as
  // the join key everywhere else -- see HierarchyCountry.regionNames.
  const regionNamesByCountry = new Map<string, Map<string, string>>();
  for (const r of finalRegions.values()) {
    let names = regionsByCountry.get(r.country);
    if (!names) {
      names = new Set();
      regionsByCountry.set(r.country, names);
    }
    names.add(r.name);
    if (r.nameEn) {
      let intlNames = regionNamesByCountry.get(r.country);
      if (!intlNames) {
        intlNames = new Map();
        regionNamesByCountry.set(r.country, intlNames);
      }
      intlNames.set(r.name, r.nameEn);
    }
  }
  const skippedNoRegionByCountry = new Map<string, number>();
  let cityCount = 0;
  let skippedNoName = 0;
  let skippedNoGeometry = 0;

  // Region-scoped Voronoi city fallback (VORONOI_CITY_FALLBACK_WITHIN_REGIONS'
  // doc comment): only the opted-in countries' points are kept, and the
  // cells are built per container polygon as the primaries stream past.
  const withinRegionPoints = new Map<string, Cities500Row[]>();
  if (VORONOI_CITY_FALLBACK_WITHIN_REGIONS.size > 0) {
    for await (const row of streamCities500(CITIES500_SOURCE)) {
      if (!VORONOI_CITY_FALLBACK_WITHIN_REGIONS.has(row.countryCode)) continue;
      let points = withinRegionPoints.get(row.countryCode);
      if (!points) {
        points = [];
        withinRegionPoints.set(row.countryCode, points);
      }
      points.push(row);
    }
  }
  let withinRegionCount = 0;

  // A whole unit's sub-units (Wales' communities inside Cardiff) are dropped
  // from the stream below -- see CountryAdminLevels.wholeUnits.
  const suppressed = await findSuppressedByWholeUnits(files, index, primary, resolveCandidateRegion);

  // Primaries are written as they stream past, straight from their source
  // text, while the same read marks which other candidates they cover --
  // no primary geometry is ever held (see createGapFillTracker).
  const tracker = createGapFillTracker(index, primary, resolveCandidateRegion);
  const primariesFound = await streamPrimaries(files, tracker, async (candidate, geometryJson) => {
    if (suppressed.has(candidate.id)) return;
    // A container in a within-region fallback region is replaced by its
    // cells. Emitting it as well, as a backstop, would be worse than no
    // backstop: at the compressor's max depth a leaf cell on a border
    // between two cells is won by the candidate covering the largest
    // share of it, which is always the container (100%) over either
    // neighbouring cell -- measured as ~5% of random Highland lookups
    // returning "Highland". The cells tile the container, so nothing is
    // lost; a container with no point at all is still emitted as itself.
    // Only these few containers are parsed; every other primary stays text.
    const withinRegions = VORONOI_CITY_FALLBACK_WITHIN_REGIONS.get(candidate.country);
    const points = withinRegionPoints.get(candidate.country);
    const region = withinRegions && points ? resolveCandidateRegion(candidate) : null;
    const cells =
      region && withinRegions!.includes(region)
        ? buildContainerFallback(
            { type: "Feature", properties: {}, geometry: JSON.parse(geometryJson) as Polygon | MultiPolygon },
            points!,
          )
        : [];
    if (cells.length === 0) {
      if (await emitCity(candidate, geometryJson)) cityCount++;
      return;
    }
    for (const cell of cells) {
      if (await emitCity(cell, JSON.stringify(cell.geometry))) {
        cityCount++;
        withinRegionCount++;
      }
    }
  });
  skippedNoGeometry += tracker.primaryById.size - primariesFound;
  if (withinRegionCount > 0) {
    console.error(`Voronoi within-region fallback: ${withinRegionCount.toLocaleString()} synthesized cities emitted`);
  }

  console.error("Pass 3/4: gap-fill geometry...");
  const gapFillById = new Map<string, CityCandidateMeta>();
  for (const candidate of tracker.gapFill()) gapFillById.set(candidate.id, candidate);
  console.error(`  ${gapFillById.size.toLocaleString()} gap-fill cities`);

  for await (const { id, geometryJson } of streamGeometries(files, gapFillById)) {
    if (await emitCity(gapFillById.get(id)!, geometryJson)) cityCount++;
  }

  // README's "Voronoi-from-cities500" fallback (VORONOI_CITY_FALLBACK's
  // doc comment has the full rationale): a hand-reviewed list of
  // countries with a confirmed, genuine absence of OSM city-tier
  // administrative polygons, not fixable by any admin_level choice.
  // Reads cities500.txt once, groups it by country here (not inside
  // voronoiFallback.ts, which stays country-agnostic), and synthesizes a
  // Voronoi city polygon per point for just the opted-in countries --
  // every other country's real OSM data is completely unaffected. Goes
  // through the same emitCity path as everything else, so a fallback
  // city still resolves to its real region via assignCityRegion.
  if (VORONOI_CITY_FALLBACK.size > 0) {
    console.error(`Voronoi fallback: loading cities500.txt for ${[...VORONOI_CITY_FALLBACK].join(", ")}...`);
    const pointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of streamCities500(CITIES500_SOURCE)) {
      if (!VORONOI_CITY_FALLBACK.has(row.countryCode)) continue;
      let points = pointsByCountry.get(row.countryCode);
      if (!points) {
        points = [];
        pointsByCountry.set(row.countryCode, points);
      }
      points.push(row);
    }
    let voronoiCount = 0;
    for (const [countryCode, points] of pointsByCountry) {
      const countryPolygon = countries.simplifiedFeatureByCode.get(countryCode);
      if (!countryPolygon) continue;
      const candidates = buildCityFallback(countryPolygon, points);
      for (const candidate of candidates) {
        const emitted = await emitCity(candidate, JSON.stringify(candidate.geometry));
        if (emitted) {
          cityCount++;
          voronoiCount++;
        }
      }
    }
    console.error(`Voronoi fallback: ${voronoiCount.toLocaleString()} synthesized cities emitted`);
  }

  await new Promise<void>((resolve, reject) => cityOut.end((err?: Error | null) => (err ? reject(err) : resolve())));

  // Structural, not CityCandidateMeta itself, so a synthesized Voronoi
  // fallback candidate (voronoiFallback.ts's VoronoiCityCandidate -- no
  // level/area/bbox, since it was never an OSM relation) can be emitted
  // through the exact same path as a real one, rather than needing a
  // second, parallel emit function.
  interface EmittableCity {
    id: string;
    name: string | undefined;
    nameEn?: string | undefined;
    country: string;
    repPoint: LonLat;
  }
  /** `geometryJson` is the geometry's JSON text, written out as is -- for
   * an OSM city, the exact text osmium wrote, never parsed. */
  async function emitCity(candidate: EmittableCity, geometryJson: string): Promise<boolean> {
    if (!candidate.name) {
      skippedNoName++;
      return false;
    }
    const region = assignCityRegion(candidate.repPoint, candidate.country, regionIndex);
    if (!region) {
      skippedNoRegionByCountry.set(candidate.country, (skippedNoRegionByCountry.get(candidate.country) ?? 0) + 1);
      return false;
    }

    const properties: CityProperties = {
      id: candidate.id,
      name: candidate.name,
      ...(candidate.nameEn ? { nameEn: candidate.nameEn } : {}),
      region,
      country: candidate.country,
    };
    // Same bytes JSON.stringify gives a {type, properties, geometry} feature,
    // and properties-first is what filter-by-scope.ts peeks at.
    await write(`\x1e{"type":"Feature","properties":${JSON.stringify(properties)},"geometry":${geometryJson}}\n`);
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
  // Plain code-unit order, not localeCompare: hierarchy order *is* the
  // country and region ids (Section 7.1), and localeCompare collates by the
  // machine's default locale and ICU version, so the same input could get
  // different ids on a different machine.
  const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const hierarchy: HierarchyCountry[] = [...countries.nameByCode.entries()]
    .sort(([a], [b]) => byCodeUnits(a, b))
    .map(([code, name]) => {
      const regionNames = regionNamesByCountry.get(code);
      return {
        code,
        name,
        regions: [...(regionsByCountry.get(code) ?? [])].sort(byCodeUnits),
        ...(regionNames && regionNames.size > 0 ? { regionNames: Object.fromEntries(regionNames) } : {}),
      };
    });
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

  const regionCollection: FeatureCollection<
    Polygon | MultiPolygon,
    { name: string; nameEn?: string; country: string }
  > = {
    type: "FeatureCollection",
    features: [...finalRegions.values()].map((r) => ({
      type: "Feature",
      properties: { name: r.name, ...(r.nameEn ? { nameEn: r.nameEn } : {}), country: r.country },
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
