import type { HierarchyCountry } from "./hierarchy.ts";
import type { CityCollection } from "./placeIds.ts";
import { prepareBuild, finishBuild, type BuildOptions, type BuildStats } from "./buildCore.ts";
import { enumerateChunkJobs } from "./chunkJobs.ts";
import { runChunkJobs } from "./chunkWorkerPool.ts";
import { buildCGeoDataFile } from "./build.ts";

export interface ParallelBuildOptions extends BuildOptions {
  /** Number of worker threads. `0` delegates to the plain sequential
   * `buildCGeoDataFile` (no threads at all, the byte-identity oracle this
   * is checked against). `1` still spawns a real worker rather than
   * short-circuiting -- that makes it a genuine measurement control,
   * isolating serialization overhead from parallelism itself. */
  workers: number;
}

/** Worker-pool build: same output as `buildCGeoDataFile` (bytes and stats
 * are byte-for-byte/deep-equal identical regardless of worker count --
 * chunk order never affects the result, `writer.ts` only cares about the
 * final `chunkBytes` array), just spread across `options.workers` threads.
 * See buildCore.ts/chunkJobs.ts/chunkWorkerPool.ts for how the pieces
 * divide up. */
export async function buildCGeoDataFileParallel(
  hierarchy: HierarchyCountry[],
  cities: CityCollection,
  options: ParallelBuildOptions,
): Promise<{ bytes: Buffer; stats: BuildStats }> {
  if (options.workers === 0) {
    return buildCGeoDataFile(hierarchy, cities, options);
  }

  const prepared = prepareBuild(hierarchy, cities, options);
  const { candidateIndex, width, height } = prepared;

  const jobs = enumerateChunkJobs(candidateIndex, width, height, options.onlyChunks);
  // Reported from inside the pool as each chunk lands rather than from the
  // loop below, so progress is visible while the build runs instead of
  // arriving all at once after every chunk is already done. The pool has no
  // notion of the grid, so the chunk count is filled in here.
  const results = await runChunkJobs(jobs, options.workers, options.maxDepth, (result) => {
    options.onChunkBuilt?.({
      chunkIndex: result.chunkIndex,
      chunkCount: width * height,
      jobCount: jobs.length,
      recordCount: result.recordCount,
      elapsedMs: result.elapsedMs,
    });
  });

  const chunkBytes: (Buffer | null)[] = new Array(width * height).fill(null);
  let totalRecords = 0;
  let nonEmptyChunkCount = 0;
  for (const result of results) {
    if (result.bytes === null) continue;
    chunkBytes[result.chunkIndex] = result.bytes;
    totalRecords += result.recordCount;
    nonEmptyChunkCount++;
  }

  return finishBuild(prepared, options, chunkBytes, totalRecords, nonEmptyChunkCount);
}
