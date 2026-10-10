import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import express, { type Handler } from "express";
import { ETAGS_FILE, listFiles } from "../src/etags.ts";
import { prepareDir } from "../src/prepareStatic.ts";
import {
	hasDocs,
	STATIC_DIRS,
	serveStaticDir,
	staticRouter,
} from "../src/staticAssets.ts";

/** Runs `handler` on a server for the length of `body`, which gets its
 * origin. */
async function withServer(
	handler: Handler | express.Router,
	body: (origin: string) => Promise<void>,
): Promise<void> {
	const app = express();
	app.use(handler);
	const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	try {
		await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	} finally {
		server.close();
	}
}

test("the page and every Leaflet file it needs are served", async () => {
	await withServer(staticRouter(), async (origin) => {
		const resp = await fetch(`${origin}/`);
		assert.equal(resp.status, 200);
		assert.match(resp.headers.get("content-type")!, /^text\/html/);
		const page = await resp.text();
		const refs = [...page.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(
			([, ref]) => ref!,
		);
		assert.ok(refs.includes("/vendor/leaflet/leaflet.js"));
		// Referenced from leaflet.css, relative to it.
		refs.push(
			"/vendor/leaflet/images/layers.png",
			"/vendor/leaflet/images/marker-icon.png",
			"/vendor/leaflet/images/marker-shadow.png",
		);
		for (const ref of refs) {
			const asset = await fetch(origin + ref, { method: "HEAD" });
			assert.equal(asset.status, 200, `the page needs ${ref}, not served`);
		}
	});
});

test("after the build step, brotli where accepted and content ETags", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "demo-static-"));
	try {
		const html = `<!doctype html><p>${"compressible ".repeat(100)}</p>`;
		writeFileSync(path.join(dir, "index.html"), html);
		await prepareDir(dir);
		const etags = JSON.parse(
			readFileSync(path.join(dir, ETAGS_FILE), "utf8"),
		) as Record<string, string>;
		assert.deepEqual(Object.keys(etags), ["index.html", "index.html.br"]);

		await withServer(serveStaticDir(dir, 0), async (origin) => {
			const br = await fetch(`${origin}/`, {
				headers: { "Accept-Encoding": "br" },
			});
			assert.equal(br.headers.get("content-encoding"), "br");
			assert.match(br.headers.get("content-type")!, /^text\/html/);
			assert.equal(br.headers.get("etag"), etags["index.html.br"]);
			assert.equal(br.headers.get("last-modified"), null);
			assert.equal(await br.text(), html); // fetch() decodes it

			const plain = await fetch(`${origin}/index.html`, {
				headers: { "Accept-Encoding": "identity" },
			});
			assert.equal(plain.headers.get("content-encoding"), null);
			assert.equal(plain.headers.get("etag"), etags["index.html"]);
			assert.equal(await plain.text(), html);

			// The manifest is a dotfile, so not served.
			const manifest = await fetch(`${origin}/${ETAGS_FILE}`);
			assert.equal(manifest.status, 404);
			await manifest.arrayBuffer();
		});
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("the reader's API docs are served whole, when built", async (t) => {
	if (!hasDocs()) {
		t.skip("no reader/docs: npm run docs -w reader");
		return;
	}
	const docsDir = STATIC_DIRS.find((d) => d.url === "/docs")!.dir;
	// Every local link in every page, once.
	const targets = new Set<string>();
	for (const file of listFiles(docsDir).filter((f) => f.endsWith(".html"))) {
		const url = `/docs/${file}`;
		const html = readFileSync(path.join(docsDir, file), "utf8");
		for (const [, ref] of html.matchAll(/(?:src|href)="([^"#]+)/g)) {
			// Links out of the docs (GitHub, MDN, ...).
			if (/^[a-z]+:/i.test(ref!)) continue;
			targets.add(new URL(ref!, `http://localhost${url}`).pathname);
		}
	}
	await withServer(staticRouter(), async (origin) => {
		const index = await fetch(`${origin}/docs`, { redirect: "manual" });
		assert.equal(index.status, 301);
		assert.equal(index.headers.get("location"), "/docs/");
		await index.arrayBuffer();
		for (const target of targets) {
			const resp = await fetch(origin + target, { method: "HEAD" });
			assert.equal(resp.status, 200, `${target} linked, not served`);
		}
	});
});
