/**
 * The package's main entry point in a real browser: compiled as published,
 * imported by Chromium over HTTP, with nothing from Node.js. Any `node:`
 * import reachable from `src/index.ts` fails the import here, and every
 * answer must equal Node's.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { CGeoDataReader } from "../src/index.ts";
import { buildLocateIndex, buildSearchIndex } from "../src/indexes.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";
import { collect } from "./helpers.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const browser = await chromium.launch().catch(() => undefined);

test("the main entry point works in a browser, and answers as on Node", {
	skip: !browser && "no Chromium (npx playwright install chromium)",
}, async () => {
	// Compiled fresh, as `npm run build` would, so a stale dist/ can't pass.
	const out = mkdtempSync(path.join(tmpdir(), "cgeodata-browser-"));
	execFileSync(
		process.execPath,
		[
			path.join(PACKAGE, "../node_modules/typescript/bin/tsc"),
			"-p",
			path.join(PACKAGE, "tsconfig.json"),
			"--outDir",
			out,
			"--declaration",
			"false",
			"--sourceMap",
			"false",
		],
		{ stdio: "inherit" },
	);

	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const files: Record<string, Uint8Array> = {
		"/": new TextEncoder().encode("<!doctype html><title>reader</title>"),
		"/fixture.bin": APPENDIX_A_BYTES,
		"/fixture.search-index.bin": await buildSearchIndex(reader),
		"/fixture.locate-index.bin": await buildLocateIndex(reader),
	};
	const server = createServer((request, response) => {
		const url = request.url ?? "/";
		const body =
			files[url] ??
			(url.startsWith("/dist/") && url.endsWith(".js")
				? readFileSync(path.join(out, url.slice("/dist/".length)))
				: undefined);
		if (!body) {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, {
			"content-type":
				url === "/"
					? "text/html"
					: url.endsWith(".js")
						? "text/javascript"
						: "application/octet-stream",
		});
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	try {
		const page = await browser!.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${origin}/`);
		const fromBrowser = await page.evaluate(async (origin) => {
			const { CGeoDataReader } = await import(`${origin}/dist/index.js`);
			const get = async (url: string) => (await fetch(url)).arrayBuffer();
			const bytes = await get("/fixture.bin");
			const viaBytes = await CGeoDataReader.open(bytes, {
				searchIndex: await get("/fixture.search-index.bin"),
				locateIndex: await get("/fixture.locate-index.bin"),
			});
			const viaBlob = await CGeoDataReader.open(new Blob([bytes]));
			const points = [
				[20, 100],
				[40, 30],
				[30, 100],
				[-10, 10],
			];
			const queries = [];
			for (const [lat, lon] of points) {
				const a = await viaBytes.query(lat, lon);
				const b = await viaBlob.query(lat, lon);
				queries.push([a, b]);
			}
			const search = [];
			for await (const place of viaBytes.search("dam", { sort: true }))
				search.push(place.id);
			return {
				queries,
				search,
				hasSearchIndex: await viaBytes.hasSearchIndex(),
				locate: await viaBytes.locate(5),
				cached: viaBytes.lookupCached(20, 100)?.placeId,
			};
		}, origin);
		assert.deepEqual(errors, []);

		for (const [i, [lat, lon]] of [
			[20, 100],
			[40, 30],
			[30, 100],
			[-10, 10],
		].entries()) {
			const expected = await reader.query(lat!, lon!);
			assert.deepEqual(
				fromBrowser.queries[i]![0],
				expected,
				`bytes ${lat},${lon}`,
			);
			assert.deepEqual(
				fromBrowser.queries[i]![1],
				expected,
				`blob ${lat},${lon}`,
			);
		}
		assert.deepEqual(
			fromBrowser.search,
			(await collect(reader.search("dam", { sort: true }))).map((p) => p.id),
		);
		assert.equal(fromBrowser.hasSearchIndex, true);
		assert.deepEqual(fromBrowser.locate, await reader.locate(5));
		assert.equal(fromBrowser.cached, 5);
	} finally {
		server.close();
		await reader.close();
	}
});

test.after(() => browser?.close());
