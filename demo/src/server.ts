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
 * build without changing any code.
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CGeoDataReader } from "@loc-to-city/reader";
import { Piscina } from "piscina";
import type { ColorSpace } from "./colors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const TILE_RE = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/;

function main(): void {
	const port = Number(process.argv[2] ?? 8766);
	const datasetArg = process.argv[3];
	const datasetPath = datasetArg
		? path.resolve(datasetArg)
		: path.join(REPO_ROOT, "data/zuid-holland.bin");

	console.error(`Loading ${datasetPath}...`);
	const reader = CGeoDataReader.open(datasetPath);
	console.error("Loaded.");
	const piscina = new Piscina({
		filename: path.resolve(__dirname, "tile-worker.js"),
    idleTimeout: 1000,
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
			const colorSpace: ColorSpace =
				url.searchParams.get("cs") === "hsl" ? "hsl" : "oklch";
			// const png = renderTilePng(reader, z, x, y, resolution, colorSpace);
			const promise = piscina.run({
				x,
				y,
				z,
				resolution,
				colorSpace,
			});
			return promise.then((png) => {
				res.writeHead(200, {
					"Content-Type": "image/png",
					"Cache-Control": "public, max-age=3600",
				});
				res.end(png);
			});
      // return;
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
