#!/usr/bin/env node
import { readFileSync } from "node:fs";
/**
 * Tiny stdlib-only web server for the CGEODATA demo: serves the Leaflet
 * page, a JSON query API, and a tile overlay -- the JS/TS equivalent of
 * webapp/server.py, but for one format with one lookup path instead of
 * comparing four approaches.
 *
 *   npx tsx src/server.ts [port] [dataset.bin]
 *
 * dataset defaults to data/zuid-holland.bin (see the plan / README for how
 * that's built); pass a different .bin path to point at a later, larger
 * build without changing any code. A `<dataset>.search-index.bin` and
 * `<dataset>.locate-index.bin` next to it (from `cgeodata
 * build-search-index` / `build-locate-index`) are picked up automatically.
 *
 * The dataset is only ever read in a piscina pool of worker threads
 * (src/worker.ts); this thread just routes requests to them.
 */
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Piscina, queueOptionsSymbol } from "piscina";
import { type LaneOptions, LaneTaskQueue } from "./taskQueue.js";
import type { Cancellable, WorkerData } from "./worker.js";

/** The worker's exports, each one a task `piscina.run` can name. */
type Tasks = typeof import("./worker.js");
/** The ones a request runs; `indexes` only runs once, at startup. */
type RequestTask = Exclude<keyof Tasks, "indexes">;

/** The pool's queue already holds `maxQueue` tasks. */
class QueueFullError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const TILE_RE = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
	const port = Number(process.argv[2] ?? 8766);
	const datasetArg = process.argv[3];
	const datasetPath = datasetArg
		? path.resolve(datasetArg)
		: path.join(REPO_ROOT, "data/zuid-holland.bin");

	console.error(`Loading ${datasetPath}...`);
	const pool = new Piscina({
		filename: path.resolve(__dirname, "worker.js"),
		minThreads: 1,
		idleTimeout: 60000,
		maxQueue: 256,
		taskQueue: new LaneTaskQueue(),
		stricterFIFO: true,
		workerData: { datasetPath } satisfies WorkerData,
	});

	/** Runs the worker's `name` export on `task` for the request `res`
	 * answers. Tiles go in the queue's background lane, behind any
	 * waiting query, search or locate. No piscina `signal`: that would
	 * bypass the queue (see LaneTaskQueue); a task instead carries a
	 * `cancelled` flag, set once the client goes away (see Cancellable). */
	async function run<N extends RequestTask>(
		res: ServerResponse,
		name: N,
		task: Omit<Parameters<Tasks[N]>[0], keyof Cancellable>,
	): Promise<Exclude<ReturnType<Tasks[N]>, undefined>> {
		// Piscina's own backpressure check (`queueSize` against
		// `maxQueue`), made here so a full queue is told apart from a
		// task that failed.
		if (pool.queueSize >= pool.options.maxQueue) {
			throw new QueueFullError("too many requests queued, try again later");
		}
		const payload: Cancellable = {
			...task,
			cancelled: false,
			[queueOptionsSymbol]: { background: name === "tile" } satisfies LaneOptions,
		};
		res.on("close", () => {
			payload.cancelled = true;
		});
		const result = await pool.run(payload, { name });
		if (result === undefined) {
			throw new Error("client went away before its task ran");
		}
		return result;
	}

	// Doubles as a startup check: a dataset that fails to open rejects
	// here, before the server listens, rather than on every request.
	const indexStatus: string[] = await pool.run(undefined, { name: "indexes" });
	for (const line of indexStatus) console.error(line);
	console.error("Loaded.");

	async function handle(url: URL, res: ServerResponse): Promise<void> {
		if (url.pathname === "/" || url.pathname === "/index.html") {
			const body = readFileSync(path.join(PUBLIC_DIR, "index.html"));
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(body);
			return;
		}

		if (url.pathname === "/api/query") {
			const lat = Number(url.searchParams.get("lat"));
			const lon = Number(url.searchParams.get("lon"));
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
				sendJson(res, 400, { error: "missing or invalid lat/lon" });
				return;
			}
			sendJson(res, 200, await run(res, "query", { lat, lon }));
			return;
		}

		if (url.pathname === "/api/search") {
			const q = url.searchParams.get("q") ?? "";
			if (!q.trim()) {
				sendJson(res, 200, { results: [] });
				return;
			}
			sendJson(res, 200, { results: await run(res, "search", { q }) });
			return;
		}

		if (url.pathname === "/api/locate") {
			const id = Number(url.searchParams.get("id"));
			if (!Number.isInteger(id) || id < 0) {
				sendJson(res, 400, { error: "missing or invalid id" });
				return;
			}
			const pos = await run(res, "locate", { id });
			if (!pos) {
				sendJson(res, 404, { error: "place has no geometry" });
				return;
			}
			sendJson(res, 200, pos);
			return;
		}

		const tileMatch = TILE_RE.exec(url.pathname);
		if (tileMatch) {
			const z = Number(tileMatch[1]);
			const x = Number(tileMatch[2]);
			const y = Number(tileMatch[3]);
			const resolution = Number(url.searchParams.get("res") ?? "8");
			const png = await run(res, "tile", { x, y, z, resolution });
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Cache-Control": "public, max-age=3600",
			});
			res.end(png);
			return;
		}

		sendJson(res, 404, { error: "not found" });
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		handle(url, res).catch((err: unknown) => {
			// The client went away; there's no one to answer.
			if (res.destroyed) return;
			// A RangeError is the reader rejecting the request's coordinate
			// or place id. Anything but that or a full queue is a bug.
			const status =
				err instanceof QueueFullError
					? 503
					: err instanceof RangeError
						? 400
						: 500;
			if (status === 500) console.error(err);
			sendJson(res, status, {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	});

	const host = process.env.HOST ?? "127.0.0.1";
	server.listen(port, host, () => {
		console.error(
			`Serving on http://${host}:${port} (dataset=${datasetPath})`,
		);
	});
}

await main();
