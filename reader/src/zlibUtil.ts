import { inflateSync } from "node:zlib";

// Section 11: readers MUST bound the inflated size of every compressed
// block, to defend against decompression bombs. zlib's documented
// worst-case expansion ratio is on the order of 1032:1; we round up and add
// a floor so tiny legitimate blocks are never starved.
const MAX_EXPANSION_RATIO = 1100;
const MIN_OUTPUT_CEILING = 1 << 20; // 1 MiB

export function safeInflate(compressed: Uint8Array): Buffer {
	const maxOutputLength = Math.max(
		MIN_OUTPUT_CEILING,
		compressed.length * MAX_EXPANSION_RATIO,
	);
	return inflateSync(compressed, { maxOutputLength });
}
