import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	fnv1a32,
	foldSymbols,
	readVarint,
	trigramListIndex,
	trigramListIndices,
} from "../src/format.ts";
import {
	CGeoDataReader,
	type Place,
	type SearchOptions,
} from "../src/index.ts";
import {
	buildSearchIndex,
	SearchIndex,
	type SearchIndexOptions,
} from "../src/indexes.ts";
import { FileSource, openFile, searchIndexPathFor } from "../src/node.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";
import { APPENDIX_B_BYTES, APPENDIX_B_OPTIONS } from "./fixtures/appendixB.ts";
import { collect } from "./helpers.ts";

async function ids(places: AsyncIterable<Place>): Promise<number[]> {
	return (await collect(places)).map((p) => p.id);
}

const APPENDIX_A_CHECKSUM = 0x77dc1837b900e69fn;

// ── B.12 worked example ──────────────────────────────────────────────────────

test("buildSearchIndex: reproduces Appendix B.12 byte for byte", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const built = await buildSearchIndex(reader, APPENDIX_B_OPTIONS);
	await reader.close();
	assert.equal(built.length, 3201);
	assert.deepEqual(built, APPENDIX_B_BYTES);
});

test("SearchIndex.open: reads B.12.1's header", async () => {
	const index = await SearchIndex.open(APPENDIX_B_BYTES);
	assert.equal(index.sourceChecksum, APPENDIX_A_CHECKSUM);
	assert.equal(index.placeCount, 7);
	assert.equal(index.hashExp, 4);
	assert.equal(index.listCount, 21968);
	assert.equal(index.topCount, 2);
	assert.equal(index.topBlockExp, 4);
});

test("candidates: B.12.4's queries", async () => {
	const index = await SearchIndex.open(APPENDIX_B_BYTES);
	assert.deepEqual(await index.candidates("dam"), [4, 5]);
	assert.deepEqual(await index.candidates("dams"), [4]); // rejected later, by its names
	assert.deepEqual(await index.candidates("antwerp"), [3, 6]);
	assert.deepEqual(await index.candidates("Zaan-dam"), []); // `an-` isn't stored
	assert.equal(await index.candidates("a"), undefined); // no trigram
	assert.equal(await index.candidates("an"), undefined);
	assert.deepEqual(await index.candidates("België"), [1]); // folds to `belgie`
});

test("shortQuery: B.12.3's table entries", async () => {
	const index = await SearchIndex.open(APPENDIX_B_BYTES);
	assert.deepEqual(await index.shortQuery("a"), [0, 4]); // Nederland outranks Amsterdam/Zaandam
	assert.deepEqual(await index.shortQuery("A"), [0, 4]); // folded, like search()
	assert.deepEqual(await index.shortQuery(" "), [0]); // the first key of block 0
	assert.deepEqual(await index.shortQuery("en"), [6, 3]); // city still outranks region
	assert.deepEqual(await index.shortQuery("h"), [0, 2]); // country now outranks region
	assert.deepEqual(await index.shortQuery("e"), [0, 1]); // both countries, folded: België counts now
	assert.deepEqual(await index.shortQuery("rd"), [4, 2]); // the first key of block 3
	assert.deepEqual(await index.shortQuery("ë"), [0, 1]); // folds to `e` before lookup, same entry
	assert.deepEqual(await index.shortQuery("nl"), []); // not a key: no match
	assert.deepEqual(await index.shortQuery("!"), []); // sorts before every key
	assert.equal(await index.shortQuery("dam"), undefined); // not 1-2 code points
	assert.equal(await index.shortQuery(""), undefined);
});

// ── B.2, B.3: folding and list indices ────────────────────────────────────────

test("foldSymbols: B.2's mapping", () => {
	assert.deepEqual(foldSymbols("Az"), [0, 25]);
	assert.deepEqual(foldSymbols("é-É 9"), [4, 26, 4, 26, 27]);
	assert.deepEqual(foldSymbols("België"), [1, 4, 11, 6, 8, 4]);
	assert.deepEqual(foldSymbols("Straße"), [18, 19, 17, 0, 0xdf, 4]);
	assert.deepEqual(foldSymbols("Łódź"), [0x142, 14, 3, 25]);
	assert.deepEqual(foldSymbols("東京"), [0x6771, 0x4eac]);
	assert.deepEqual(foldSymbols("a\u00a0b"), [0, 0xa0, 1]); // non-ASCII space: its own symbol
});

