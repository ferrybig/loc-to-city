// Prepares Europe-wide compressor inputs from already-produced data:
//
// - data/00-raw/orphan/eu_cities.geojson (327MB, 202,154 features): the
//   Python prototype's output -- see data/00-raw/orphan/README.md for why
//   this file can't be regenerated. Already has region/country resolved
//   per city (properties: id, name, municipality, region, country) --
//   reused as-is, minus the ~1,700 gap-filled features with no name at
//   all (unlike the NL dataset these have no municipality fallback
//   either; those areas now correctly fall back to region-level
//   resolution instead, which the NL dataset didn't have when this data
//   was built).
// - data/01-extracted/eu/eu-admin.geojson (4.3GB, gitignored, still on
//   disk from the original NL/Europe extraction -- see README's
//   "Reproducing" section for how to regenerate it): streamed, never
//   fully loaded into memory, for admin_level=4 region polygons.
// - data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson: country
//   polygons (already used for country resolution elsewhere in this repo).
//
// The hierarchy itself (which regions exist per country) is derived from
// the (country, region) pairs actually observed on eu_cities.geojson's
// features, not from a from-scratch scan of admin_level=4 -- at this
// scale, unlike the deliberately-contrived Zuid-Holland test, there's no
// need to exercise "a region with 0 cities" on purpose.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import simplify from "@turf/simplify";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import pointOnFeature from "@turf/point-on-feature";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { streamGeoJSONSeq } from "./lib/geojsonseqStream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const CITIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/orphan/eu_cities.geojson");
const ADMIN_SOURCE = path.join(REPO_ROOT, "data/01-extracted/eu/eu-admin.geojson");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/02-resolved/eu/hierarchy.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/02-resolved/eu/cities-filtered.geojson");
const REGIONS_OUT = path.join(REPO_ROOT, "data/02-resolved/eu/regions.geojson");
const COUNTRIES_OUT = path.join(REPO_ROOT, "data/02-resolved/eu/country-polygons.geojson");

// Coarser than the Python prototype's tolerances for these same two
// purposes (scripts/extract_boundaries_europe.py, since removed) --
// region/country polygons are fallback layers here, not the primary
// source of precision (cities carry that), and at continent scale their
// vertex count directly drives the compressor's per-cell classification
// cost -- so regions, which are only a fallback where no city matched,
// stay simplified (unsimplified they are 77x the vertices for a build
// that produces slightly *fewer* records).
//
// Countries no longer are. That tradeoff was rewritten by the
// segment/rectangle classifier: full precision costs ~4 minutes against
// ~30 seconds here, and fixes ~500 of 361,201 sampled points that a
// 5.5km outline places on the wrong side of a coastline or border. See
// README's "How much precision these tolerances cost".
const REGION_SIMPLIFY_TOLERANCE = 0.01; // ~1.1km
const COUNTRY_SIMPLIFY_TOLERANCE = 0; // 0 = keep every vertex

interface NECountryProps {
  ISO_A2_EH?: string;
  NAME?: string;
  POP_EST?: number;
}

