import { CHUNK_DECODER_WASM } from "./chunkDecoderWasm.ts";

/**
 * `parseChunk`'s fast path: wasm/chunkDecoder.wat, a WebAssembly SIMD
 * decoder for a chunk's codes -- stored in a version 0 file
 * (binary-format.md Section 8.6), derived from the depths in version 1
 * (Section 8.4) -- that checks every invariant `parseChunk` does. It only
 * ever accepts or declines a block: a declined one --
 * malformed, or valid but unusual -- is parsed again in JavaScript,
 * which throws the error or returns the records. Platforms without
 * WebAssembly SIMD (or that forbid compiling it, such as a page whose
 * CSP lacks `'wasm-unsafe-eval'`) always take the JavaScript path.
 *
 * Memory: one instance, its memory grown to the largest block decoded
 * so far (3.3 MB for world.bin's largest chunk), kept between
 * decodes so a burst of them reuses it -- allocating WebAssembly memory
 * costs 25-100 µs -- and dropped once no decode has used it for
 * `IDLE_RELEASE_MS`, so an idle reader holds none.
 */

/** Below this many records the JavaScript parser is as fast: on
 * world.bin the fast path is level at 16-32 records, 2x faster at 128,
 * and 5-6x faster from 4096 up. */
export const WASM_MIN_RECORDS = 64;

/** How long the instance outlives its last decode. */
const IDLE_RELEASE_MS = 1000;

const PAGE_BYTES = 65536;

type Parse = (
	codesLength: number,
	recordCount: number,
	maxDepth: number,
	paletteCount: number,
	indexWidth: number,
	out: number,
) => number;

type ParseDepths = (
	recordCount: number,
	maxDepth: number,
	paletteCount: number,
	indexWidth: number,
	out: number,
) => number;

// The slice of the WebAssembly JS API used here: the global exists in
// every browser and in Node.js, but this package compiles against the
// plain ES lib (no DOM), whose typings don't declare it.
interface WasmMemory {
	readonly buffer: ArrayBuffer;
	grow(pages: number): number;
}
interface WasmModule {
	readonly __brand: "WebAssembly.Module";
}
declare const WebAssembly: {
	Module: new (bytes: Uint8Array) => WasmModule;
	Instance: new (module: WasmModule) => { exports: Record<string, unknown> };
};

interface Instance {
	memory: WasmMemory;
	parse: Parse;
	parseDepths: ParseDepths;
}

/** The compiled module; null once compiling failed. */
let compiled: WasmModule | null | undefined;
let instance: Instance | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let enabled = true;

/** Turns the fast path off (or back on), for tests and benchmarks that
 * compare it against the JavaScript parser. */
export function useWasmChunkDecoder(on: boolean): void {
	enabled = on;
	if (!on) release();
}

/** How many bytes of WebAssembly memory the fast path holds right now:
 * 0 while idle. */
export function wasmChunkDecoderBytes(): number {
	return instance?.memory.buffer.byteLength ?? 0;
}

/** Whether this platform runs the fast path. */
export function wasmChunkDecoderAvailable(): boolean {
	return enabled && getInstance() !== undefined;
}

function getInstance(): Instance | undefined {
	if (instance) return instance;
	if (compiled === undefined) {
		try {
			// Throws a ReferenceError where there's no WebAssembly at all.
			compiled = new WebAssembly.Module(
				Uint8Array.from(atob(CHUNK_DECODER_WASM), (c) => c.charCodeAt(0)),
			);
		} catch {
			compiled = null;
		}
	}
	if (compiled === null) return undefined;
	const exports = new WebAssembly.Instance(compiled).exports;
	instance = {
		memory: exports.memory as WasmMemory,
		parse: exports.parse as Parse,
		parseDepths: exports.parseDepths as ParseDepths,
	};
	return instance;
}

function release(): void {
	instance = undefined;
	if (releaseTimer !== undefined) clearTimeout(releaseTimer);
	releaseTimer = undefined;
}

function releaseWhenIdle(): void {
	if (releaseTimer !== undefined) clearTimeout(releaseTimer);
	releaseTimer = setTimeout(release, IDLE_RELEASE_MS);
	// Node.js: don't keep the process alive just to free this.
	(releaseTimer as { unref?: () => void }).unref?.();
}

/**
 * The codes of the version 0 chunk block `buf` (Section 8.6), whose
 * codes start at `codesStart`, checked against every Section 8.5 invariant `parseChunk`
 * checks -- or undefined when the fast path declined it or isn't
 * available, and the caller should parse the block in JavaScript. The
 * caller has checked that the block is exactly as long as its counts
 * say, that `maxDepth` is at most 16 (`parseChunk` refuses more) and
 * `paletteCount` below 2^32.
 */
export function decodeChunkCodes(
	buf: Uint8Array,
	codesStart: number,
	codesLength: number,
	recordCount: number,
	maxDepth: number,
	paletteCount: number,
	indexWidth: number,
): Uint32Array | undefined {
	return run(buf, codesStart, recordCount, (decoder, out) =>
		decoder.parse(
			codesLength,
			recordCount,
			maxDepth,
			paletteCount,
			indexWidth,
			out,
		),
	);
}

/**
 * The codes of the version 1 chunk block `buf` (Section 8.2), whose
 * depths start at `depthsStart`, derived from them (Section 8.4) and
 * checked as `decodeChunkCodes` checks a version 0 block, under the same
 * conditions.
 */
export function decodeDepthCodes(
	buf: Uint8Array,
	depthsStart: number,
	recordCount: number,
	maxDepth: number,
	paletteCount: number,
	indexWidth: number,
): Uint32Array | undefined {
	return run(buf, depthsStart, recordCount, (decoder, out) =>
		decoder.parseDepths(recordCount, maxDepth, paletteCount, indexWidth, out),
	);
}

/** Copies `buf` from `start` on into the instance's memory, from address
 * 0, and hands `parse` where the codes go: the codes it wrote, or
 * undefined when it declined the block or the fast path isn't
 * available. */
function run(
	buf: Uint8Array,
	start: number,
	recordCount: number,
	parse: (decoder: Instance, out: number) => number,
): Uint32Array | undefined {
	if (!enabled) return undefined;
	const decoder = getInstance();
	if (!decoder) return undefined;
	const blockBytes = buf.length - start;
	// 16 bytes of slack past the block: a 3-byte index is read as 4.
	const out = Math.ceil((blockBytes + 16) / 16) * 16;
	const needed = out + 4 * recordCount;
	const { memory } = decoder;
	if (memory.buffer.byteLength < needed) {
		try {
			memory.grow(Math.ceil((needed - memory.buffer.byteLength) / PAGE_BYTES));
		} catch {
			return undefined; // out of memory: leave it to the JavaScript path
		}
	}
	new Uint8Array(memory.buffer, 0, blockBytes).set(buf.subarray(start));
	const ok = parse(decoder, out);
	releaseWhenIdle();
	if (!ok) return undefined;
	return new Uint32Array(memory.buffer, out, recordCount).slice();
}
