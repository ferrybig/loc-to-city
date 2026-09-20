#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { loadHierarchy } from "./hierarchy.js";
import { buildCGeoDataFileParallel } from "./buildParallel.js";
import { parseChunkSelection } from "./chunkSelection.js";
import { loadCities } from "./cities.js";
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
      "usage: cgeodata-compress <hierarchy.json> <cities.geojson|.geojsonseq> <out.bin> " +
        "[--regions regions.geojson] [--countries countries.geojson] " +
        "[--width-exp N] [--height-exp N] [--max-depth N] [--keyframe-exp N] [--attribution TEXT] " +
        "[--workers N] [--only-chunks LIST]\n" +
        "  --only-chunks takes indices and inclusive ranges (e.g. '200' or '200,300-500'); " +
        "every other chunk is left empty. '' builds no chunks at all, just the place table.",
    );
    process.exitCode = 1;
    return;
  }

  const hierarchy = loadHierarchy(hierarchyPath);
  const cities = await loadCities(citiesPath);
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

  const timings: Array<{ chunkIndex: number; recordCount: number; elapsedMs: number }> = [];

  const widthExp = Number(flags["width-exp"] ?? 6);
  const heightExp = Number(flags["height-exp"] ?? 6);
  const chunkCount = 2 ** widthExp * 2 ** heightExp;

  const onlyChunksFlag = flags["only-chunks"];
  const onlyChunks = onlyChunksFlag === undefined ? undefined : parseChunkSelection(onlyChunksFlag);
  if (onlyChunks) {
    const outOfRange = [...onlyChunks].find((index) => index >= chunkCount);
    if (outOfRange !== undefined) {
      throw new Error(
        `--only-chunks selects chunk ${outOfRange}, but this grid only has ${chunkCount} chunks (0-${chunkCount - 1})`,
      );
    }
    console.error(`--only-chunks: building ${onlyChunks.size} of ${chunkCount} chunks, leaving the rest empty`);
  }

  const options = {
    attribution: flags["attribution"] ?? "",
    widthExp,
    heightExp,
    maxDepth: Number(flags["max-depth"] ?? 12),
    keyframeExp: Number(flags["keyframe-exp"] ?? 13),
    regions,
    countries,
    workers,
    onlyChunks,
    onChunkBuilt: (info: { chunkIndex: number; chunkCount: number; recordCount: number; elapsedMs: number }) => {
      timings.push({ chunkIndex: info.chunkIndex, recordCount: info.recordCount, elapsedMs: info.elapsedMs });
      console.error(
        `  chunk ${info.chunkIndex}/${info.chunkCount}: ${info.recordCount} records, ${info.elapsedMs.toFixed(0)}ms`,
      );
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

  if (timings.length > 0) {
    const totalChunkMs = timings.reduce((sum, t) => sum + t.elapsedMs, 0);
    console.error(
      `chunk time: ${(totalChunkMs / 1000).toFixed(1)}s of work across ${timings.length} chunks ` +
        `(mean ${(totalChunkMs / timings.length).toFixed(0)}ms)`,
    );
    const slowest = [...timings].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 10);
    console.error("slowest chunks (rerun one on its own with --only-chunks N):");
    for (const t of slowest) {
      console.error(`  chunk ${t.chunkIndex}: ${(t.elapsedMs / 1000).toFixed(1)}s, ${t.recordCount} records`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
