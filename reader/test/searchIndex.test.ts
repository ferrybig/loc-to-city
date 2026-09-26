import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CGeoDataReader,
	type Place,
	type SearchOptions,
	searchIndexPathFor,
} from "../src/index.js";
import { buildSearchIndex, SearchIndex } from "../src/searchIndex.js";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

function ids(places: Iterable<Place>): number[] {
	return [...places].map((p) => p.id).sort((a, b) => a - b);
}

// ── Binary format round-trip ─────────────────────────────────────────────────

test("buildSearchIndex: starts with CGEODATA signature", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const buf = buildSearchIndex(reader);
	reader.close();
	const expected = [0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]; // "CGEODATA"
	for (let i = 0; i < 8; i++) assert.equal(buf[i], expected[i], `byte ${i}`);
});

test("buildSearchIndex: version byte encodes kind=1 version=0 (value 16)", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const buf = buildSearchIndex(reader);
	reader.close();
	assert.equal(buf[8], 0x10); // varint 16
});

test("SearchIndex.open: rejects wrong magic bytes", () => {
	const bad = new Uint8Array(100);
	assert.throws(() => SearchIndex.open(bad), /wrong magic bytes/);
});

test("SearchIndex.open: rejects too-short buffer", () => {
	assert.throws(() => SearchIndex.open(new Uint8Array(5)), /too short/);
});

test("SearchIndex.open: rejects wrong kind (a plain CGEODATA file has kind=0 = version 0)", () => {
	// Build a fake header with version varint = 0 (kind 0, not kind 1).
	const fake = new Uint8Array(30);
	fake.set([0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]); // signature
	fake[8] = 0x00; // version varint = 0 → kind=0
	assert.throws(() => SearchIndex.open(fake), /kind/);
});

test("SearchIndex.open: round-trips all header fields from the Appendix A fixture", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const { cities, countries, regions } = reader.placeCounts;
	const buf = buildSearchIndex(reader);
	reader.close();

	const index = SearchIndex.open(buf);
	assert.equal(index.placeCount, cities);
	assert.equal(index.firstId, countries + regions);
	assert.equal(index.groupSize, 4);
	assert.equal(index.ngram, 2);
	assert.equal(index.listCount, 784); // 28^2
	assert.equal(index.bitsPerList, Math.ceil(cities / 4));
	assert.equal(index.bytesPerList, Math.ceil(Math.ceil(cities / 4) / 8));
});

// ── Source checksum ───────────────────────────────────────────────────────────

// Section B.10.1 of binary-format.md gives the expected checksum for the
// Appendix A place table (109 bytes at file offsets 22–130):
//   source_checksum = 9f e6 00 b9 37 18 dc 77  → 0x77dc1837b900e69f
const APPENDIX_A_CHECKSUM = 0x77dc1837b900e69fn;

test("placeTableChecksum: matches the Appendix B.10 worked example", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.equal(reader.placeTableChecksum(), APPENDIX_A_CHECKSUM);
	reader.close();
});

test("buildSearchIndex: embeds the correct source checksum", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const buf = buildSearchIndex(reader);
	reader.close();

	const index = SearchIndex.open(buf);
	assert.equal(index.sourceChecksum, APPENDIX_A_CHECKSUM);
});

// Fast 32-bit-halves hash vs a straightforward BigInt FNV-1a, on a real
// place table big enough to exercise every carry path.
function referenceFnv1a64(data: Uint8Array): bigint {
	let h = 0xcbf29ce484222325n;
	for (const byte of data) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
}

const ZH_BIN = fileURLToPath(new URL("../../data/zuid-holland.bin", import.meta.url));
if (existsSync(ZH_BIN)) {
	test("placeTableChecksum: matches a BigInt reference on zuid-holland.bin", () => {
		const reader = CGeoDataReader.open(ZH_BIN);
		const { placeTableStart, placeTableLength } = reader.directory;
		const table = readFileSync(ZH_BIN).subarray(placeTableStart, placeTableStart + placeTableLength);
		assert.equal(reader.placeTableChecksum(), referenceFnv1a64(table));
		reader.close();
	});
}

// ── placeNames ───────────────────────────────────────────────────────────────

test("placeNames: returns names without hierarchy resolution", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(reader.placeNames(0), ["Nederland", "The Netherlands"]);
	reader.close();
});

test("placeNames: throws RangeError for out-of-range id", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.throws(() => reader.placeNames(100), RangeError);
	reader.close();
});

