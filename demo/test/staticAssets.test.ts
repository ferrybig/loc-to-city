import assert from "node:assert/strict";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { acceptsBrotli, loadStaticAssets } from "../src/staticAssets.ts";

test("acceptsBrotli honors the coding list and q=0", () => {
	assert.equal(acceptsBrotli(undefined), false);
	assert.equal(acceptsBrotli(""), false);
	assert.equal(acceptsBrotli("gzip, deflate"), false);
	assert.equal(acceptsBrotli("gzip, deflate, br, zstd"), true);
	assert.equal(acceptsBrotli("BR;q=0.5"), true);
	assert.equal(acceptsBrotli("br;q=0, gzip"), false);
	assert.equal(acceptsBrotli("brotli"), false);
});

test("the page and every Leaflet file it needs are served from memory", () => {
	const assets = loadStaticAssets();
	for (const url of [
		"/",
		"/index.html",
		"/vendor/leaflet/leaflet.js",
		"/vendor/leaflet/leaflet.css",
		"/vendor/leaflet/images/marker-icon.png",
		"/vendor/leaflet/images/marker-shadow.png",
		"/vendor/leaflet/images/layers.png",
	]) {
		assert.ok(assets.has(url), url);
	}
	const page = assets.get("/")!.body.toString("utf8");
	for (const [, src] of page.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
		assert.ok(assets.has(src!), `the page references ${src}, not served`);
	}
});

test("text assets are brotli-compressed, images left as they are", () => {
	for (const [url, asset] of loadStaticAssets()) {
		if (asset.type.startsWith("text/")) {
			assert.ok(asset.brotli, `${url} not compressed`);
			assert.ok(brotliDecompressSync(asset.brotli).equals(asset.body), url);
		} else {
			assert.equal(asset.brotli, null, url);
		}
	}
});
