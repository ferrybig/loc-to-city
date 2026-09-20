import type { IndexedCandidate, CandidateIndex } from "./candidateIndex.js";
import { chunkBoundsOf } from "./buildCore.js";
import type { CellBounds } from "./geometry.js";

/** One chunk's worth of work: everything a worker needs to reproduce
 * `buildChunkRecords` + `encodeChunk` for this chunk, with no further
 * access to the spatial index. `candidates` must be in exactly the order
 * `CandidateIndex.candidatesForBbox` returned it (see quadtree.ts's doc
 * comment on why order is load-bearing, not just which candidates). */
export interface ChunkJob {
  chunkIndex: number;
  bounds: CellBounds;
  candidates: IndexedCandidate[];
  /** Sum of candidate coordinate counts, a cheap proxy for how expensive
   * this chunk's `touches()`/`fullyContains()` work will be. Used to sort
   * jobs worst-first so the pool doesn't strand a slow chunk near the end. */
  cost: number;
}

export type WorkerRequest = { type: "job"; job: ChunkJob } | { type: "exit" };

export type WorkerResponse =
  | { type: "done"; chunkIndex: number; recordCount: number; bytes: Uint8Array | null }
  | { type: "failed"; chunkIndex: number; message: string; stack: string | undefined };

export interface ChunkWorkerData {
  maxDepth: number;
}

function coordinateCount(candidate: IndexedCandidate): number {
  const geometry = candidate.feature.geometry;
  if (geometry.type === "Polygon") {
    return geometry.coordinates.reduce((n, ring) => n + ring.length, 0);
  }
  return geometry.coordinates.reduce((n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0), 0);
}

/** Walks every chunk in the `width x height` grid, runs the root bbox
 * query once per chunk (cheap -- this is the same query the sequential
 * path does inline), and returns one job per chunk whose query wasn't
 * empty, sorted by estimated cost descending. Chunks with no candidates at
 * all are skipped entirely (never became a job, never become a Buffer --
 * matches the sequential path's `continue` on an empty root query), as are
 * chunks excluded by `onlyChunks` (see `BuildOptions.onlyChunks`). */
export function enumerateChunkJobs(
  candidateIndex: CandidateIndex,
  width: number,
  height: number,
  onlyChunks?: ReadonlySet<number> | undefined,
): ChunkJob[] {
  const jobs: ChunkJob[] = [];
  for (let chunkIndex = 0; chunkIndex < width * height; chunkIndex++) {
    if (onlyChunks && !onlyChunks.has(chunkIndex)) continue;

    const bounds = chunkBoundsOf(chunkIndex, width, height);
    const candidates = candidateIndex.candidatesForBbox(bounds.lonMin, bounds.latMin, bounds.lonMax, bounds.latMax);
    if (candidates.length === 0) continue;
    const cost = candidates.reduce((sum, c) => sum + coordinateCount(c), 0);
    jobs.push({ chunkIndex, bounds, candidates, cost });
  }
  jobs.sort((a, b) => b.cost - a.cost);
  return jobs;
}
