import { parentPort, workerData } from "node:worker_threads";
import { encodeChunk } from "./chunkEncoder.ts";
import type { ChunkWorkerData, WorkerRequest, WorkerResponse } from "./chunkJobs.ts";
import { buildChunkRecords } from "./quadtree.ts";

// Deliberately does not import candidateIndex.js/rbush/hierarchy.js -- this
// worker only ever receives an already-queried candidate array, never
// touches the spatial index itself, so there's no reason to pay for
// loading rbush (or anything hierarchy-related) in every one of the pool's
// threads.

if (!parentPort) {
  throw new Error("chunkWorker.js must be run as a worker_threads Worker");
}
const port = parentPort;
const { maxDepth } = workerData as ChunkWorkerData;

port.on("message", (request: WorkerRequest) => {
  if (request.type === "exit") {
    port.close();
    return;
  }

  const { chunkIndex, bounds, candidates } = request.job;
  try {
    // Spans exactly the same work the sequential path times, so the two
    // paths' per-chunk numbers are comparable.
    const startedAt = performance.now();
    const records = buildChunkRecords(candidates, bounds, maxDepth);
    const bytes = records.length === 0 ? null : encodeChunk(records, maxDepth);
    const elapsedMs = performance.now() - startedAt;
    const response: WorkerResponse = { type: "done", chunkIndex, recordCount: records.length, bytes, elapsedMs };
    port.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      type: "failed",
      chunkIndex,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    port.postMessage(response);
  }
});
