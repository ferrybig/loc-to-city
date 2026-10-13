// The worker side of prepare-world.ts' pools (workerPool.ts): every task
// kind any of them runs.
import { workerData } from "node:worker_threads";
import { adminBoundaryHandlers } from "./adminBoundaryIndex.ts";
import { clipHandlers } from "./clip.ts";
import { serveTasks } from "./workerPool.ts";

serveTasks({ ...clipHandlers, ...adminBoundaryHandlers(workerData) });
