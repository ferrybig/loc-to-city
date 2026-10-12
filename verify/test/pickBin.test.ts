import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pickWorldBin } from "../src/pickBin.ts";

let dir: string;
let saved: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "verify-pick-"));
	saved = process.env.CGEODATA_WORLD_BIN;
	delete process.env.CGEODATA_WORLD_BIN;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (saved === undefined) delete process.env.CGEODATA_WORLD_BIN;
	else process.env.CGEODATA_WORLD_BIN = saved;
});

const make = (name: string) => {
	const file = path.join(dir, name);
	writeFileSync(file, "");
	return file;
};

test("no worldwide .bin: nothing to check", () => {
	assert.equal(pickWorldBin(dir), undefined);
});

test("world.bin alone is used", () => {
	const low = make("world.bin");
	assert.equal(pickWorldBin(dir), low);
});

test("the high-res build wins even when world.bin is newer", () => {
	const high = make("world-high-res.bin");
	const low = make("world.bin");
	const later = new Date(Date.now() + 60_000);
	// world.bin built last, as after `make world`.
	utimesSync(high, new Date(0), new Date(0));
	utimesSync(low, later, later);
	assert.equal(pickWorldBin(dir), high);
});

test("CGEODATA_WORLD_BIN overrides, and a missing one means nothing to check", () => {
	make("world-high-res.bin");
	const low = make("world.bin");
	process.env.CGEODATA_WORLD_BIN = low;
	assert.equal(pickWorldBin(dir), low);
	process.env.CGEODATA_WORLD_BIN = path.join(dir, "missing.bin");
	assert.equal(pickWorldBin(dir), undefined);
});
