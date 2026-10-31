import type { RangeCodedRecords } from "./rangeChunk.ts";
import { RANGE_DECODER_WASM } from "./rangeDecoderWasm.ts";

/**
 * `decodeRangeCodedRecords`'s fast path (wasm/rangeDecoder.wat), about
 * twice as fast as the JavaScript decoder in ./rangeChunk.ts. It only
 * accepts or declines a stream: a declined one -- malformed, or valid
 * but out of its reach -- is decoded again in JavaScript, which throws
 * the error or returns the records. Platforms without WebAssembly (or
 * that forbid compiling it, such as a page whose CSP lacks
 * `'wasm-unsafe-eval'`) always take the JavaScript path.
 *
 * Memory: one instance, grown to the largest chunk decoded so far and
 * dropped once no decode has used it for `IDLE_RELEASE_MS`, as
 * ./chunkDecoder.ts does for version 0 chunks.
 */

/** How long the instance outlives its last decode. */
const IDLE_RELEASE_MS = 1000;

const PAGE_BYTES = 65536;

/** Probabilities and node stack (wasm/rangeDecoder.wat's `scratch`). */
const FIXED_SCRATCH_BYTES = 4992 + 816;

type Decode = (
	streamEnd: number,
	recordCount: number,
	paletteCount: number,
	maxDepth: number,
	width: number,
	out: number,
	scratch: number,
) => number;

// See ./chunkDecoder.ts: the slice of the WebAssembly JS API used here.
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
	decode: Decode;
}

/** The compiled module; null once compiling failed. */
let compiled: WasmModule | null | undefined;
let instance: Instance | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let enabled = true;

/** Turns the fast path off (or back on), for tests and benchmarks that
 * compare it against the JavaScript decoder. */
export function useWasmRangeDecoder(on: boolean): void {
	enabled = on;
	if (!on) release();
}

/** How many bytes of WebAssembly memory the fast path holds right now:
 * 0 while idle. */
export function wasmRangeDecoderBytes(): number {
	return instance?.memory.buffer.byteLength ?? 0;
}

/** Whether this platform runs the fast path. */
export function wasmRangeDecoderAvailable(): boolean {
	return enabled && getInstance() !== undefined;
}

function getInstance(): Instance | undefined {
	if (instance) return instance;
	if (compiled === undefined) {
		try {
			// Throws a ReferenceError where there's no WebAssembly at all.
			compiled = new WebAssembly.Module(
				Uint8Array.from(atob(RANGE_DECODER_WASM), (c) => c.charCodeAt(0)),
			);
		} catch {
			compiled = null;
		}
	}
	if (compiled === null) return undefined;
	const exports = new WebAssembly.Instance(compiled).exports;
	instance = {
		memory: exports.memory as WasmMemory,
		decode: exports.decode as Decode,
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
 * The records of the range-coded stream `buf[offset..]` (Section 8.7), or
 * undefined when the fast path declined it or isn't available, and the
 * caller should decode it in JavaScript. The caller has checked Section
 * 8.7.5's bounds on `recordCount`, that `maxDepth` is at most 16 and
 * `paletteCount` below 2^26.
 */
export function decodeRangeCodedWasm(
	buf: Uint8Array,
	offset: number,
	paletteCount: number,
	recordCount: number,
	maxDepth: number,
): RangeCodedRecords | undefined {
	if (!enabled) return undefined;
	const decoder = getInstance();
	if (!decoder) return undefined;
	const width = paletteCount <= 255 ? 1 : paletteCount <= 65535 ? 2 : 4;
	const streamBytes = buf.length - offset;
	// Slack past the stream: a stream that runs past its end reads a few
	// bytes there before the fast path declines it.
	const out = Math.ceil((streamBytes + 64) / 16) * 16;
	const indices = out + 4 * recordCount;
	const depthsAt = indices + width * recordCount;
	const scratch = Math.ceil((depthsAt + recordCount) / 16) * 16;
	const needed =
		scratch + FIXED_SCRATCH_BYTES + 4 * (2 * 2 ** maxDepth + paletteCount + 1);
	const { memory } = decoder;
	if (memory.buffer.byteLength < needed) {
		try {
			memory.grow(Math.ceil((needed - memory.buffer.byteLength) / PAGE_BYTES));
		} catch {
			return undefined; // out of memory: leave it to the JavaScript path
		}
	}
	new Uint8Array(memory.buffer, 0, streamBytes).set(buf.subarray(offset));
	let ok: number;
	try {
		ok = decoder.decode(
			streamBytes,
			recordCount,
			paletteCount,
			maxDepth,
			width,
			out,
			scratch,
		);
	} catch {
		// A stream that runs far past its end can read past the memory.
		ok = 0;
	}
	releaseWhenIdle();
	if (!ok) return undefined;
	const { buffer } = memory;
	return {
		codes: new Uint32Array(buffer, out, recordCount).slice(),
		depths: new Uint8Array(buffer, depthsAt, recordCount).slice(),
		paletteIndices:
			width === 1
				? new Uint8Array(buffer, indices, recordCount).slice()
				: width === 2
					? new Uint16Array(buffer, indices, recordCount).slice()
					: new Uint32Array(buffer, indices, recordCount).slice(),
	};
}
