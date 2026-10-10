/**
 * The demo's static files -- the page itself, the Leaflet build it uses
 * (served from the `leaflet` package so the page needs no CDN) and the
 * reader's API reference, if `npm run docs -w reader` built it -- served
 * from disk by express.static. After the build step (prepareStatic.ts),
 * a client that accepts brotli gets each text file's precompressed
 * `.br`, and every file gets its content hash as ETag.
 */
import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type RequestHandler, Router } from "express";
import expressStaticGzip from "express-static-gzip";
import { readEtags } from "./etags.ts";

export interface StaticDir {
	/** The URL path it's served at. */
	url: string;
	dir: string;
	/** Cache-Control max-age, in ms. */
	maxAge: number;
}

/** The page and the docs are revalidated on every load (cheap, thanks to
 * the ETag), so an edit shows up right away; Leaflet is pinned to one
 * version, so its files can be cached for a day. */
export const STATIC_DIRS: StaticDir[] = [
	{
		url: "/",
		dir: fileURLToPath(new URL("../public/", import.meta.url)),
		maxAge: 0,
	},
	{
		url: "/vendor/leaflet",
		dir: path.join(
			path.dirname(
				createRequire(import.meta.url).resolve("leaflet/package.json"),
			),
			"dist",
		),
		maxAge: 86_400_000,
	},
	// TypeDoc's output (reader/typedoc.json).
	{
		url: "/docs",
		dir: fileURLToPath(new URL("../../reader/docs/", import.meta.url)),
		maxAge: 0,
	},
];

/** Whether the reader's API reference is there to serve. */
export function hasDocs(): boolean {
	return STATIC_DIRS.some((d) => d.url === "/docs" && existsSync(d.dir));
}

/** Serves `dir`, preferring each file's `.br` where the client accepts
 * it, with the ETags from its `.etags.json` if there is one. */
export function serveStaticDir(dir: string, maxAge: number): RequestHandler {
	const etags = readEtags(dir);
	return expressStaticGzip(dir, {
		enableBrotli: true,
		orderPreference: ["br"],
		serveStatic: {
			maxAge,
			// A rebuilt image's files are all newer, so with the content
			// hashes a Last-Modified would only cost 304s.
			lastModified: etags.size === 0,
			setHeaders(res: ServerResponse, file: string) {
				const etag = etags.get(
					path.relative(dir, file).split(path.sep).join("/"),
				);
				if (etag) res.setHeader("ETag", etag);
			},
		},
	});
}

/** Serves each of STATIC_DIRS that exists. */
export function staticRouter(): Router {
	const router = Router();
	for (const { url, dir, maxAge } of STATIC_DIRS) {
		if (existsSync(dir)) router.use(url, serveStaticDir(dir, maxAge));
	}
	return router;
}
