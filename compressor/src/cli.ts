#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { loadHierarchy } from "./hierarchy.js";
import { buildCGeoDataFileParallel } from "./buildParallel.js";
import type { CityProperties } from "./placeIds.js";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for --${key}`);
      flags[key] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [hierarchyPath, citiesPath, outPath] = positional;
  if (!hierarchyPath || !citiesPath || !outPath) {
    console.error(
      "usage: cgeodata-compress <hierarchy.json> <cities.geojson> <out.bin> " +
        "[--regions regions.geojson] [--countries countries.geojson] " +
        "[--width-exp N] [--height-exp N] [--max-depth N] [--keyframe-exp N] [--attribution TEXT] " +
        "[--workers N]",
    );
    process.exitCode = 1;
    return;
  }

  const hierarchy = loadHierarchy(hierarchyPath);
  const cities = JSON.parse(readFileSync(citiesPath, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    CityProperties
  >;
  const regionsPath = flags["regions"];
  const regions = regionsPath
    ? (JSON.parse(readFileSync(regionsPath, "utf8")) as FeatureCollection<
        Polygon | MultiPolygon,
        { name: string; country: string }
      >)
    : undefined;
  const countriesPath = flags["countries"];
  const countries = countriesPath
    ? (JSON.parse(readFileSync(countriesPath, "utf8")) as FeatureCollection<
        Polygon | MultiPolygon,
        { code: string }
      >)
    : undefined;

  const workersFlag = flags["workers"];
  const workers = workersFlag === undefined ? availableParallelism() : Number(workersFlag);
  if (!Number.isInteger(workers) || workers < 0) {
    throw new Error(`--workers must be a non-negative integer, got ${JSON.stringify(workersFlag)}`);
  }

  const options = {
    attribution: flags["attribution"] ?? "",
    widthExp: Number(flags["width-exp"] ?? 6),
    heightExp: Number(flags["height-exp"] ?? 6),
    maxDepth: Number(flags["max-depth"] ?? 12),
    keyframeExp: Number(flags["keyframe-exp"] ?? 13),
    regions,
    countries,
    workers,
    onChunkBuilt: ({ chunkIndex, chunkCount, recordCount }: { chunkIndex: number; chunkCount: number; recordCount: number }) => {
      console.error(`  chunk ${chunkIndex}/${chunkCount}: ${recordCount} records`);
    },
  };

  console.error(`building with ${workers} worker${workers === 1 ? "" : "s"}${workers === 0 ? " (sequential)" : ""}...`);
  const { bytes, stats } = await buildCGeoDataFileParallel(hierarchy, cities, options);
  writeFileSync(outPath, bytes);

  console.error(
    `wrote ${outPath}: ${stats.fileBytes} bytes, ${stats.countryCount} countries, ` +
      `${stats.regionCount} regions, ${stats.cityCount} cities ` +
      `(${stats.unmatchedCityCount} unmatched), ${stats.nonEmptyChunkCount}/${stats.chunkCount} ` +
      `non-empty chunks, ${stats.totalRecords} records`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
