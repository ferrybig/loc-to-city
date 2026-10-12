import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
	checksPathFor,
	describeChecks,
	loadChecks,
	SUPPORTED_VERSION,
} from "../src/checks.ts";

let dir: string;
let dataset: string;

const entry = (group: "spot" | "capital", n: number) => ({
	id: `${group}:${n},${n}`,
	group,
	name: `place ${n}`,
	lat: n,
	lon: n,
	status: "fixed",
	outcome: "verified",
	section: "Netherlands",
	expected: "A / B / C",
	actual: { country: ["A"], region: ["B"], city: ["C"] },
});

const file = (overrides: Record<string, unknown> = {}) => ({
	version: SUPPORTED_VERSION,
	generatedAt: "2026-10-12T00:00:00.000Z",
	dataset: { bytes: 10, olderThanResolvedInput: false },
	summary: { verified: 3 },
	checks: [entry("spot", 1), entry("spot", 2), entry("capital", 3)],
	...overrides,
});

before(() => {
	dir = mkdtempSync(path.join(tmpdir(), "demo-checks-"));
	dataset = path.join(dir, "world.bin");
	writeFileSync(dataset, Buffer.alloc(10));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const write = (content: unknown) =>
	writeFileSync(
		checksPathFor(dataset),
		typeof content === "string" ? content : JSON.stringify(content),
	);

test("the checks file sits next to the dataset, named for it", () => {
	assert.equal(checksPathFor("/d/world.bin"), "/d/world.checks.json");
	assert.equal(checksPathFor("/d/odd"), "/d/odd.checks.json");
});

test("a missing file just means no markers", async () => {
	const { checks, message } = await loadChecks(dataset);
	assert.equal(checks, null);
	assert.match(message, /No spot-check markers/);
});

test("a matching file is loaded and described", async () => {
	write(file());
	const { checks } = await loadChecks(dataset);
	assert.equal(checks?.checks.length, 3);
	assert.deepEqual(describeChecks(checks), {
		summary: { verified: 3 },
		spot: 2,
		capital: 1,
		generatedAt: "2026-10-12T00:00:00.000Z",
		olderThanResolvedInput: false,
	});
	assert.equal(describeChecks(null), null);
});

test("a file made for a dataset of another size is ignored", async () => {
	write(file({ dataset: { bytes: 11, olderThanResolvedInput: false } }));
	const { checks, message } = await loadChecks(dataset);
	assert.equal(checks, null);
	assert.match(message, /11 bytes, this one is 10/);
});

test("another version, broken JSON and a wrong shape are ignored", async () => {
	for (const [content, why] of [
		[file({ version: SUPPORTED_VERSION + 1 }), /version/],
		["{not json", /not valid JSON/],
		[file({ checks: [{ id: "x" }] }), /unexpected shape/],
		[file({ checks: "nope" }), /unexpected shape/],
	] as const) {
		write(content);
		const { checks, message } = await loadChecks(dataset);
		assert.equal(checks, null, message);
		assert.match(message, why);
	}
});