test("fnv1a32: B.3's test vectors", () => {
	const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
	assert.equal(fnv1a32(ascii("")), 0x811c9dc5);
	assert.equal(fnv1a32(ascii("a")), 0xe40c292c);
	assert.equal(fnv1a32(ascii("foobar")), 0xbf9cf968);
});

test("trigramListIndex: B.3's Latin and hashed examples", () => {
	assert.equal(trigramListIndex(3, 0, 12, 15), 2364); // `dam`
	assert.equal(trigramListIndex(0x142, 14, 3, 15), 24650); // `łód`
	assert.equal(trigramListIndex(0x6771, 0x4eac, 0x90fd, 15), 47909); // `東京都`
	assert.equal(trigramListIndex(0, 0xdf, 4, 15), 22629); // `aße`
	assert.deepEqual(
		trigramListIndices("Zaan-dam", 4),
		[19600, 13, 390, 10923, 20468, 2364],
	);
	assert.deepEqual(trigramListIndices("ab", 4), []);
});

// ── B.8: source checksum ─────────────────────────────────────────────────────

test("placeTableChecksum: matches the Appendix B.12 worked example", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.equal(await reader.placeTableChecksum(), APPENDIX_A_CHECKSUM);
	await reader.close();
});

// Fast 32-bit-halves hash vs a straightforward BigInt FNV-1a, on a real
// place table big enough to exercise every carry path.
function referenceFnv1a64(data: Uint8Array): bigint {
	let h = 0xcbf29ce484222325n;
	for (const byte of data)
		h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
}

const ZH_BIN = fileURLToPath(
	new URL("../../data/03-final/zuid-holland.bin", import.meta.url),
);
if (existsSync(ZH_BIN)) {
	test("placeTableChecksum: matches a BigInt reference on zuid-holland.bin", async () => {
		const reader = await openFile(ZH_BIN);
		const { placeTableStart, placeTableLength } = reader.directory;
		const table = readFileSync(ZH_BIN).subarray(
			placeTableStart,
			placeTableStart + placeTableLength,
		);
		assert.equal(await reader.placeTableChecksum(), referenceFnv1a64(table));
		await reader.close();
	});
}

// ── placeNames ───────────────────────────────────────────────────────────────

test("placeNames: returns names without hierarchy resolution", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(await reader.placeNames(0), [
		"Nederland",
		"The Netherlands",
	]);
	await reader.close();
});

test("placeNames: throws RangeError for out-of-range id", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await assert.rejects(async () => await reader.placeNames(100), RangeError);
	await reader.close();
});

// ── B.10: robustness ─────────────────────────────────────────────────────────

/** The B.12 example with `edit` applied to a copy. Header offsets: version
 * 8, checksum 9-16, place_count 17, hash_exp 18, top_count 19,
 * top_block_exp 20, list_directory_length 21-22, lists_length 23,
 * table_directory_length 24; presence from 25, entries from 2771, lists
 * from 2818, table directory from 2865, table blocks from 2881. */
function tampered(edit: (bytes: Uint8Array) => void): Uint8Array {
	const bytes = APPENDIX_B_BYTES.slice();
	edit(bytes);
	return bytes;
}

test("SearchIndex.open: rejects a bad signature, kind, or version", async () => {
	await assert.rejects(
		async () => await SearchIndex.open(new Uint8Array(100)),
		/wrong magic bytes/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(new Uint8Array(5)),
		/too short/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[8] = 0x00))),
		/kind 0/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[8] = 0x10))),
		/old bigram layout/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[8] = 0x11))),
		/predates diacritic folding/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[8] = 0x13))),
		/unsupported search index version 3/,
	);
});

test("SearchIndex.open: rejects out-of-range parameters and section lengths", async () => {
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[18] = 0))),
		/hash_exp/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[18] = 25))),
		/hash_exp/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[20] = 25))),
		/top_block_exp/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(APPENDIX_B_BYTES.subarray(0, 2800)),
		/past the end/,
	);
	await assert.rejects(
		async () => await SearchIndex.open(tampered((b) => (b[19] = 0))),
		/top_count 0/,
	);
});

test("candidates: rejects a list directory that doesn't add up", async () => {
	// lists_length one short: the entries still add up to 47.
	const short = await SearchIndex.open(tampered((b) => (b[23] = 0x2e)));
	await assert.rejects(
		async () => await short.candidates("dam"),
		/add up to 47, but lists_length is 46/,
	);
	// `and` (the third entry) claims a 2-byte bitmap, where N = 7 needs 1.
	const bitmap = await SearchIndex.open(tampered((b) => (b[2771 + 2] = 0x05)));
	await assert.rejects(
		async () => await bitmap.candidates("dam"),
		/bitmap for list 367 is 2 bytes, expected 1/,
	);
});

