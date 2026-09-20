import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { ChunkJob, ChunkWorkerData, WorkerRequest, WorkerResponse } from "./chunkJobs.js";

const WORKER_URL = new URL("./chunkWorker.js", import.meta.url);

export interface ChunkResult {
  chunkIndex: number;
  recordCount: number;
  bytes: Buffer | null;
  /** Wall-clock time this chunk's quadtree + encode took inside its
   * worker, excluding queueing and message passing. */
  elapsedMs: number;
}

/** Runs every job in `jobs` across a pool of `min(workerCount,
 * jobs.length)` worker threads, resolving once every job has produced a
 * result (order is whichever worker finishes next, not job order). Jobs
 * are already sorted worst-first by `enumerateChunkJobs`; each worker is
 * simply handed the next queued job whenever it's free (pull-based), so
 * the ~1000x skew between the cheapest and most expensive chunk can't
 * strand one worker with every hard chunk while others sit idle.
 *
 * `onResult` fires as each result lands, before the promise settles. That
 * matters for progress reporting: a worldwide build runs for over an hour,
 * and a caller that only sees results from the resolved array prints
 * nothing at all until the very end -- silence indistinguishable from a
 * hang. A callback that throws is treated like any other failure below.
 *
 * Fails fast: the first error from any source (a thrown exception inside
 * a worker, an unexpected worker exit, an explicit `failed` message for
 * a caught error, or a throwing `onResult`) terminates every worker and
 * rejects. No partial output is ever produced by this function -- that's
 * the caller's job once every result is in. */
export function runChunkJobs(
  jobs: ChunkJob[],
  workerCount: number,
  maxDepth: number,
  onResult?: (result: ChunkResult) => void,
): Promise<ChunkResult[]> {
  return new Promise((resolve, reject) => {
    if (jobs.length === 0) {
      resolve([]);
      return;
    }

    const poolSize = Math.max(1, Math.min(workerCount, jobs.length));
    const queue = [...jobs];
    const results: ChunkResult[] = [];
    const workers: Worker[] = [];
    const inFlight = new Map<Worker, number | null>(); // worker -> chunkIndex currently running, or null once idle
    let settled = false;

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      Promise.allSettled(workers.map((w) => w.terminate())).finally(() => reject(error));
    }

    // Always the right call after a worker becomes free, whether that's at
    // startup or after a result: hands it the next queued job, or -- once
    // the queue is empty -- tells that one worker to exit. Called exactly
    // once per worker per "becoming free" event, so no worker is ever sent
    // more than one exit message.
    function dispatchNext(worker: Worker): void {
      const job = queue.shift();
      if (!job) {
        inFlight.set(worker, null);
        const request: WorkerRequest = { type: "exit" };
        worker.postMessage(request);
        return;
      }
      inFlight.set(worker, job.chunkIndex);
      const request: WorkerRequest = { type: "job", job };
      worker.postMessage(request);
    }

    for (let i = 0; i < poolSize; i++) {
      const workerData: ChunkWorkerData = { maxDepth };
      const worker = new Worker(WORKER_URL, { workerData });
      workers.push(worker);

      worker.on("message", (response: WorkerResponse) => {
        if (settled) return;
        if (response.type === "failed") {
          fail(new Error(`chunk ${response.chunkIndex} failed: ${response.message}\n${response.stack ?? ""}`));
          return;
        }
        const bytes =
          response.bytes === null
            ? null
            : Buffer.from(response.bytes.buffer, response.bytes.byteOffset, response.bytes.byteLength);
        const result: ChunkResult = {
          chunkIndex: response.chunkIndex,
          recordCount: response.recordCount,
          bytes,
          elapsedMs: response.elapsedMs,
        };
        results.push(result);

        if (onResult) {
          try {
            onResult(result);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }

        if (results.length === jobs.length) {
          settled = true;
          resolve(results);
        }
        // Always dispatch, even after resolving: this worker still needs
        // its own exit message (the queue is empty by now, so it gets one).
        dispatchNext(worker);
      });

      worker.on("error", (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });

      worker.on("exit", (code) => {
        if (settled) return;
        // A worker exiting after we told it to (inFlight === null) is
        // normal shutdown for a pool that ran out of work for it early.
        // Anything else -- exiting with a job still assigned, or a
        // nonzero code -- means it died mid-work (OOM kill, uncaught
        // fatal error) and would otherwise leave this promise pending
        // forever.
        const chunkIndex = inFlight.get(worker);
        if (chunkIndex !== undefined && chunkIndex !== null) {
          fail(new Error(`worker exited (code ${code}) while processing chunk ${chunkIndex}`));
        } else if (code !== 0) {
          fail(new Error(`worker exited with code ${code}`));
        }
      });

      dispatchNext(worker);
    }
  });
}

// Re-exported so callers that only need the URL (e.g. to sanity-check the
// worker script resolves) don't have to re-derive it.
export const chunkWorkerUrl = fileURLToPath(WORKER_URL);
