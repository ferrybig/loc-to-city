import { availableParallelism } from "node:os";
import { parentPort, Worker } from "node:worker_threads";
import type { Transferable } from "node:worker_threads";

/** How many threads a pool gets unless the caller says otherwise:
 * `PREPARE_WORKERS` (0 runs every task on the main thread instead, the
 * sequential path the parallel one must match), else one per core. */
export function defaultWorkerCount(): number {
  const env = process.env["PREPARE_WORKERS"];
  if (env !== undefined && env !== "") return Math.max(0, Number(env));
  return availableParallelism();
}

export interface TaskRequest {
  id: number;
  kind: string;
  payload: unknown;
}

export type TaskResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; message: string; stack?: string | undefined };

/** A task handler: what a worker module registers per `kind`. Returns its
 * result plus whatever of it can be transferred instead of copied. */
export type TaskHandler = (payload: any) => { result: unknown; transfer?: Transferable[] };

interface Pending {
  request: TaskRequest;
  transfer: Transferable[];
  weight: number;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

/** A fixed set of worker threads running `workerUrl` (a module that calls
 * `serveTasks`), each handed the next queued task whenever it's free --
 * the same pull-based scheme as the compressor's chunkWorkerPool.ts, so a
 * few expensive tasks can't strand the rest behind them. `run` resolves in
 * completion order; a caller that needs input order awaits the promises in
 * the order it made them.
 *
 * With `size` 0 there are no threads: `run` calls `handlers` directly, on
 * the main thread, one task at a time. That is the path parallel output is
 * checked against.
 *
 * `maxWeight` bounds memory rather than threads: each task says roughly
 * how much memory it will take (`run`'s `weight`, in whatever unit the
 * caller picks), and a task only starts while the running ones' weights
 * leave room for it -- or when nothing else is running, so one task over
 * the budget still runs, alone. polyclip-ts takes ~5KB per vertex, so
 * sixteen threads each clipping one of Highland's 355k-vertex islands at
 * once took 22GB.
 *
 * Fails fast: a task that throws rejects its own promise, and a worker that
 * dies rejects every task still waiting, since the pool can no longer be
 * trusted to finish them. */
export class WorkerPool {
  private readonly idle: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly running = new Map<Worker, Pending>();
  private readonly workers: Worker[] = [];
  private failed: Error | null = null;
  private closing = false;
  private nextId = 0;
  private runningWeight = 0;

  readonly size: number;
  private readonly handlers: Record<string, TaskHandler>;
  private readonly maxWeight: number;

  constructor(
    workerUrl: URL,
    size: number,
    handlers: Record<string, TaskHandler>,
    options: { workerData?: unknown; maxWeight?: number } = {},
  ) {
    this.size = size;
    this.handlers = handlers;
    this.maxWeight = options.maxWeight ?? Infinity;
    const { workerData } = options;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl, { workerData });
      this.workers.push(worker);
      this.idle.push(worker);
      worker.on("message", (response: TaskResponse) => {
        const task = this.running.get(worker)!;
        this.running.delete(worker);
        this.runningWeight -= task.weight;
        if (response.ok) task.resolve(response.result);
        else task.reject(Object.assign(new Error(response.message), { stack: response.stack }));
        this.idle.push(worker);
        this.dispatch();
      });
      worker.on("error", (err) => this.fail(err instanceof Error ? err : new Error(String(err))));
      worker.on("exit", (code) => {
        if (!this.closing) this.fail(new Error(`worker exited with code ${code}`));
      });
    }
  }

  run<T>(kind: string, payload: unknown, transfer: Transferable[] = [], weight = 0): Promise<T> {
    if (this.size === 0) {
      return new Promise<T>((resolve) => resolve(this.handlers[kind]!(payload).result as T));
    }
    return new Promise<T>((resolve, reject) => {
      if (this.failed) {
        reject(this.failed);
        return;
      }
      this.queue.push({ request: { id: this.nextId++, kind, payload }, transfer, weight, resolve, reject });
      this.dispatch();
    });
  }

  /** Lets the threads exit. Tasks already queued still finish first. */
  async close(): Promise<void> {
    while (this.queue.length > 0 || this.running.size > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      // In order: a heavy task waits for room rather than being overtaken
      // indefinitely by light ones.
      const next = this.queue[0]!;
      if (this.running.size > 0 && this.runningWeight + next.weight > this.maxWeight) return;
      const worker = this.idle.pop()!;
      const task = this.queue.shift()!;
      this.runningWeight += task.weight;
      this.running.set(worker, task);
      worker.postMessage(task.request, task.transfer);
    }
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const task of [...this.queue, ...this.running.values()]) task.reject(error);
    this.queue.length = 0;
    this.running.clear();
    for (const worker of this.workers) void worker.terminate();
  }
}

/** The worker side: answers each task with `handlers[kind]`. */
export function serveTasks(handlers: Record<string, TaskHandler>): void {
  if (!parentPort) throw new Error("serveTasks must run in a worker_threads Worker");
  const port = parentPort;
  port.on("message", (request: TaskRequest) => {
    let response: TaskResponse;
    let transfer: Transferable[] = [];
    try {
      const done = handlers[request.kind]!(request.payload);
      response = { id: request.id, ok: true, result: done.result };
      transfer = done.transfer ?? [];
    } catch (err) {
      response = {
        id: request.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
    }
    port.postMessage(response, transfer);
  });
}