test("candidates: rejects a presence bit beyond L", async () => {
	// hash_exp 1 gives L = 21954, so the last presence byte (of 2745) has
	// bits for lists 21954 and up, which MUST be 0. B.12's L = 21968 is a
	// multiple of 8 and has no such bits.
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const bytes = await buildSearchIndex(reader, { hashExp: 1, topCount: 0 });
	await reader.close();
	let off = 21; // signature, version, checksum, place_count 7, three u8s
	for (let i = 0; i < 3; i++) off += readVarint(bytes, off).bytesRead;
	bytes[off + 2744]! |= 0x80; // list 21959
	await assert.rejects(
		async () => (await SearchIndex.open(bytes)).candidates("dam"),
		/list 21959, beyond its 21954 lists/,
	);
});

test("candidates: rejects place ids beyond N", async () => {
	// `aan`'s id list (the first stored list) names place 9 of 7.
	const index = await SearchIndex.open(tampered((b) => (b[2818] = 0x09)));
	await assert.rejects(
		async () => await index.candidates("zaan"),
		/place 9, beyond its 7 places/,
	);
});

test("shortQuery: rejects a table block that disagrees with its directory", async () => {
	// Block 0's first key " " becomes "!", no longer the directory's first key.
	const index = await SearchIndex.open(tampered((b) => (b[2881] = 0x21)));
	await assert.rejects(
		async () => await index.shortQuery("a"),
		/not in key order/,
	);
});

// ── search() with an index attached ──────────────────────────────────────────

/** Two readers over the same bytes: one with an index attached, one
 * without, so every test compares indexed against linear search. */
async function makeReaders(
	bytes: Uint8Array | string = APPENDIX_A_BYTES,
	options: SearchIndexOptions = {},
) {
	const open = (input: Uint8Array | string) =>
		typeof input === "string" ? openFile(input) : CGeoDataReader.open(input);
	const indexed = await open(bytes);
	await indexed.useSearchIndex(await buildSearchIndex(indexed, options));
	const linear = await open(bytes);
	await linear.useSearchIndex(undefined);
	return {
		indexed,
		linear,
		async close() {
			await indexed.close();
			await linear.close();
		},
	};
}

async function assertSameSearch(
	readers: Awaited<ReturnType<typeof makeReaders>>,
	text: string,
	options: SearchOptions = {},
): Promise<void> {
	// Order matters too (id order, or rank order with sort), so no sorting here.
	assert.deepEqual(
		await ids(readers.indexed.search(text, options)),
		await ids(readers.linear.search(text, options)),
		`mismatch for ${JSON.stringify(text)} ${JSON.stringify(options)}`,
	);
}

const FIXTURE_QUERIES = [
	"dam",
	"Dam",
	"dams",
	"antwerp",
	"ANTWERP",
	"zaan-dam",
	"België",
	"belgie",
	"the net",
	"a",
	"an",
	"ë",
	"e",
	"h",
	"nl",
	" amsterdam",
	"amsterdam ",
	" dam",
	"d-h",
	"xqzqxqz",
];
const OPTION_SETS: SearchOptions[] = [
	{},
	{ limit: 1 },
	{ level: "city" },
	{ level: "region" },
	{ country: 0 },
	{ country: 1, level: "city" },
	{ sort: true },
	{ sort: true, limit: 1 },
	{ sort: true, limit: 2 },
	{ sort: true, limit: 5 },
	{ sort: true, limit: 2, country: 1 },
	{ sort: true, limit: 2, level: "city" },
];

for (const [name, options] of [
	["default parameters", {}],
	["B.12's parameters", APPENDIX_B_OPTIONS],
	["no short-query table", { topCount: 0 }],
	["one hashed list", { hashExp: 1 }],
] as const) {
	test(`search with index (${name}) matches the linear scan`, async () => {
		const readers = await makeReaders(APPENDIX_A_BYTES, options);
		for (const q of FIXTURE_QUERIES)
			for (const o of OPTION_SETS) await assertSameSearch(readers, q, o);
		await readers.close();
	});
}

