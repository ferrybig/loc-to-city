import type { HierarchyCountry } from "./hierarchy.ts";
import type { CityCollection } from "./placeIds.ts";
import { buildChunkRecords } from "./quadtree.ts";
import { encodeChunk } from "./chunkEncoder.ts";
import { prepareBuild, finishBuild, type BuildOptions, type BuildStats } from "./buildCore.ts";
import { enumerateChunkJobs } from "./chunkJobs.ts";

export type { BuildOptions, BuildStats } from "./buildCore.ts";

/** Sequential, single-threaded reference build: no worker threads, no
 * serialization overhead. Used by the fast synthetic unit tests, and as
 * the byte-identity oracle `buildParallel.ts` is checked against (it's
 * also exactly what `--workers 0` runs). */
export function buildCGeoDataFile(
  hierarchy: HierarchyCountry[],
  cities: CityCollection,
  options: BuildOptions,
): { bytes: Buffer; stats: BuildStats } {
  const prepared = prepareBuild(hierarchy, cities, options);
  const { candidateIndex, width, height } = prepared;
  const chunkBytes: (Buffer | null)[] = new Array(width * height).fill(null);
  // The same jobs the worker pool runs (so both paths agree on which
  // chunks do work, and know up front how many), just in chunk-index order
  // instead of worst-first.
  const jobs = enumerateChunkJobs(candidateIndex, width, height, options.onlyChunks).sort(
    (a, b) => a.chunkIndex - b.chunkIndex,
  );

  let totalRecords = 0;
  let nonEmptyChunkCount = 0;
  for (const { chunkIndex, bounds, candidates } of jobs) {
    const startedAt = performance.now();
    const records = buildChunkRecords(candidates, bounds, options.maxDepth);
    const encoded = records.length === 0 ? null : encodeChunk(records);
    const elapsedMs = performance.now() - startedAt;

    options.onChunkBuilt?.({
      chunkIndex,
      chunkCount: width * height,
      jobCount: jobs.length,
      recordCount: records.length,
      elapsedMs,
    });
    if (encoded === null) continue;

    chunkBytes[chunkIndex] = encoded;
    totalRecords += records.length;
    nonEmptyChunkCount++;
  }

  return finishBuild(prepared, options, chunkBytes, totalRecords, nonEmptyChunkCount);
}
