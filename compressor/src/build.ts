import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { HierarchyCountry } from "./hierarchy.js";
import type { CityProperties } from "./placeIds.js";
import { buildChunkRecords } from "./quadtree.js";
import { encodeChunk } from "./chunkEncoder.js";
import { prepareBuild, chunkBoundsOf, finishBuild, type BuildOptions, type BuildStats } from "./buildCore.js";

export type { BuildOptions, BuildStats } from "./buildCore.js";

/** Sequential, single-threaded reference build: no worker threads, no
 * serialization overhead. Used by the fast synthetic unit tests, and as
 * the byte-identity oracle `buildParallel.ts` is checked against (it's
 * also exactly what `--workers 0` runs). */
export function buildCGeoDataFile(
  hierarchy: HierarchyCountry[],
  cities: FeatureCollection<Polygon | MultiPolygon, CityProperties>,
  options: BuildOptions,
): { bytes: Buffer; stats: BuildStats } {
  const prepared = prepareBuild(hierarchy, cities, options);
  const { candidateIndex, width, height } = prepared;
  const chunkBytes: (Buffer | null)[] = new Array(width * height).fill(null);

  let totalRecords = 0;
  let nonEmptyChunkCount = 0;
  for (let chunkIndex = 0; chunkIndex < width * height; chunkIndex++) {
    if (options.onlyChunks && !options.onlyChunks.has(chunkIndex)) continue;

    const bounds = chunkBoundsOf(chunkIndex, width, height);
    const rootCandidates = candidateIndex.candidatesForBbox(bounds.lonMin, bounds.latMin, bounds.lonMax, bounds.latMax);
    if (rootCandidates.length === 0) continue;

    const startedAt = performance.now();
    const records = buildChunkRecords(rootCandidates, bounds, options.maxDepth);
    const encoded = records.length === 0 ? null : encodeChunk(records);
    const elapsedMs = performance.now() - startedAt;

    options.onChunkBuilt?.({ chunkIndex, chunkCount: width * height, recordCount: records.length, elapsedMs });
    if (encoded === null) continue;

    chunkBytes[chunkIndex] = encoded;
    totalRecords += records.length;
    nonEmptyChunkCount++;
  }

  return finishBuild(prepared, options, chunkBytes, totalRecords, nonEmptyChunkCount);
}