test("search: a sorted 1-2 character search with a small limit reads the short-query table", async () => {
	// Swap block 0's entry for `a` (`0 4`, Nederland then Amsterdam) to
	// `4 0`: only an answer taken from the table can come out in that order.
	const swapped = tampered((b) => {
		const entry = b.indexOf(0x61, 2881); // "a" NUL 02 00 04
		assert.deepEqual(
			[...b.subarray(entry, entry + 5)],
			[0x61, 0x00, 0x02, 0x00, 0x04],
		);
		b[entry + 3] = 0x04;
		b[entry + 4] = 0x00;
	});
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await reader.useSearchIndex(swapped);
	assert.deepEqual(
		await ids(reader.search("a", { sort: true, limit: 2 })),
		[4, 0],
	);
	// Anything the table can't answer exactly falls back to the scan.
	assert.deepEqual(
		await ids(reader.search("a", { sort: true, limit: 3 })),
		[0, 4, 5],
	);
	assert.deepEqual(
		(await ids(reader.search("a", { sort: true }))).slice(0, 2),
		[0, 4],
	);
	assert.deepEqual(
		await ids(reader.search("a", { sort: true, limit: 2, level: "city" })),
		[4, 5],
	);
	assert.deepEqual(await ids(reader.search("a", { limit: 2 })), [0, 2]); // id order: Nederland, Noord-Holland
	await reader.close();
});

test("search: short-query places are confirmed, so a corrupt table can't add a wrong result", async () => {
	// `a`'s entry names België (1), which has no `a` in its names.
	const corrupt = tampered((b) => {
		const entry = b.indexOf(0x61, 2881);
		b[entry + 3] = 0x01;
	});
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await reader.useSearchIndex(corrupt);
	assert.deepEqual(
		await ids(reader.search("a", { sort: true, limit: 2 })),
		[4],
	);
	await reader.close();
});

// ── Attaching an index ───────────────────────────────────────────────────────

test("useSearchIndex: attaches an index built from the same file", async () => {
	const readers = await makeReaders();
	assert.equal(await readers.indexed.hasSearchIndex(), true);
	assert.equal(await readers.linear.hasSearchIndex(), false);
	await readers.indexed.useSearchIndex(undefined);
	assert.equal(await readers.indexed.hasSearchIndex(), false);
	await readers.close();
});

test("useSearchIndex: accepts an already-open index", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await reader.useSearchIndex(await SearchIndex.open(APPENDIX_B_BYTES));
	assert.deepEqual(await ids(reader.search("dam", { level: "city" })), [4, 5]);
	await reader.close();
});

test("useSearchIndex: accepts a file source, read on demand", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-use-index-"));
	const indexPath = path.join(dir, "some-index.bin");
	writeFileSync(indexPath, APPENDIX_B_BYTES);
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await reader.useSearchIndex(await FileSource.open(indexPath));
	assert.equal(await reader.hasSearchIndex(), true);
	assert.deepEqual(await ids(reader.search("dam", { level: "city" })), [4, 5]);
	await reader.close();
});

test("useSearchIndex: rejects an index with the wrong checksum or place count", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await assert.rejects(
		async () => await reader.useSearchIndex(tampered((b) => (b[9]! ^= 0xff))),
		/checksum mismatch/,
	);
	await assert.rejects(
		async () => await reader.useSearchIndex(tampered((b) => (b[17] = 0x08))),
		/covers 8 places, but this file has 7/,
	);
	assert.equal(await reader.hasSearchIndex(), false);
	await reader.close();
});

test("open: picks up <name>.search-index.bin next to the file", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-sibling-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);

	const without = await openFile(binPath);
	assert.equal(await without.hasSearchIndex(), false);
	await without.close();

	writeFileSync(searchIndexPathFor(binPath), APPENDIX_B_BYTES);
	assert.equal(
		searchIndexPathFor(binPath),
		path.join(dir, "fixture.search-index.bin"),
	);

	const reader = await openFile(binPath);
	assert.equal(await reader.hasSearchIndex(), true);
	assert.deepEqual(await ids(reader.search("dam", { level: "city" })), [4, 5]);
	await reader.useSearchIndex(undefined);
	assert.equal(await reader.hasSearchIndex(), false);
	await reader.close();
});

