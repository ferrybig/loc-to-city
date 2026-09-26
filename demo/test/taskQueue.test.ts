import assert from "node:assert/strict";
import { test } from "node:test";
import { Piscina, queueOptionsSymbol } from "piscina";
import { type LaneOptions, LaneTaskQueue } from "../src/taskQueue.js";

function task(label: string, lane?: LaneOptions) {
	return { ms: 20, label, ...(lane && { [queueOptionsSymbol]: lane }) };
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
		const order: string[] = [];
		const run = (t: ReturnType<typeof task>) =>
			pool.run(t).then((label: string) => order.push(label));
		await Promise.all([
			run(task("busy")),
			run(task("tile 1", { background: true })),
			run(task("tile 2", { background: true })),
			run(task("query")),
			run(task("tile 3", { background: true })),
			run(task("search", { background: false })),
		]);
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
