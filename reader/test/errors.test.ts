import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildLocateIndex,
	buildSearchIndex,
	CGeoDataError,
	CGeoDataFormatError,
	CGeoDataIndexMismatchError,
	CGeoDataReader,
	CGeoDataVersionError,
	locateIndexPathFor,
	searchIndexPathFor,
} from "../src/index.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";

/** Appendix A's file with `edit` applied to a copy of its bytes. */
function tampered(edit: (bytes: Uint8Array) => void): Uint8Array {
	const bytes = APPENDIX_A_BYTES.slice();
	edit(bytes);
	return bytes;
}

/** Asserts `fn` throws an instance of exactly `cls` (not a subclass). */
function throwsExactly(
	fn: () => unknown,
	cls: new (...args: never[]) => Error,
) {
	assert.throws(fn, (error: unknown) => {
		assert.ok(error instanceof cls, `${error} is not a ${cls.name}`);
		assert.equal((error as Error).constructor, cls);
		assert.equal((error as Error).name, cls.name);
		return true;
	});
}

test("a bad signature is a format error", () => {
	throwsExactly(
		() => CGeoDataReader.open(tampered((b) => (b[0] = 0x00))),
		CGeoDataFormatError,
	);
});

test("an unknown version is a version error carrying the version", () => {
	// The version varint directly follows the 8-byte signature (Section 5).
	const bytes = tampered((b) => (b[8] = 3));
	throwsExactly(() => CGeoDataReader.open(bytes), CGeoDataVersionError);
	assert.throws(
		() => CGeoDataReader.open(bytes),
		(error: unknown) =>
			error instanceof CGeoDataFormatError &&
			(error as CGeoDataVersionError).version === 3,
	);
});

test("a truncated file is a format error, wherever it's cut", () => {
	for (const length of [4, 12, 20, APPENDIX_A_BYTES.length - 1]) {
		assert.throws(
			() => {
				const reader = CGeoDataReader.open(APPENDIX_A_BYTES.slice(0, length));
				reader.query(52.37, 4.9);
			},
			CGeoDataFormatError,
			`cut at ${length} bytes`,
		);
	}
});

test("a corrupt compressed chunk is a format error, with zlib's error as cause", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const { chunkOffsets, chunkLengths } = reader.directory;
	const chunk = chunkLengths.findIndex((length) => length > 0);
	const bytes = tampered((b) => {
		// Past the 2-byte zlib header, into the deflate data and checksum.
		for (let i = 2; i < chunkLengths[chunk]!; i++)
			b[chunkOffsets[chunk]! + i]! ^= 0x5a;
	});
	assert.throws(
		() => CGeoDataReader.open(bytes).chunk(chunk),
		(error: unknown) =>
			error instanceof CGeoDataFormatError && error.cause instanceof Error,
	);
});

test("an index built from another file is a mismatch, also when found next to the file", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	// The source checksum starts right after the 8-byte signature and the
	// one-byte version (Appendix B.3 / C.2).
	const stale = (index: Uint8Array) => {
		const bytes = index.slice();
		bytes[9]! ^= 0xff;
		return bytes;
	};
	const search = stale(buildSearchIndex(reader));
	const locate = stale(buildLocateIndex(reader));
	throwsExactly(
		() => reader.useSearchIndex(search),
		CGeoDataIndexMismatchError,
	);
	throwsExactly(
		() => reader.useLocateIndex(locate),
		CGeoDataIndexMismatchError,
	);

	const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-errors-"));
	const binPath = path.join(dir, "fixture.bin");
	writeFileSync(binPath, APPENDIX_A_BYTES);
	writeFileSync(searchIndexPathFor(binPath), search);
	writeFileSync(locateIndexPathFor(binPath), locate);
	const fromPath = CGeoDataReader.open(binPath);
	throwsExactly(() => [...fromPath.search("dam")], CGeoDataIndexMismatchError);
	assert.throws(
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
	fromPath.close();
});

test("a corrupt index is a format error", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	const garbage = new Uint8Array(100);
	throwsExactly(() => reader.useSearchIndex(garbage), CGeoDataFormatError);
	throwsExactly(() => reader.useLocateIndex(garbage), CGeoDataFormatError);
});

test("invalid arguments are RangeErrors, not CGeoDataErrors", () => {
	const reader = CGeoDataReader.open(APPENDIX_A_BYTES);
	for (const fn of [
		() => reader.query(90, 0),
		() => reader.query(0, 180),
		() => reader.place(-1),
		() => reader.placeNames(1.5),
		() => reader.chunk(1e9),
		() => reader.locate(1e9),
	]) {
		assert.throws(
			fn,
			(error: unknown) =>
				error instanceof RangeError && !(error instanceof CGeoDataError),
		);
	}
});