test("open: a stale index next to the file throws on search, not silently ignored", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-stale-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	writeFileSync(
		searchIndexPathFor(binPath),
		tampered((b) => (b[9]! ^= 0xff)),
	);

	const reader = await openFile(binPath); // opening alone doesn't touch it
	await assert.rejects(
		async () => await collect(reader.search("dam")),
		/fixture\.search-index\.bin: .*checksum mismatch/,
	);
	await assert.rejects(
		async () => await collect(reader.search("dam")),
		/checksum mismatch/,
	); // every time
	await reader.useSearchIndex(undefined); // opting out still works
	assert.deepEqual(await ids(reader.search("dam", { level: "city" })), [4, 5]);
	await reader.close();
});

test("open: an old bigram index next to the file says to rebuild it", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-old-index-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	writeFileSync(
		searchIndexPathFor(binPath),
		tampered((b) => (b[8] = 0x10)),
	);
	const reader = await openFile(binPath);
	await assert.rejects(
		async () => await collect(reader.search("dam")),
		/old bigram layout.*rebuild/,
	);
	await reader.close();
});

// ── Real data (skipped when the file is absent) ──────────────────────────────

if (existsSync(ZH_BIN)) {
	test("search with index vs linear scan on zuid-holland.bin", async () => {
		const readers = await makeReaders(ZH_BIN);
		const QUERIES = [
			"amsterdam",
			"dam",
			"rotterdam",
			"gouda",
			"leiden",
			"nieuw",
			"den haag",
			"'s-g",
			"a",
			"aa",
			"ij",
			"z",
			" a",
		];
		for (const q of QUERIES) {
			await assertSameSearch(readers, q);
			await assertSameSearch(readers, q, { level: "city" });
			await assertSameSearch(readers, q, { sort: true, limit: 5 });
			await assertSameSearch(readers, q, { sort: true });
		}
		await readers.close();
	});
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
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
	if (r.error) throw r.error;
	return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

test("CLI: build-search-index writes B.12's example with its parameters", () => {
	const example = path.join(tmpDir, "example.search-index.bin");
	const r = run([
		"build-search-index",
		fixtureBin,
		"--output",
		example,
		"--hash-exp",
		"4",
		"--top-count",
		"2",
		"--top-block-exp",
		"4",
	]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
	assert.match(r.stderr, /7 places/);
	assert.deepEqual(new Uint8Array(readFileSync(example)), APPENDIX_B_BYTES);
});

test("CLI: build-search-index rejects out-of-range parameters", () => {
	assert.equal(
		run(["build-search-index", fixtureBin, "--hash-exp", "0"]).status,
		2,
	);
	assert.equal(
		run(["build-search-index", fixtureBin, "--top-count", "x"]).status,
		2,
	);
});

test("CLI: build-search-index writes a default index next to the file", () => {
	const r = run(["build-search-index", fixtureBin, "--output", indexBin]);
	assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

test("CLI: search uses the index next to the file, same output as --no-index", () => {
	// indexBin is fixture.bin's default search-index path, so plain `search`
	// picks it up; --index and --no-index override that either way.
	for (const args of [
		["dam"],
		["antwerp"],
		["a"],
		["a", "--sort", "--limit", "2"],
		["en", "--sort", "--limit", "5"],
	]) {
		const linear = run(["search", fixtureBin, ...args, "--no-index"]);
		for (const indexed of [
			run(["search", fixtureBin, ...args]),
			run(["search", fixtureBin, ...args, "--index", indexBin]),
		]) {
			assert.equal(indexed.status, linear.status, indexed.stderr);
			assert.equal(indexed.stdout, linear.stdout);
		}
	}
});

test("CLI: search --index exits 1 when nothing matches", () => {
	assert.equal(
		run(["search", fixtureBin, "xqzqxqz", "--index", indexBin]).status,
		1,
	);
});

test("CLI: search --index exits 2 on checksum mismatch", () => {
	const badIndexBin = path.join(tmpDir, "bad.search-index.bin");
	const indexBytes = readFileSync(indexBin);
	// The checksum is at bytes 9–16 (after "CGEODATA" + version byte 0x12).
	indexBytes[9]! ^= 0xff;
	writeFileSync(badIndexBin, indexBytes);
	const r = run(["search", fixtureBin, "dam", "--index", badIndexBin]);
	assert.equal(r.status, 2);
	assert.match(
		r.stderr,
		/--index .*bad\.search-index\.bin: .*checksum mismatch/,
	);
});

test("CLI: search rejects --index combined with --no-index", () => {
	assert.equal(
		run(["search", fixtureBin, "dam", "--index", indexBin, "--no-index"])
			.status,
		2,
	);
});
