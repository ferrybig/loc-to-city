#!/usr/bin/env node
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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CGeoDataReader } from "@loc-to-city/reader";
import { renderTilePng } from "./tiles.js";
import type { ColorSpace } from "./colors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const TILE_RE = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/;

function main(): void {
  const port = Number(process.argv[2] ?? 8766);
  const datasetArg = process.argv[3];
  const datasetPath = datasetArg ? path.resolve(datasetArg) : path.join(REPO_ROOT, "data/zuid-holland.bin");

  console.error(`Loading ${datasetPath}...`);
  const reader = CGeoDataReader.open(datasetPath);
  console.error("Loaded.");

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
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    const tileMatch = TILE_RE.exec(url.pathname);
    if (tileMatch) {
      const z = Number(tileMatch[1]);
      const x = Number(tileMatch[2]);
      const y = Number(tileMatch[3]);
      const resolution = Number(url.searchParams.get("res") ?? "8");
      const colorSpace: ColorSpace = url.searchParams.get("cs") === "hsl" ? "hsl" : "oklch";
      const png = renderTilePng(reader, z, x, y, resolution, colorSpace);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" });
      res.end(png);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(`Serving on http://127.0.0.1:${port} (dataset=${datasetPath})`);
  });
}

main();
