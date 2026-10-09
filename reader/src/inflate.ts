import { CGeoDataFormatError } from "./errors.ts";

/**
 * Decompresses one zlib stream (RFC 1950, binary-format.md Section 4),
 * refusing to produce more than `maxOutputLength` bytes. May answer
 * synchronously: Node's inflater does for small blocks, where handing the
 * work to a thread costs more than doing it.
 */
export type Inflater = (
	compressed: Uint8Array,
	maxOutputLength: number,
) => Uint8Array | Promise<Uint8Array>;

// Section 11: readers MUST bound the inflated size of every compressed
// block, to defend against decompression bombs. zlib's documented
// worst-case expansion ratio is on the order of 1032:1; we round up and add
// a floor so tiny legitimate blocks are never starved.
const MAX_EXPANSION_RATIO = 1100;
const MIN_OUTPUT_CEILING = 1 << 20; // 1 MiB

/** The most a block of `compressedLength` bytes may inflate to. */
export function inflateCeiling(compressedLength: number): number {
	return Math.max(MIN_OUTPUT_CEILING, compressedLength * MAX_EXPANSION_RATIO);
}

/**
 * The platform-neutral inflater: the web's `DecompressionStream`, which
 * browsers, Deno, Bun and Node.js all have. On Node.js, `./node.ts`'s
 * zlib inflater is several times faster for small blocks.
 */
export const streamInflater: Inflater = async (compressed, maxOutputLength) => {
	const stream = new DecompressionStream("deflate");
	const writer = stream.writable.getWriter();
	// Not awaited: the readable side below is what drains it, and a corrupt
	// stream surfaces there (writer.closed's rejection is the same error).
	writer.write(compressed as Uint8Array<ArrayBuffer>).catch(() => {});
	writer.close().catch(() => {});
	const reader = stream.readable.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxOutputLength) {
			await reader.cancel();
			throw new RangeError(
				`inflates past ${maxOutputLength} bytes, the limit for its size`,
			);
		}
		parts.push(value);
	}
	if (parts.length === 1) return parts[0]!;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** Inflates one compressed block (Section 4) with `inflater`, under the
 * size ceiling above. Anything the inflater rejects -- a corrupt stream,
 * or one that would inflate past the ceiling -- is the file's fault, so
 * it surfaces as a `CGeoDataFormatError` with the inflater's own error as
 * its `cause`. */
export async function inflateBlock(
	inflater: Inflater,
	compressed: Uint8Array,
): Promise<Uint8Array> {
	try {
		return await inflater(compressed, inflateCeiling(compressed.length));
	} catch (error) {
		throw new CGeoDataFormatError(
			`compressed block does not inflate: ${(error as Error).message}`,
			{ cause: error },
		);
	}
}
