import { inflateSync } from "node:zlib";
import { CGeoDataFormatError } from "./errors.ts";

// Section 11: readers MUST bound the inflated size of every compressed
// block, to defend against decompression bombs. zlib's documented
// worst-case expansion ratio is on the order of 1032:1; we round up and add
// a floor so tiny legitimate blocks are never starved.
const MAX_EXPANSION_RATIO = 1100;
const MIN_OUTPUT_CEILING = 1 << 20; // 1 MiB

/** Inflates one compressed block (Section 4). Anything zlib rejects -- a
 * corrupt stream, or one that would inflate past the ceiling above -- is
 * the file's fault, so it surfaces as a `CGeoDataFormatError` with zlib's
 * own error as its `cause`. */
export function safeInflate(compressed: Uint8Array): Buffer {
	const maxOutputLength = Math.max(
		MIN_OUTPUT_CEILING,
		compressed.length * MAX_EXPANSION_RATIO,
	);
	try {
		return inflateSync(compressed, { maxOutputLength });
	} catch (error) {
		throw new CGeoDataFormatError(
			`compressed block does not inflate: ${(error as Error).message}`,
			{ cause: error },
		);
	}
}
