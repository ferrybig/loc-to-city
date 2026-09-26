#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
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
 * build without changing any code. A `<dataset>.search-index.bin` next to
 * it (from `cgeodata build-search-index`) is picked up automatically.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CGeoDataReader,
	locateIndexPathFor,
	searchIndexPathFor,
} from "@loc-to-city/read\er";
import { Piscina } from "piscina";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const TILE_RE = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/;

/** Attaches the sidecar index at `indexPath` if there is one, read on
 * demand from the file; one that doesn't match the dataset is skipped. */
function attachIndex(
	kind: string,
	indexPath: string,
	use: (index: string | undefined) => void,
): void {
	if (!existsSync(indexPath)) {
		console.error(`No ${kind} index at ${indexPath}; ${kind} scans the dataset.`);
		return;
	}
	try {
		use(indexPath);
		console.error(`Using ${kind} index ${indexPath}.`);
	} catch (error) {
		use(undefined);
		console.error(
			`Ignoring ${kind} index ${indexPath}: ${(error as Error).message}`,
		);
	}
}

function main(): void {
	const port = Number(process.argv[2] ?? 8766);
	const datasetArg = process.argv[3];
	const datasetPath = datasetArg
		? path.resolve(datasetArg)
		: path.join(REPO_ROOT, "data/zuid-holland.bin");

	console.error(`Loading ${datasetPath}...`);
	const reader = CGeoDataReader.open(datasetPath);
	// Optional sidecars next to the dataset: data/world.bin pairs with
	// data/world.search-index.bin (`cgeodata build-search-index`) and
	// data/world.locate-index.bin (`cgeodata build-locate-index`). They
	// only speed up /api/search and /api/locate; results are the same
	// without them. Attached up front so a stale one is skipped with a
	// warning here instead of failing every request.
	attachIndex("search", searchIndexPathFor(datasetPath), (index) =>
		reader.useSearchIndex(index),
	);
	attachIndex("locate", locateIndexPathFor(datasetPath), (index) =>
		reader.useLocateIndex(index),
	);
	console.error("Loaded.");
	const piscina = new Piscina({
		filename: path.resolve(__dirname, "tile-worker.js"),
    	idleTimeout: 1000,
		maxQueue: 256,
		workerData: {
			datasetPath,
		},
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");

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
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "missing or invalid lat/lon" }));
				return;
			}
			try {
				const t0 = performance.now();
				const result = reader.query(lat, lon);
				const t1 = performance.now();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ...result, query_time_us: (t1 - t0) * 1000 }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
			return;
		}

		if (url.pathname === "/api/search") {
			const q = url.searchParams.get("q") ?? "";
			if (!q.trim()) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ results: [] }));
				return;
			}
			const results = [...reader.search(q, { sort: true, limit: 5 })].map(
				(place) => ({
					id: place.id,
					level: place.level,
					names: place.names,
					region: place.region?.names ?? null,
					country: place.country.names,
				}),
			);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ results }));
			return;
		}

		if (url.pathname === "/api/locate") {
			const id = Number(url.searchParams.get("id"));
			if (!Number.isInteger(id) || id < 0) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "missing or invalid id" }));
				return;
			}
			try {
				const pos = reader.locate(id);
				if (!pos) {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "place has no geometry" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ lat: pos.lat, lon: pos.lon }));
			} catch (err) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			}
			return;
		}

		const tileMatch = TILE_RE.exec(url.pathname);
		if (tileMatch) {
			const z = Number(tileMatch[1]);
			const x = Number(tileMatch[2]);
			const y = Number(tileMatch[3]);
			const resolution = Number(url.searchParams.get("res") ?? "8");
  			const abortController = new AbortController();
			const promise = piscina.run({
				x,
				y,
				z,
				resolution,
			}, { signal: abortController.signal });
			res.on("close", () => abortController.abort());
			return promise.then((png) => {
				res.writeHead(200, {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=3600",
				});
				res.end(png);
			}, () => {
				res.writeHead(503, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "service unavailable" }));
			});
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});

	const host = process.env.HOST ?? "127.0.0.1";
	server.listen(port, host, () => {
		console.error(
			`Serving on http://${host}:${port} (dataset=${datasetPath})`,
		);
	});
}

main();