function loadCountryPolygons(): {
  featureByCode: Map<string, Feature<Polygon | MultiPolygon, { code: string }>>;
  nameByCode: Map<string, string>;
} {
  const data = JSON.parse(readFileSync(COUNTRIES_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    NECountryProps
  >;

  // A handful of ISO_A2_EH codes (France is the one that matters here)
  // have more than one Natural Earth feature (mainland + a dependency) --
  // keep the most populous one.
  const byCode = new Map<string, Feature<Polygon | MultiPolygon, NECountryProps>>();
  for (const feature of data.features) {
    const code = feature.properties.ISO_A2_EH;
    if (!code || code === "-99") continue;
    const existing = byCode.get(code);
    if (!existing || (feature.properties.POP_EST ?? 0) > (existing.properties.POP_EST ?? 0)) {
      byCode.set(code, feature);
    }
  }

  const featureByCode = new Map<string, Feature<Polygon | MultiPolygon, { code: string }>>();
  const nameByCode = new Map<string, string>();
  for (const [code, feature] of byCode) {
    const simplified =
      COUNTRY_SIMPLIFY_TOLERANCE <= 0 ? feature : simplify(feature, { tolerance: COUNTRY_SIMPLIFY_TOLERANCE });
    featureByCode.set(code, { ...simplified, properties: { code } });
    nameByCode.set(code, feature.properties.NAME ?? code);
  }
  return { featureByCode, nameByCode };
}

function buildHierarchyAndFilterCities(nameByCode: Map<string, string>): {
  hierarchy: HierarchyCountry[];
  cities: FeatureCollection<Polygon | MultiPolygon, CityProperties>;
  neededRegionNamesByCountry: Map<string, Set<string>>;
} {
  const source = JSON.parse(readFileSync(CITIES_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    CityProperties
  >;

  const regionsByCountry = new Map<string, Set<string>>();
  const filteredFeatures: Feature<Polygon | MultiPolygon, CityProperties>[] = [];
  let skippedNoName = 0;
  const skippedNoRegionByCountry = new Map<string, number>();
  for (const feature of source.features) {
    if (feature.properties.name == null) {
      skippedNoName++;
      continue;
    }
    // A real, systemic gap in this data, not a handful of edge cases: some
    // countries' region resolution failed near-completely in the pipeline
    // that produced eu_cities.geojson (Ireland 99.9%, Estonia 100%,
    // Portugal 94% -- almost certainly because those countries don't tag
    // their primary admin division as admin_level=4 the way most of
    // Europe does, the same kind of per-country variance the old city-
    // level admin_level auto-detection existed to handle, just never
    // applied to regions). Without a region name there's no hierarchy
    // entry to group these under, so they're dropped here rather than
    // silently ending up unmatched later -- those areas still resolve at
    // country level, just not city/region level. Worth fixing properly
    // later; flagged loudly in this script's own report below.
    if (feature.properties.region == null) {
      skippedNoRegionByCountry.set(
        feature.properties.country,
        (skippedNoRegionByCountry.get(feature.properties.country) ?? 0) + 1,
      );
      continue;
    }
    filteredFeatures.push(feature);
    let regions = regionsByCountry.get(feature.properties.country);
    if (!regions) {
      regions = new Set();
      regionsByCountry.set(feature.properties.country, regions);
    }
    regions.add(feature.properties.region);
  }
  const skippedNoRegion = [...skippedNoRegionByCountry.values()].reduce((a, b) => a + b, 0);
  console.error(
    `cities: ${filteredFeatures.length} kept, ${skippedNoName} skipped (no name), ` +
      `${skippedNoRegion} skipped (no region -- city/region resolution unavailable there)`,
  );
  if (skippedNoRegionByCountry.size > 0) {
    const worst = [...skippedNoRegionByCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.error(`  no-region counts by country (top 10): ${worst.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  }

  const hierarchy: HierarchyCountry[] = [...regionsByCountry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, regions]) => ({
      code,
      name: nameByCode.get(code) ?? code,
      regions: [...regions].sort((a, b) => a.localeCompare(b)),
    }));

  return {
    hierarchy,
    cities: { type: "FeatureCollection", features: filteredFeatures },
    neededRegionNamesByCountry: regionsByCountry,
  };
}

async function extractRegionPolygons(
  neededRegionNamesByCountry: Map<string, Set<string>>,
  countryFeatureByCode: Map<string, Feature<Polygon | MultiPolygon, { code: string }>>,
): Promise<FeatureCollection<Polygon | MultiPolygon, { name: string; country: string }>> {
  // Which countries (if any) need a region with this exact name -- most
  // names only ever need one, so most regions never need the expensive
  // point-in-polygon disambiguation path below.
  const countriesNeedingName = new Map<string, string[]>();
  for (const [code, names] of neededRegionNamesByCountry) {
    for (const name of names) {
      let list = countriesNeedingName.get(name);
      if (!list) {
        list = [];
        countriesNeedingName.set(name, list);
      }
      list.push(code);
    }
  }

  const found = new Map<string, Feature<Polygon | MultiPolygon, { name: string; country: string }>>(); // key: "country name"
  let scanned = 0;
  let level4 = 0;
  for await (const feature of streamGeoJSONSeq(ADMIN_SOURCE)) {
    scanned++;
    if (scanned % 200000 === 0) {
      console.error(`  ...${scanned} admin features scanned, ${level4} level-4 seen, ${found.size} regions matched`);
    }
    const props = feature.properties as { admin_level?: string; name?: string } | null;
    if (!props || props.admin_level !== "4" || !props.name) continue;
    level4++;

    const candidateCountries = countriesNeedingName.get(props.name);
    if (!candidateCountries || candidateCountries.length === 0) continue;

    const geometry = feature as Feature<Polygon | MultiPolygon>;
    let ownerCode: string | undefined;
    if (candidateCountries.length === 1) {
      ownerCode = candidateCountries[0];
    } else {
      // Genuine name collision across countries: resolve by point-in-
      // polygon against the country boundaries, same technique the
      // now-removed Python pipeline used for country resolution.
      const point = pointOnFeature(geometry);
      for (const code of candidateCountries) {
        const country = countryFeatureByCode.get(code);
        if (country && booleanPointInPolygon(point, country)) {
          ownerCode = code;
          break;
        }
      }
    }
    if (!ownerCode) continue;

    const key = `${ownerCode} ${props.name}`;
    const existing = found.get(key);
    const [minX, minY, maxX, maxY] = bbox(geometry);
    const existingArea = existing ? bbox(existing) : undefined;
    // Prefer the larger bbox when a name+country combination somehow
    // matches more than one relation (duplicate/fragmentary OSM data) --
    // a cheap, order-independent proxy for "more complete".
    if (
      !existing ||
      (existingArea && (maxX - minX) * (maxY - minY) > (existingArea[2] - existingArea[0]) * (existingArea[3] - existingArea[1]))
    ) {
      const simplified = simplify(geometry, { tolerance: REGION_SIMPLIFY_TOLERANCE });
      found.set(key, { ...simplified, properties: { name: props.name, country: ownerCode } });
    }
  }
  console.error(`admin file: ${scanned} features scanned, ${level4} admin_level=4, ${found.size} regions matched`);

  return { type: "FeatureCollection", features: [...found.values()] };
}

async function main(): Promise<void> {
  console.error("Loading country polygons...");
  const { featureByCode, nameByCode } = loadCountryPolygons();

  console.error("Loading and filtering cities, deriving hierarchy...");
  const { hierarchy, cities, neededRegionNamesByCountry } = buildHierarchyAndFilterCities(nameByCode);
  writeFileSync(HIERARCHY_OUT, JSON.stringify(hierarchy));
  writeFileSync(CITIES_OUT, JSON.stringify(cities));
  console.error(
    `wrote ${HIERARCHY_OUT} (${hierarchy.length} countries, ${hierarchy.reduce((n, c) => n + c.regions.length, 0)} regions) and ${CITIES_OUT} (${cities.features.length} cities)`,
  );

  const neededCountryCodes = new Set(hierarchy.map((c) => c.code));
  const countryCollection: FeatureCollection<Polygon | MultiPolygon, { code: string }> = {
    type: "FeatureCollection",
    features: [...featureByCode.entries()]
      .filter(([code]) => neededCountryCodes.has(code))
      .map(([, feature]) => feature),
  };
  writeFileSync(COUNTRIES_OUT, JSON.stringify(countryCollection));
  console.error(`wrote ${COUNTRIES_OUT} (${countryCollection.features.length} countries)`);

  console.error("Streaming the admin export for region polygons (this reads a 4.3GB file, ~20-30s)...");
  const regions = await extractRegionPolygons(neededRegionNamesByCountry, featureByCode);
  writeFileSync(REGIONS_OUT, JSON.stringify(regions));
  console.error(`wrote ${REGIONS_OUT} (${regions.features.length} regions)`);

  const totalNeededRegions = hierarchy.reduce((n, c) => n + c.regions.length, 0);
  if (regions.features.length < totalNeededRegions) {
    console.error(
      `note: ${totalNeededRegions - regions.features.length} of ${totalNeededRegions} regions have no matched polygon ` +
        `(no admin_level=4 relation with that exact name) -- points there will only resolve to country level.`,
    );
  }
}

main();
