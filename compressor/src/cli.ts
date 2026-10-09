#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { buildCGeoDataFileParallel } from "./buildParallel.ts";
import { parseChunkSelection } from "./chunkSelection.ts";
import { loadCities } from "./cities.ts";
import { loadHierarchy } from "./hierarchy.ts";

const KNOWN_FLAGS = new Set([
  "regions",
  "countries",
  "width-exp",
  "height-exp",
  "max-depth",
  "keyframe-exp",
  "attribution",
  "workers",
  "only-chunks",
]);

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // A misspelt flag (--max_depth) would otherwise be dropped silently
      // and the build run, possibly for an hour, with the default instead.
      if (!KNOWN_FLAGS.has(key)) throw new Error(`unknown flag --${key}`);
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

/** A header field (reader/binary-format.md Section 5): a whole number in
 * [0, max]. Anything else would otherwise reach the u8 header as NaN,
 * which Buffer silently writes as 0. */
function headerFlag(flags: Record<string, string>, name: string, fallback: number, max: number): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > max) {
    throw new Error(`--${name} must be a whole number from 0 to ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function formatBytes(bytes: number): string {
  return bytes >= 2 ** 30 ? `${(bytes / 2 ** 30).toFixed(1)}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
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

  const workersFlag = flags.workers;
  const workers = workersFlag === undefined ? availableParallelism() : Number(workersFlag);
  if (!Number.isInteger(workers) || workers < 0) {
    throw new Error(`--workers must be a non-negative integer, got ${JSON.stringify(workersFlag)}`);
  }

  const timings: Array<{ chunkIndex: number; recordCount: number; elapsedMs: number }> = [];

  const widthExp = headerFlag(flags, "width-exp", 6, 15);
  const heightExp = headerFlag(flags, "height-exp", 6, 15);
  const maxDepth = headerFlag(flags, "max-depth", 12, 26);
  const keyframeExp = headerFlag(flags, "keyframe-exp", 7, 255); // reader/binary-format.md Section 7.3
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

  // Loaded only once every flag has checked out: the worldwide city layer
  // takes minutes to read.
  const hierarchy = loadHierarchy(hierarchyPath);
  const cities = await loadCities(citiesPath);
  const regionsPath = flags.regions;
  const regions = regionsPath
    ? (JSON.parse(readFileSync(regionsPath, "utf8")) as FeatureCollection<
        Polygon | MultiPolygon,
        { name: string; country: string }
      >)
    : undefined;
  const countriesPath = flags.countries;
  const countries = countriesPath
    ? (JSON.parse(readFileSync(countriesPath, "utf8")) as FeatureCollection<
        Polygon | MultiPolygon,
        { code: string }
      >)
    : undefined;
  const loaded = process.memoryUsage();
  console.error(
    `loaded inputs: ${formatBytes(loaded.rss)} resident (JS heap ${formatBytes(loaded.heapUsed)}, ` +
      `array buffers ${formatBytes(loaded.arrayBuffers)} -- mostly packed city geometry)`,
  );

  const options = {
    attribution: flags.attribution ?? "",
    widthExp,
    heightExp,
    maxDepth,
    keyframeExp,
    regions,
    countries,
    workers,
    onlyChunks,
    onChunkBuilt: (info: { chunkIndex: number; jobCount: number; recordCount: number; elapsedMs: number }) => {
      timings.push({ chunkIndex: info.chunkIndex, recordCount: info.recordCount, elapsedMs: info.elapsedMs });
      // Out of the chunks that do work at all, not the whole grid: most of
      // a worldwide grid is ocean that never becomes a job.
      const percentage = (timings.length / info.jobCount) * 100;
      console.error(
        `  [${timings.length}/${info.jobCount} ${percentage.toFixed(0)}%] chunk ${info.chunkIndex}: ` +
          `${info.recordCount} records, ${info.elapsedMs.toFixed(0)}ms`,
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

  // Covers the whole process, worker threads included. maxRSS is in KiB
  // on every platform (libuv's ru_maxrss; PeakWorkingSetSize on Windows).
  console.error(`peak memory: ${formatBytes(process.resourceUsage().maxRSS * 1024)} resident, main thread and workers together`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
