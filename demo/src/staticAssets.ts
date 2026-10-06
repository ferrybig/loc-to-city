/**
 * The demo's static files -- the page itself plus the Leaflet build it
 * uses, served from the `leaflet` package so the page needs no CDN. Each
 * one is read once, at startup, and text files are brotli-compressed then
 * too, so a request is answered straight from memory.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

export interface StaticAsset {
	type: string;
	cacheControl: string;
	etag: string;
	body: Buffer;
	/** `body` brotli-compressed, for text types where that's smaller. */
	brotli: Buffer | null;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const LEAFLET_DIST = path.join(
	path.dirname(createRequire(import.meta.url).resolve("leaflet/package.json")),
	"dist",
);

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
};

/** The page is revalidated on every load (cheap, thanks to the ETag), so
 * an edit shows up right away; Leaflet is pinned to one version, so its
 * files can be cached for a day. */
const PAGE_CACHE = "no-cache";
const VENDOR_CACHE = "public, max-age=86400";

function loadAsset(file: string, cacheControl: string): StaticAsset {
	const type = TYPES[path.extname(file)];
	if (type === undefined) throw new Error(`no content type for ${file}`);
	const body = readFileSync(file);
	const compressed = type.startsWith("text/")
		? brotliCompressSync(body, {
				params: {
					[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
					[zlibConstants.BROTLI_PARAM_QUALITY]:
						zlibConstants.BROTLI_MAX_QUALITY,
					[zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
				},
			})
		: null;
	return {
		type,
		cacheControl,
		etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
		body,
		brotli:
			compressed !== null && compressed.length < body.length
				? compressed
				: null,
	};
}

/** Every static file, keyed by the URL path it's served at. */
export function loadStaticAssets(): Map<string, StaticAsset> {
	const page = loadAsset(path.join(PUBLIC_DIR, "index.html"), PAGE_CACHE);
	const assets = new Map([
		["/", page],
		["/index.html", page],
	]);
	for (const file of [
		"leaflet.js",
		"leaflet.css",
		// Referenced from leaflet.css, relative to it.
		"images/layers.png",
		"images/layers-2x.png",
		"images/marker-icon.png",
		"images/marker-icon-2x.png",
		"images/marker-shadow.png",
	]) {
		assets.set(
			`/vendor/leaflet/${file}`,
			loadAsset(path.join(LEAFLET_DIST, file), VENDOR_CACHE),
		);
	}
	return assets;
}

/** Whether an `Accept-Encoding` header allows brotli (listed, and not
 * with `q=0`). */
export function acceptsBrotli(header: string | undefined): boolean {
	if (!header) return false;
	return header.split(",").some((part) => {
		const [coding, ...params] = part.split(";").map((s) => s.trim());
		if (coding?.toLowerCase() !== "br") return false;
		const q = params.find((p) => /^q=/i.test(p));
		return q === undefined || Number(q.slice(2)) > 0;
	});
}

export function sendAsset(
	req: IncomingMessage,
	res: ServerResponse,
	asset: StaticAsset,
): void {
	const brotli =
		asset.brotli !== null && acceptsBrotli(req.headers["accept-encoding"]);
	// Each encoding is its own representation, so gets its own ETag.
	const etag = brotli ? `${asset.etag.slice(0, -1)}-br"` : asset.etag;
	const headers: Record<string, string> = {
		"Content-Type": asset.type,
		"Cache-Control": asset.cacheControl,
		ETag: etag,
	};
	if (asset.brotli) headers.Vary = "Accept-Encoding";
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, headers);
		res.end();
		return;
	}
	const body = brotli ? asset.brotli! : asset.body;
	if (brotli) headers["Content-Encoding"] = "br";
	headers["Content-Length"] = String(body.length);
	res.writeHead(200, headers);
	res.end(req.method === "HEAD" ? undefined : body);
}
