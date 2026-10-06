import assert from "node:assert/strict";
import { test } from "node:test";
import { Piscina, queueOptionsSymbol } from "piscina";
import { type LaneOptions, LaneTaskQueue } from "../src/taskQueue.ts";

function task(label: string, lane?: LaneOptions) {
	return { label, ...(lane && { [queueOptionsSymbol]: lane }) };
}

test("a queued foreground task runs before earlier background tasks", async () => {
	const pool = new Piscina({
		filename: new URL("./fixtures/busyWorker.mjs", import.meta.url).href,
		minThreads: 1,
		maxThreads: 1,
		taskQueue: new LaneTaskQueue(),
		stricterFIFO: true,
	});
	try {
		// The first task holds the pool's only thread until every other
		// task is queued. Whether it's already running by then or still
		// queued itself, it's the first foreground task either way.
		const gate = new Int32Array(new SharedArrayBuffer(4));
		const order: string[] = [];
		const run = (t: object) =>
			pool.run(t).then((label: string) => order.push(label));
		const done = Promise.all([
			run({ ...task("busy"), gate: gate.buffer }),
			run(task("tile 1", { background: true })),
			run(task("tile 2", { background: true })),
			run(task("query")),
			run(task("tile 3", { background: true })),
			run(task("search", { background: false })),
		]);
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		await done;
		assert.deepEqual(order, [
			"busy",
			"query",
			"search",
			"tile 1",
			"tile 2",
			"tile 3",
		]);
	} finally {
		await pool.destroy();
	}
});