// ── search() with an attached index ───────────────────────────────────────────

// The Appendix A fixture has cities: id=4 (Amsterdam), id=5 (Zaandam),
// id=6 (Antwerpen — a city in Belgium).

/** Two readers over the same bytes: one with an index attached, one
 * without, so every test compares indexed against linear search. */
function makeReaders(bytes: Uint8Array | string = APPENDIX_A_BYTES) {
	const indexed = CGeoDataReader.open(bytes);
	indexed.useSearchIndex(buildSearchIndex(indexed));
	const linear = CGeoDataReader.open(bytes);
	return {
		indexed,
		linear,
		close() {
			indexed.close();
			linear.close();
		},
	};
}

function assertSameSearch(
	readers: ReturnType<typeof makeReaders>,
	text: string,
	options: SearchOptions = {},
): void {
	// Order matters too (id order, or rank order with sort), so no sorting here.
	assert.deepEqual(
		[...readers.indexed.search(text, options)].map((p) => p.id),
		[...readers.linear.search(text, options)].map((p) => p.id),
		`mismatch for ${JSON.stringify(text)} ${JSON.stringify(options)}`,
	);
}

test("useSearchIndex: attaches an index built from the same file", () => {
	const readers = makeReaders();
	assert.equal(readers.indexed.hasSearchIndex, true);
	assert.equal(readers.linear.hasSearchIndex, false);
	readers.indexed.useSearchIndex(undefined);
	assert.equal(readers.indexed.hasSearchIndex, false);
	readers.close();
});

test("useSearchIndex: accepts an already-loaded index", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	reader.useSearchIndex(SearchIndex.open(buildSearchIndex(reader)));
	assert.deepEqual(ids(reader.search("dam", { level: "city" })), [4, 5]);
	reader.close();
});

test("useSearchIndex: accepts a path, read on demand", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-use-index-"));
	const indexPath = path.join(dir, "some-index.bin");
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	writeFileSync(indexPath, buildSearchIndex(reader));
	reader.useSearchIndex(indexPath);
	assert.equal(reader.hasSearchIndex, true);
	assert.deepEqual(ids(reader.search("dam", { level: "city" })), [4, 5]);
	reader.close();
});

test("open: picks up <name>.search-index.bin next to the file", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-sibling-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);

	const without = CGeoDataReader.open(binPath);
	assert.equal(without.hasSearchIndex, false);
	without.close();

	const builder = CGeoDataReader.open(APPENDIX_A_BYTES);
	writeFileSync(searchIndexPathFor(binPath), buildSearchIndex(builder));
	builder.close();
	assert.equal(searchIndexPathFor(binPath), path.join(dir, "fixture.search-index.bin"));

	const reader = CGeoDataReader.open(binPath);
	assert.equal(reader.hasSearchIndex, true);
	assert.deepEqual(ids(reader.search("dam", { level: "city" })), [4, 5]);
	reader.useSearchIndex(undefined);
	assert.equal(reader.hasSearchIndex, false);
	reader.close();
});

test("open: a stale index next to the file throws on search, not silently ignored", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-stale-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	const builder = CGeoDataReader.open(APPENDIX_A_BYTES);
	const bytes = buildSearchIndex(builder);
	builder.close();
	bytes[9]! ^= 0xff; // first checksum byte, after "CGEODATA" + version 0x10
	writeFileSync(searchIndexPathFor(binPath), bytes);

	const reader = CGeoDataReader.open(binPath); // opening alone doesn't touch it
	assert.throws(() => [...reader.search("dam")], /fixture\.search-index\.bin: .*checksum mismatch/);
	assert.throws(() => [...reader.search("dam")], /checksum mismatch/); // every time
	reader.useSearchIndex(undefined); // opting out still works
	assert.deepEqual(ids(reader.search("dam", { level: "city" })), [4, 5]);
	reader.close();
});

test("useSearchIndex: rejects an index with the wrong checksum", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const bytes = buildSearchIndex(reader);
	bytes[9]! ^= 0xff; // first checksum byte, after "CGEODATA" + version 0x10
	assert.throws(() => reader.useSearchIndex(bytes), /checksum mismatch/);
	assert.equal(reader.hasSearchIndex, false);
	reader.close();
});

test("search with index: 'dam' matches the linear scan", () => {
	const readers = makeReaders();
	assertSameSearch(readers, "dam", { level: "city" });
	assertSameSearch(readers, "dam");
	readers.close();
});

