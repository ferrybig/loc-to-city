import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	CGeoDataError,
	CGeoDataFormatError,
	CGeoDataIndexMismatchError,
	CGeoDataReader,
	CGeoDataUnsupportedError,
	CGeoDataVersionError,
} from "../src/index.ts";
import { buildLocateIndex, buildSearchIndex } from "../src/indexes.ts";
import {
	locateIndexPathFor,
	nodeInflater,
	openFile,
	searchIndexPathFor,
} from "../src/node.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";
import { collect } from "./helpers.ts";

/** Appendix A's file with `edit` applied to a copy of its bytes. */
function tampered(edit: (bytes: Uint8Array) => void): Uint8Array {
	const bytes = APPENDIX_A_BYTES.slice();
	edit(bytes);
	return bytes;
}

/** Asserts `fn` rejects with an instance of exactly `cls` (not a
 * subclass). */
async function rejectsExactly(
	fn: () => Promise<unknown>,
	cls: new (...args: never[]) => Error,
): Promise<void> {
	await assert.rejects(fn, (error: unknown) => {
		assert.ok(error instanceof cls, `${error} is not a ${cls.name}`);
		assert.equal((error as Error).constructor, cls);
		assert.equal((error as Error).name, cls.name);
		return true;
	});
}

test("a bad signature is a format error", async () => {
	await rejectsExactly(
		() => CGeoDataReader.open(tampered((b) => (b[0] = 0x00))),
		CGeoDataFormatError,
	);
});

test("an unknown version is a version error carrying the version", async () => {
	// The version varint directly follows the 8-byte signature (Section 5).
	const bytes = tampered((b) => (b[8] = 3));
	await rejectsExactly(() => CGeoDataReader.open(bytes), CGeoDataVersionError);
	await assert.rejects(
		() => CGeoDataReader.open(bytes),
		(error: unknown) =>
			error instanceof CGeoDataFormatError &&
			(error as CGeoDataVersionError).version === 3,
	);
});

test("a max_depth past 16 is unsupported, though valid", async () => {
	// Appendix A.1: signature, version, attribution "OSM", width_exp,
	// height_exp, then max_depth at byte 15.
	assert.equal(APPENDIX_A_BYTES[15], 2);
	await rejectsExactly(
		() => CGeoDataReader.open(tampered((b) => (b[15] = 17))),
		CGeoDataUnsupportedError,
	);
	const deepest = await CGeoDataReader.open(tampered((b) => (b[15] = 16)));
	assert.equal(deepest.header.maxDepth, 16);
	await deepest.close();
});

test("a truncated file is a format error, wherever it's cut", async () => {
	for (const length of [4, 12, 20, APPENDIX_A_BYTES.length - 1]) {
		await assert.rejects(
			async () => {
				const reader = await CGeoDataReader.open(
					APPENDIX_A_BYTES.slice(0, length),
				);
				await reader.query(52.37, 4.9);
			},
			CGeoDataFormatError,
			`cut at ${length} bytes`,
		);
	}
});

for (const [inflaterName, inflater] of [
	["streamInflater", undefined],
	["nodeInflater", nodeInflater],
] as const) {
	test(`a corrupt compressed chunk is a format error, with the inflater's error as cause (${inflaterName})`, async () => {
		const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
		const { chunkOffsets, chunkLengths } = reader.directory;
		const chunk = chunkLengths.findIndex((length) => length > 0);
		const bytes = tampered((b) => {
			// Past the 2-byte zlib header, into the deflate data and checksum.
			for (let i = 2; i < chunkLengths[chunk]!; i++)
				b[chunkOffsets[chunk]! + i]! ^= 0x5a;
		});
		const corrupt = await CGeoDataReader.open(
			bytes,
			inflater ? { inflater } : {},
		);
		await assert.rejects(
			() => corrupt.chunk(chunk),
			(error: unknown) =>
				error instanceof CGeoDataFormatError && error.cause instanceof Error,
		);
	});
}

test("an index built from another file is a mismatch, also when found next to the file", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	// The source checksum starts right after the 8-byte signature and the
	// one-byte version (Appendix B.3 / C.2).
	const stale = (index: Uint8Array) => {
		const bytes = index.slice();
		bytes[9]! ^= 0xff;
		return bytes;
	};
	const search = stale(await buildSearchIndex(reader));
	const locate = stale(await buildLocateIndex(reader));
	await rejectsExactly(
		() => reader.useSearchIndex(search),
		CGeoDataIndexMismatchError,
	);
	await rejectsExactly(
		() => reader.useLocateIndex(locate),
		CGeoDataIndexMismatchError,
	);

	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-errors-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	writeFileSync(searchIndexPathFor(binPath), search);
	writeFileSync(locateIndexPathFor(binPath), locate);
	const fromPath = await openFile(binPath);
	await rejectsExactly(
		() => collect(fromPath.search("dam")),
		CGeoDataIndexMismatchError,
	);
	await assert.rejects(
		() => fromPath.locate(0),
		(error: unknown) => {
			assert.ok(error instanceof CGeoDataIndexMismatchError);
			assert.match(
				error.message,
				/fixture\.locate-index\.bin: .*checksum mismatch/,
			);
			assert.match(error.stack ?? "", /fixture\.locate-index\.bin: /);
			return true;
		},
	);
	await fromPath.close();
});

test("a corrupt index is a format error", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const garbage = new Uint8Array(100);
	await rejectsExactly(
		() => reader.useSearchIndex(garbage),
		CGeoDataFormatError,
	);
	await rejectsExactly(
		() => reader.useLocateIndex(garbage),
		CGeoDataFormatError,
	);
});

test("invalid arguments are RangeErrors, not CGeoDataErrors", async () => {
	const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const isRangeError = (error: unknown) =>
		error instanceof RangeError && !(error instanceof CGeoDataError);
	for (const fn of [
		() => reader.query(90, 0),
		() => reader.lookup(0, 180),
		() => reader.place(-1),
		() => reader.placeNames(1.5),
		() => reader.chunk(1e9),
		() => reader.locate(1e9),
	]) {
		await assert.rejects(fn, isRangeError);
	}
	for (const fn of [
		() => reader.lookupCached(90, 0),
		() => reader.placeIds(-1),
		() => reader.chunkIndexAt(0, -181),
	]) {
		assert.throws(fn, isRangeError);
	}
});
