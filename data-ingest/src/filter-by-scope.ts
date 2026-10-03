// Filters the worldwide pipeline's already-resolved output
// (data/02-resolved/world/*, produced by prepare-world.ts) down to a
// country or continent scope, for building a smaller test dataset
// (zuid-holland.bin, europe.bin) without either resurrecting the deleted
// Python prototype or re-deriving per-country admin_level resolution
// separately for just that scope -- prepare-world.ts's resolution is
// already correct for every country (see data/00-raw/orphan/README.md
// for the investigation that led here), so this is a pure post-hoc
// filter over its output, not a second resolution pass.
//
// Reads data/02-resolved/world/{hierarchy.json,regions.geojson,
// country-polygons.geojson,cities-filtered.geojsonseq} and writes the
// same four shapes, scoped to --only-country/--only-continent, as plain
// (non-streamed) .json/.geojson -- the compressor CLI already accepts
// either .geojson or .geojsonseq for cities (see cities.ts), and a
// country- or continent-scale cities file is small enough to hold in
// memory, unlike the 4.4GB worldwide one.
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { streamGeoJSONSeq } from "./lib/geojsonseqStream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORLD_DIR = path.join(REPO_ROOT, "data/02-resolved/world");
const HIERARCHY_SOURCE = path.join(WORLD_DIR, "hierarchy.json");
const REGIONS_SOURCE = path.join(WORLD_DIR, "regions.geojson");
const COUNTRIES_SOURCE = path.join(WORLD_DIR, "country-polygons.geojson");
const CITIES_SOURCE = path.join(WORLD_DIR, "cities-filtered.geojsonseq");

const NATURAL_EARTH_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");

interface NECountryProps {
  ISO_A2_EH?: string;
  ISO_A2?: string;
  CONTINENT?: string;
}

function parseArgs(argv: string[]): { countries: Set<string>; outDir: string } {
  const onlyCountry: string[] = [];
  let onlyContinent: string | undefined;
  let outDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only-country") {
      const value = argv[++i];
      if (!value) throw new Error("--only-country needs a value");
      onlyCountry.push(...value.split(",").map((c) => c.trim().toUpperCase()));
    } else if (arg === "--only-continent") {
      onlyContinent = argv[++i];
      if (!onlyContinent) throw new Error("--only-continent needs a value");
    } else if (arg === "--out-dir") {
      outDir = argv[++i];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (onlyCountry.length === 0 && !onlyContinent) {
    throw new Error("filter-by-scope.ts needs --only-country <CODE[,CODE...]> or --only-continent <name>, plus --out-dir <dir>");
  }
  if (onlyCountry.length > 0 && onlyContinent) {
    throw new Error("--only-country and --only-continent are mutually exclusive");
  }
  if (!outDir) throw new Error("filter-by-scope.ts needs --out-dir <dir>");

  let countries: Set<string>;
  if (onlyContinent) {
    const ne = JSON.parse(readFileSync(NATURAL_EARTH_SOURCE, "utf8")) as FeatureCollection<
      Polygon | MultiPolygon,
      NECountryProps
    >;
    countries = new Set(
      ne.features
        .filter((f) => f.properties.CONTINENT === onlyContinent)
        .map((f) => f.properties.ISO_A2_EH ?? f.properties.ISO_A2)
        .filter((c): c is string => Boolean(c) && c !== "-99"),
    );
    if (countries.size === 0) {
      throw new Error(`no countries found for --only-continent ${onlyContinent} (check Natural Earth's CONTINENT spelling, e.g. "Europe")`);
    }
  } else {
    countries = new Set(onlyCountry);
  }

  return { countries, outDir };
}

async function main(): Promise<void> {
  const { countries, outDir } = parseArgs(process.argv.slice(2));
  const resolvedOutDir = path.isAbsolute(outDir) ? outDir : path.join(REPO_ROOT, outDir);

  const hierarchy = JSON.parse(readFileSync(HIERARCHY_SOURCE, "utf8")) as HierarchyCountry[];
  const filteredHierarchy = hierarchy.filter((c) => countries.has(c.code));
  if (filteredHierarchy.length === 0) {
    throw new Error(`none of [${[...countries].join(", ")}] found in ${HIERARCHY_SOURCE}`);
  }

  const regionsIn = JSON.parse(readFileSync(REGIONS_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    { name: string; nameEn?: string; country: string }
  >;
  const filteredRegions: typeof regionsIn = {
    type: "FeatureCollection",
    features: regionsIn.features.filter((f) => countries.has(f.properties.country)),
  };

  const countriesIn = JSON.parse(readFileSync(COUNTRIES_SOURCE, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    { code: string }
  >;
  const filteredCountries: typeof countriesIn = {
    type: "FeatureCollection",
    features: countriesIn.features.filter((f) => countries.has(f.properties.code)),
  };

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(resolvedOutDir, { recursive: true });

  writeFileSync(path.join(resolvedOutDir, "hierarchy.json"), JSON.stringify(filteredHierarchy));
  writeFileSync(path.join(resolvedOutDir, "regions.geojson"), JSON.stringify(filteredRegions));
  writeFileSync(path.join(resolvedOutDir, "country-polygons.geojson"), JSON.stringify(filteredCountries));

  // Streamed out as a .geojsonseq (RS-delimited, one feature per line),
  // not buffered into one array + JSON.stringify -- Europe alone holds
  // enough of the worldwide 4.4GB cities file to OOM a naive in-memory
  // buffer (confirmed: an earlier version of this script crashed with
  // "JavaScript heap out of memory" on --only-continent Europe). The
  // compressor CLI already accepts .geojsonseq for exactly this reason
  // (see cities.ts) -- output extension here matches that expectation.
  const RECORD_SEPARATOR = "\x1e";
  const citiesOut = path.join(resolvedOutDir, "cities-filtered.geojsonseq");
  const out = createWriteStream(citiesOut);
  let scanned = 0;
  let kept = 0;
  for await (const feature of streamGeoJSONSeq(CITIES_SOURCE)) {
    scanned++;
    if (scanned % 500_000 === 0) console.error(`scanned ${scanned} cities...`);
    const country = (feature.properties as CityProperties | null)?.country;
    if (!country || !countries.has(country)) continue;
    kept++;
    if (!out.write(`${RECORD_SEPARATOR}${JSON.stringify(feature)}\n`)) {
      await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });

  console.error(
    `wrote ${resolvedOutDir}: ${filteredHierarchy.length} countries, ${filteredRegions.features.length} regions, ` +
      `${kept} cities (scanned ${scanned})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
