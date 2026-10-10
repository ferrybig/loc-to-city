#!/usr/bin/env node
/**
 * The CGEODATA demo's web server: serves the Leaflet page (with Leaflet
 * itself, see staticAssets.ts), a JSON query API, a tile overlay, the
 * reader's API reference under /docs/ (once `npm run docs -w reader` has
 * built it) and the dataset plus the indexes in use as downloads.
 *
 *   node src/server.ts [port] [dataset.bin]
 *
 * dataset defaults to data/03-final/zuid-holland.bin (`make netherlands`,
 * see README); pass a different .bin path to point at a larger build
 * without changing any code. A `<dataset>.search-index.bin` and
 * `<dataset>.locate-index.bin` next to it (from `cgeodata
 * build-search-index` / `build-locate-index`) are picked up automatically.
 *
 * The dataset is only ever read in a piscina pool of worker threads
 * (src/worker.ts); this thread just routes requests to them.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { Piscina, queueOptionsSymbol } from "piscina";
import {
	type Download,
	download,
	downloadRouter,
	downloadUrl,
} from "./downloads.ts";
import { errorHandler, QueueFullError } from "./errors.ts";
import { hasDocs, staticRouter } from "./staticAssets.ts";
import { type LaneOptions, LaneTaskQueue } from "./taskQueue.ts";
import { defaultTileResolution } from "./tiles.ts";
import type { Cancellable, WorkerData } from "./worker.ts";

/** The worker's exports, each one a task `piscina.run` can name. */
type Tasks = typeof import("./worker.ts");
/** The ones a request runs; `info` only runs once, at startup. */
type RequestTask = Exclude<keyof Tasks, "info">;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/** The query parameter `name` as a number, or null when it is absent,
 * empty, repeated or not a finite number (`Number("")` is 0, which would
 * otherwise pass for a real value). */
function numberParam(req: Request, name: string): number | null {
	const raw = req.query[name];
	if (typeof raw !== "string" || raw.trim() === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

const MAX_TILE_ZOOM = 24;

async function main(): Promise<void> {
	const port = Number(process.argv[2] ?? 8766);
	const datasetArg = process.argv[3];
	const datasetPath = datasetArg
		? path.resolve(datasetArg)
		: path.join(REPO_ROOT, "data/03-final/zuid-holland.bin");

	const docs = hasDocs();
	if (!docs) {
		console.error("No API docs; build them with `npm run docs -w reader`.");
	}

	console.error(`Loading ${datasetPath}...`);
	const pool = new Piscina({
		filename: path.resolve(
			__dirname,
			import.meta.url.endsWith(".ts") ? "worker.ts" : "worker.js",
		),
		minThreads: 0,
		idleTimeout: 6000,
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
		res: Response,
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
			[queueOptionsSymbol]: {
				background: name === "tile",
			} satisfies LaneOptions,
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
	const info: ReturnType<Tasks["info"]> = await pool.run(undefined, {
		name: "info",
	});
	for (const { message } of info.indexes) console.error(message);
	console.error("Loaded.");

	const [searchIndex, locateIndex] = info.indexes;
	const downloads = [
		download(datasetPath, "The dataset"),
		searchIndex?.used &&
			download(searchIndex.path, "Search index: faster search"),
		locateIndex?.used &&
			download(
				locateIndex.path,
				"Locate index: positions of places, search ranked by area",
			),
	].filter((d): d is Download => !!d);

	const app = express();
	app.disable("x-powered-by");

	app.use(staticRouter());
	app.use(downloadRouter(downloads));

	app.get("/api/about", async (_req, res) => {
		res.json({
			attribution: info.attribution,
			cellDegrees: info.cellDegrees,
			docs: docs ? "/docs/" : null,
			downloads: await Promise.all(
				downloads.map(async (d) => ({
					name: d.name,
					description: d.description,
					url: downloadUrl(d),
					bytes: (await stat(d.path)).size,
				})),
			),
		});
	});

	app.get("/api/query", async (req, res) => {
		const lat = numberParam(req, "lat");
		const lon = numberParam(req, "lon");
		if (lat === null || lon === null) {
			res.status(400).json({ error: "missing or invalid lat/lon" });
			return;
		}
		res.json(await run(res, "query", { lat, lon }));
	});

	app.get("/api/search", async (req, res) => {
		const q = typeof req.query.q === "string" ? req.query.q : "";
		if (!q.trim()) {
			res.json({ results: [] });
			return;
		}
		res.json({ results: await run(res, "search", { q }) });
	});

	app.get("/api/locate", async (req, res) => {
		const id = numberParam(req, "id");
		if (id === null || !Number.isInteger(id) || id < 0) {
			res.status(400).json({ error: "missing or invalid id" });
			return;
		}
		const pos = await run(res, "locate", { id });
		if (!pos) {
			res.status(404).json({ error: "place has no geometry" });
			return;
		}
		res.json(pos);
	});

	app.get(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/, async (req, res) => {
		const z = Number(req.params[0]);
		const x = Number(req.params[1]);
		const y = Number(req.params[2]);
		// `res` overrides the zoom-based default, for benchmarking.
		const resolution =
			req.query.res !== undefined
				? numberParam(req, "res")
				: defaultTileResolution(z);
		const tilesPerSide = 2 ** z;
		if (
			z > MAX_TILE_ZOOM ||
			x >= tilesPerSide ||
			y >= tilesPerSide ||
			resolution === null ||
			!Number.isInteger(resolution) ||
			resolution < 1 ||
			resolution > 256
		) {
			res.status(400).json({ error: "invalid tile coordinates or res" });
			return;
		}
		const png = await run(res, "tile", { x, y, z, resolution });
		res.set({
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=3600",
		});
		res.end(png);
	});

	app.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});
	app.use(errorHandler);

	const host = process.env.HOST ?? "127.0.0.1";
	// Express hands a failure to listen (a port in use) to the callback.
	app.listen(port, host, (err?: Error) => {
		if (err) throw err;
		console.error(`Serving on http://${host}:${port} (dataset=${datasetPath})`);
	});
}

await main();