test("search with index: 'antwerp' scans country+region linearly plus city via index", () => {
	const readers = makeReaders();
	assertSameSearch(readers, "antwerp");
	readers.close();
});

test("search with index: short query (<2 chars) falls back to linear scan", () => {
	const readers = makeReaders();
	assertSameSearch(readers, "a");
	readers.close();
});

test("search with index: --limit is respected", () => {
	const readers = makeReaders();
	assertSameSearch(readers, "a", { level: "city", limit: 1 });
	assertSameSearch(readers, "dam", { limit: 1 });
	readers.close();
});

test("search with index: --sort matches the linear scan's ranking", () => {
	const readers = makeReaders();
	assertSameSearch(readers, "dam", { sort: true });
	assertSameSearch(readers, "antwerpen", { sort: true, limit: 2 });
	readers.close();
});

test("search with index: --country narrows the city candidates", () => {
	const readers = makeReaders();
	for (const country of [0, 1]) {
		assertSameSearch(readers, "dam", { country });
		assertSameSearch(readers, "antwerp", { country, level: "city" });
	}
	readers.close();
});

test("search with index: sorted queries with edge spaces match the linear scan", () => {
	const readers = makeReaders();
	for (const q of [" amsterdam", "amsterdam ", " dam", "dam "]) {
		assertSameSearch(readers, q, { sort: true });
		assertSameSearch(readers, q);
	}
	readers.close();
});

test("search with index: no match returns empty", () => {
	const readers = makeReaders();
	assert.equal([...readers.indexed.search("xqzqxqz")].length, 0);
	readers.close();
});

// ── Zuid-Holland integration test (skipped when file is absent) ──────────────

const ZH_PATH = fileURLToPath(new URL("../../data/zuid-holland.bin", import.meta.url));

if (existsSync(ZH_PATH)) {
	test("search with index vs linear scan on zuid-holland.bin", () => {
		const readers = makeReaders(ZH_PATH);
		const QUERIES = ["amsterdam", "dam", "rotterdam", "gouda", "leiden", "nieuw", "den haag"];
		for (const q of QUERIES) {
			assertSameSearch(readers, q, { level: "city" });
			assertSameSearch(readers, q, { sort: true, limit: 5 });
		}
		readers.close();
	});
}

// ── CLI integration: build-search-index + search --index ─────────────────────

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tmpDir = mkdtempSync(path.join(tmpdir(), "cgeodata-search-index-"));
const fixtureBin = path.join(tmpDir, "fixture.bin");
const indexBin = path.join(tmpDir, "fixture.search-index.bin");
writeFileSync(fixtureBin, APPENDIX_A_BYTES);

function run(args: string[]): { stdout: string; stderr: string; status: number } {
	const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8" });
	if (r.error) throw r.error;
	return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

test("CLI: build-search-index writes a valid index file", () => {
	const r = run(["build-search-index", fixtureBin, "--output", indexBin]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /cities/);
});

test("CLI: search uses the index next to the file, same output as --no-index", () => {
	// indexBin is fixture.bin's default search-index path, so plain `search`
	// picks it up; --index and --no-index override that either way.
	for (const q of ["dam", "antwerp", "a"]) {
		const linear = run(["search", fixtureBin, q, "--no-index"]);
		for (const indexed of [
			run(["search", fixtureBin, q]),
			run(["search", fixtureBin, q, "--index", indexBin]),
		]) {
			assert.equal(indexed.status, linear.status, indexed.stderr);
			assert.equal(indexed.stdout, linear.stdout);
		}
	}
});

test("CLI: search --index exits 1 when nothing matches", () => {
	assert.equal(run(["search", fixtureBin, "xqzqxqz", "--index", indexBin]).status, 1);
});

test("CLI: search --index exits 2 on checksum mismatch", () => {
	const badIndexBin = path.join(tmpDir, "bad.search-index.bin");
	const indexBytes = readFileSync(indexBin);
	// The checksum is at bytes 9–16 (after "CGEODATA" + version byte 0x10).
	indexBytes[9]! ^= 0xff;
	writeFileSync(badIndexBin, indexBytes);
	const r = run(["search", fixtureBin, "dam", "--index", badIndexBin]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /--index .*bad\.search-index\.bin: .*checksum mismatch/);
});

test("CLI: search rejects --index combined with --no-index", () => {
	assert.equal(run(["search", fixtureBin, "dam", "--index", indexBin, "--no-index"]).status, 2);
});
