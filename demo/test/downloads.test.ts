import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import express from "express";
import { download, downloadRouter, downloadUrl } from "../src/downloads.ts";
import { errorHandler } from "../src/errors.ts";
import { ETAGS_FILE } from "../src/etags.ts";
import { prepareDir } from "../src/prepareStatic.ts";

const BODY = Buffer.from("0123456789abcdefghij");
let dir: string;
let server: Server;
let origin: string;
let base: string;
// In a dot-directory, which `res.download` refuses a whole path through.
const file = () => download(path.join(dir, ".cache", "data set.bin"), "test");

before(async () => {
	dir = mkdtempSync(path.join(tmpdir(), "demo-downloads-"));
	mkdirSync(path.dirname(file().path));
	writeFileSync(file().path, BODY);
	utimesSync(file().path, 1_700_000_000, 1_700_000_000);
	const app = express();
	app.use(downloadRouter([file()]));
	app.use((_req, res) => {
		res.status(404).end();
	});
	app.use(errorHandler);
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", () => resolve());
	});
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	base = origin + downloadUrl(file());
});

after(() => {
	server.close();
	rmSync(dir, { recursive: true });
});

test("a download is served whole, as an attachment under its own name", async () => {
	assert.equal(downloadUrl(file()), "/download/data%20set.bin");
	const resp = await fetch(base);
	assert.equal(resp.status, 200);
	assert.deepEqual(Buffer.from(await resp.arrayBuffer()), BODY);
	assert.equal(resp.headers.get("content-length"), "20");
	assert.equal(resp.headers.get("accept-ranges"), "bytes");
	assert.equal(
		resp.headers.get("content-disposition"),
		'attachment; filename="data set.bin"',
	);
});

test("only the listed files are served", async () => {
	for (const url of ["/download/other.bin", "/download/..%2F.cache"]) {
		const resp = await fetch(origin + url);
		assert.equal(resp.status, 404, url);
		await resp.arrayBuffer();
	}
});

test("a range request gets just that part, so a download can resume", async () => {
	const etag = (await fetch(base, { method: "HEAD" })).headers.get("etag")!;
	const resp = await fetch(base, {
		headers: { Range: "bytes=15-", "If-Range": etag },
	});
	assert.equal(resp.status, 206);
	assert.equal(resp.headers.get("content-range"), "bytes 15-19/20");
	assert.equal(await resp.text(), "fghij");
});

test("a resume against a changed file gets the whole new file", async () => {
	const resp = await fetch(base, {
		headers: { Range: "bytes=15-", "If-Range": '"stale"' },
	});
	assert.equal(resp.status, 200);
	assert.deepEqual(Buffer.from(await resp.arrayBuffer()), BODY);
});

test("unsatisfiable ranges, revalidation and HEAD", async () => {
	const unsatisfiable = await fetch(base, { headers: { Range: "bytes=20-" } });
	assert.equal(unsatisfiable.status, 416);
	assert.equal(unsatisfiable.headers.get("content-range"), "bytes */20");
	await unsatisfiable.arrayBuffer();

	const head = await fetch(base, { method: "HEAD" });
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("content-length"), "20");

	// As a browser revalidates. Without a Cache-Control, fetch() sends
	// `no-cache` with a conditional request, which rules out a 304.
	const revalidated = await fetch(base, {
		headers: {
			"If-None-Match": head.headers.get("etag")!,
			"Cache-Control": "max-age=0",
		},
	});
	assert.equal(revalidated.status, 304);
});

test("after the build step, a download's ETag is its content hash", async () => {
	await prepareDir(path.dirname(file().path));
	const { [file().name]: etag } = JSON.parse(
		readFileSync(path.join(path.dirname(file().path), ETAGS_FILE), "utf8"),
	) as Record<string, string>;
	// The router reads the hashes when it's made.
	const app = express();
	app.use(downloadRouter([file()]));
	const hashed = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	try {
		const url = `http://127.0.0.1:${(hashed.address() as AddressInfo).port}${downloadUrl(file())}`;
		const resp = await fetch(url, { method: "HEAD" });
		assert.equal(resp.headers.get("etag"), etag);
		assert.equal(resp.headers.get("last-modified"), null);
		const resumed = await fetch(url, {
			headers: { Range: "bytes=15-", "If-Range": etag! },
		});
		assert.equal(resumed.status, 206);
		assert.equal(await resumed.text(), "fghij");
	} finally {
		hashed.close();
	}
});
