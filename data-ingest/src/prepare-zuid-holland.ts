// Filters the already-committed data/00-raw/orphan/nl_cities.geojson (the
// NL-only Python prototype's output -- see data/00-raw/orphan/README.md
// for why this file can't be regenerated) down to a small
// Zuid-Holland-only test dataset, and writes the hierarchy file that
// lists all 12 Dutch provinces (Section 7.2 allows a region to have 0
// cities -- this is what lets that be tested without a full Netherlands
// build).
//
// It also extracts real region (province) and country polygons, so points
// outside any of Zuid-Holland's 187 city polygons but still inside a
// province -- or inside the Netherlands but outside any known province --
// resolve to that region/country instead of "unknown" (Section 7.1: "a cell
// whose most specific known place is a region resolves to that region").
// Provinces come from data/01-extracted/nl/nl-admin.geojson (the raw osmium
// export, admin_level=4 -- see README's "Reproducing" section for how it's
// produced); the country polygon comes from Natural Earth, the same source
// prepare-europe.ts uses for country resolution.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import simplify from "@turf/simplify";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { readGeoJSONSeq } from "./lib/geojsonseq.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const CITIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/orphan/nl_cities.geojson");
const PROVINCES_SOURCE = path.join(REPO_ROOT, "data/01-extracted/nl/nl-admin.geojson");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/02-resolved/nl/regions.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/02-resolved/nl/zuid-holland-cities.geojson");
const PROVINCES_OUT = path.join(REPO_ROOT, "data/02-resolved/nl/provinces.geojson");
const COUNTRY_OUT = path.join(REPO_ROOT, "data/02-resolved/nl/country.geojson");

// Same tolerances (in degrees) the Python prototype settled on for these
// same two purposes (scripts/extract_boundaries_europe.py).
const REGION_SIMPLIFY_TOLERANCE = 0.002; // ~220m
const COUNTRY_SIMPLIFY_TOLERANCE = 0.01; // ~1.1km

// Confirmed by direct inspection of data/00-raw/orphan/nl_cities.geojson's
// `region` property (12 provinces, alphabetical).
const NL_PROVINCES = [
  "Drenthe",
  "Flevoland",
  "Fryslân",
  "Gelderland",
  "Groningen",
  "Limburg",
  "Noord-Brabant",
  "Noord-Holland",
  "Overijssel",
  "Utrecht",
  "Zeeland",
  "Zuid-Holland",
];

function buildCities(): number {
  const source = JSON.parse(readFileSync(CITIES_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    CityProperties
  >;
  const filtered: FeatureCollection<Polygon | MultiPolygon, CityProperties> = {
    type: "FeatureCollection",
    features: source.features
      .filter((f) => f.properties.region === "Zuid-Holland")
      .map((f) => {
        // A handful of gap-filled features (extract_boundaries.py's
        // "nl-gen-*" ids) have no specific place name, only a municipality
        // -- fall back to that rather than violating Section 7.4's "MUST
        // NOT be empty" for the local name.
        if (f.properties.name != null) return f;
        const municipality = f.properties.municipality;
        if (municipality == null) {
          throw new Error(`feature ${String(f.properties.id)} has neither a name nor a municipality`);
        }
        return { ...f, properties: { ...f.properties, name: String(municipality) } };
      }),
  };
  writeFileSync(CITIES_OUT, JSON.stringify(filtered));
  console.error(`wrote ${CITIES_OUT} (${filtered.features.length} of ${source.features.length} NL cities)`);
  return filtered.features.length;
}

function buildProvinces(): number {
  const features = readGeoJSONSeq(PROVINCES_SOURCE) as Feature<Polygon | MultiPolygon, { admin_level?: string; name?: string }>[];
  const provinces = features.filter((f) => f.properties.admin_level === "4");

  const found = new Set(provinces.map((f) => f.properties.name));
  const missing = NL_PROVINCES.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`missing province geometry for: ${missing.join(", ")}`);
  }

  const collection: FeatureCollection<Polygon | MultiPolygon, { name: string; country: string }> = {
    type: "FeatureCollection",
    features: provinces.map((f) => {
      const simplified = simplify(f, { tolerance: REGION_SIMPLIFY_TOLERANCE });
      return { ...simplified, properties: { name: f.properties.name!, country: "NL" } };
    }),
  };
  writeFileSync(PROVINCES_OUT, JSON.stringify(collection));
  console.error(`wrote ${PROVINCES_OUT} (${collection.features.length} provinces)`);
  return collection.features.length;
}

function buildCountry(): void {
  const data = JSON.parse(readFileSync(COUNTRIES_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    { ISO_A2_EH?: string; NAME?: string }
  >;
  const netherlands = data.features.find((f) => f.properties.ISO_A2_EH === "NL");
  if (!netherlands) throw new Error("Netherlands not found in Natural Earth countries file");

  const simplified = simplify(netherlands, { tolerance: COUNTRY_SIMPLIFY_TOLERANCE });
  const collection: FeatureCollection<Polygon | MultiPolygon, { code: string }> = {
    type: "FeatureCollection",
    features: [{ ...simplified, properties: { code: "NL" } }],
  };
  writeFileSync(COUNTRY_OUT, JSON.stringify(collection));
  console.error(`wrote ${COUNTRY_OUT}`);
}

function main(): void {
  const hierarchy: HierarchyCountry[] = [
    { code: "NL", name: "Nederland|The Netherlands", regions: NL_PROVINCES },
  ];
  writeFileSync(HIERARCHY_OUT, JSON.stringify(hierarchy, null, 2) + "\n");
  console.error(`wrote ${HIERARCHY_OUT} (${hierarchy[0]!.regions.length} regions)`);

  buildCities();
  buildProvinces();
  buildCountry();
}

main();
