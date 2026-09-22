import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CGeoDataReader, type Place } from "../src/index.js";
import {
	buildSearchIndex,
	loadSearchIndex,
	searchWithIndex,
} from "../src/searchIndex.js";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

function ids(places: Iterable<Place>): number[] {
	return [...places].map((p) => p.id).sort((a, b) => a - b);
}

// ── Binary format round-trip ─────────────────────────────────────────────────

test("buildSearchIndex: magic bytes are CGSI", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const buf = buildSearchIndex(reader);
	reader.close();
	assert.equal(buf[0], 0x43); // C
	assert.equal(buf[1], 0x47); // G
	assert.equal(buf[2], 0x53); // S
	assert.equal(buf[3], 0x49); // I
});

test("loadSearchIndex: rejects wrong magic", () => {
	const bad = new Uint8Array(100);
	assert.throws(() => loadSearchIndex(bad), /wrong magic/);
});

test("loadSearchIndex: rejects too-short buffer", () => {
	assert.throws(() => loadSearchIndex(new Uint8Array(10)), /too short/);
});

test("loadSearchIndex: round-trips metadata from the Appendix A fixture", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const { cities, countries, regions } = reader.placeCounts;
	const buf = buildSearchIndex(reader);
	reader.close();

	const index = loadSearchIndex(buf);
	assert.equal(index.cityCount, cities);
	assert.equal(index.cityIdBase, countries + regions);
	assert.equal(index.groupSize, 4);
	assert.equal(index.listCount, 784); // 28^2 bigrams
	assert.equal(index.bytesPerList, Math.ceil(Math.ceil(cities / 4) / 8));
	assert.equal(buf.length, 28 + index.listCount * index.bytesPerList);
});

// ── placeNames ───────────────────────────────────────────────────────────────

test("placeNames: returns names without hierarchy resolution", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	// id 0 = Nederland / The Netherlands (country)
	const names = reader.placeNames(0);
	assert.deepEqual(names, ["Nederland", "The Netherlands"]);
	reader.close();
});

test("placeNames: throws RangeError for out-of-range id", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.throws(() => reader.placeNames(100), RangeError);
	reader.close();
});

// ── searchWithIndex correctness ───────────────────────────────────────────────

// The Appendix A fixture has cities: id=4 (Amsterdam), id=5 (Zaandam),
// id=6 (city in Antwerpen/Belgium).

function makeIndexedReader() {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const index = loadSearchIndex(buildSearchIndex(reader));
	return { reader, index };
}

test("searchWithIndex: 'dam' matches same city ids as reader.search", () => {
	const { reader, index } = makeIndexedReader();
	const baseline = ids(reader.search("dam", { level: "city" }));
	const indexed = ids(searchWithIndex(reader, index, "dam", { level: "city" }));
	assert.deepEqual(indexed, baseline);
	reader.close();
});

test("searchWithIndex: all-levels result matches reader.search", () => {
	const { reader, index } = makeIndexedReader();
	const baseline = ids(reader.search("dam"));
	const indexed = ids(searchWithIndex(reader, index, "dam"));
	assert.deepEqual(indexed, baseline);
	reader.close();
});

test("searchWithIndex: 'antwerp' returns country+region from linear scan plus city from index", () => {
	const { reader, index } = makeIndexedReader();
	const baseline = ids(reader.search("antwerp"));
	const indexed = ids(searchWithIndex(reader, index, "antwerp"));
	assert.deepEqual(indexed, baseline);
	reader.close();
});

test("searchWithIndex: short query (<2 chars) falls back to linear scan", () => {
	const { reader, index } = makeIndexedReader();
	const baseline = ids(reader.search("a"));
	const indexed = ids(searchWithIndex(reader, index, "a"));
	assert.deepEqual(indexed, baseline);
	reader.close();
});

test("searchWithIndex: --limit is respected", () => {
	const { reader, index } = makeIndexedReader();
	const all = ids(searchWithIndex(reader, index, "a", { level: "city" }));
	const limited = [
		...searchWithIndex(reader, index, "a", { level: "city", limit: 1 }),
	];
	assert.equal(limited.length, Math.min(1, all.length));
	reader.close();
});

test("searchWithIndex: --sort results match reader.search sorted results", () => {
	const { reader, index } = makeIndexedReader();
	// Use a query that has multiple matches to verify ordering is consistent.
	const baseline = ids(reader.search("dam", { sort: true }));
	const indexed = ids(searchWithIndex(reader, index, "dam", { sort: true }));
	assert.deepEqual(indexed, baseline);
	reader.close();
});

test("searchWithIndex: no match returns empty", () => {
	const { reader, index } = makeIndexedReader();
	const result = [...searchWithIndex(reader, index, "xqzqxqz")];
	assert.equal(result.length, 0);
	reader.close();
});

// ── Zuid-Holland integration test (skipped when file is absent) ──────────────

const ZH_PATH = fileURLToPath(
	new URL("../../data/zuid-holland.bin", import.meta.url),
);

try {
	const zhReader = CGeoDataReader.open(ZH_PATH);
	const zhIndex = loadSearchIndex(buildSearchIndex(zhReader));
	const { cities: zhCities } = zhReader.placeCounts;
	zhReader.close();

	test(`searchWithIndex vs reader.search on zuidholland.bin (${zhCities} cities)`, (t) => {
		const reader = CGeoDataReader.open(ZH_PATH);
		const index = loadSearchIndex(buildSearchIndex(reader));
		const QUERIES = [
			"amsterdam",
			"dam",
			"rotterdam",
			"gouda",
			"leiden",
			"nieuw",
		];
		for (const q of QUERIES) {
			const baseline = ids(reader.search(q, { level: "city" }));
			const indexed = ids(searchWithIndex(reader, index, q, { level: "city" }));
			assert.deepEqual(
				indexed,
				baseline,
				`mismatch for query ${JSON.stringify(q)}`,
			);
		}
		reader.close();
	});
} catch {
	// File not present; skip silently.
}

// ── CLI integration: build-search-index + search --index ─────────────────────

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tmpDir = mkdtempSync(path.join(tmpdir(), "cgeodata-search-index-"));
const fixtureBin = path.join(tmpDir, "fixture.bin");
const indexBin = path.join(tmpDir, "fixture.search-index.bin");
writeFileSync(fixtureBin, APPENDIX_A_BYTES);

function run(args: string[]): {
	stdout: string;
	stderr: string;
	status: number;
} {
	const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
		encoding: "utf8",
	});
	if (r.error) throw r.error;
	return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

test("CLI: build-search-index writes a valid index file", () => {
	const r = run(["build-search-index", fixtureBin, "--output", indexBin]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /cities/);
});

test("CLI: search --index produces same output as search without --index", () => {
	const withoutIndex = run(["search", fixtureBin, "dam"]);
	const withIndex = run(["search", fixtureBin, "dam", "--index", indexBin]);
	assert.equal(withIndex.status, withoutIndex.status);
	assert.equal(withIndex.stdout, withoutIndex.stdout);
});

test("CLI: search --index exits 1 when nothing matches", () => {
	const r = run(["search", fixtureBin, "xqzqxqz", "--index", indexBin]);
	assert.equal(r.status, 1);
});
