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
// Reads data/02-resolved/world/{hierarchy.json,regions.geojsonseq,
// country-polygons.geojson,cities-filtered.geojsonseq} and writes the
// same four files, scoped to --only-country/--only-continent. The two
// sequences are copied through record by record, never held whole.
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { peekLeadingProperties, streamGeoJSONSeqRecords } from "./lib/geojsonseqStream.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORLD_DIR = path.join(REPO_ROOT, "data/02-resolved/world");
const HIERARCHY_SOURCE = path.join(WORLD_DIR, "hierarchy.json");
const REGIONS_SOURCE = path.join(WORLD_DIR, "regions.geojsonseq");
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
  writeFileSync(path.join(resolvedOutDir, "country-polygons.geojson"), JSON.stringify(filteredCountries));

  // Regions are a sequence too: unsimplified, the worldwide file is past
  // the ~512MB a single string can hold.
  const regionsOut = createWriteStream(path.join(resolvedOutDir, "regions.geojsonseq"));
  let regionsKept = 0;
  for await (const record of streamGeoJSONSeqRecords(REGIONS_SOURCE)) {
    const properties =
      peekLeadingProperties(record) ?? (JSON.parse(record.toString("utf8")) as Feature).properties ?? undefined;
    const country = (properties as { country?: string } | undefined)?.country;
    if (!country || !countries.has(country)) continue;
    regionsKept++;
    if (!regionsOut.write(Buffer.concat([Buffer.from("\x1e"), record, Buffer.from("\n")]))) {
      await new Promise<void>((resolve) => regionsOut.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    regionsOut.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });

  // Streamed out as a .geojsonseq (RS-delimited, one feature per line),
  // not buffered into one array + JSON.stringify -- Europe alone holds
  // enough of the worldwide 4.4GB cities file to OOM a naive in-memory
  // buffer (confirmed: an earlier version of this script crashed with
  // "JavaScript heap out of memory" on --only-continent Europe). The
  // compressor CLI already accepts .geojsonseq for exactly this reason
  // (see cities.ts) -- output extension here matches that expectation.
  const RECORD_SEPARATOR = Buffer.from("\x1e");
  const NEWLINE = Buffer.from("\n");
  const citiesOut = path.join(resolvedOutDir, "cities-filtered.geojsonseq");
  const out = createWriteStream(citiesOut);
  let scanned = 0;
  let kept = 0;
  // Only each city's properties are parsed (prepare-world.ts writes them
  // ahead of the geometry), and a kept record is copied through as the
  // bytes it was read as: re-stringifying every geometry of a 4.4GB file
  // was most of this script's runtime.
  for await (const record of streamGeoJSONSeqRecords(CITIES_SOURCE)) {
    scanned++;
    if (scanned % 500_000 === 0) console.error(`scanned ${scanned} cities...`);
    const properties =
      peekLeadingProperties(record) ?? (JSON.parse(record.toString("utf8")) as Feature).properties ?? undefined;
    const country = (properties as CityProperties | undefined)?.country;
    if (!country || !countries.has(country)) continue;
    kept++;
    if (!out.write(Buffer.concat([RECORD_SEPARATOR, record, NEWLINE]))) {
      await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
  });

  console.error(
    `wrote ${resolvedOutDir}: ${filteredHierarchy.length} countries, ${regionsKept} regions, ` +
      `${kept} cities (scanned ${scanned})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
