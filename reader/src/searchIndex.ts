/**
 * Bigram bitmap search index (Appendix B of binary-format.md): a compact
 * sidecar file that lets `CGeoDataReader.search()` skip ~97-99% of the city table
 * on typical 3+ character queries.
 *
 * The file is CGEODATA kind 1 (text search index): it shares the 8-byte
 * "CGEODATA" signature and `version` varint (kind × 16 + version = 16),
 * then carries a FNV-1a 64-bit source checksum so stale indexes are caught
 * at load time, followed by ngram, group_size, first_id, and place_count
 * as described in Section B.5. The lists themselves are raw (uncompressed)
 * since random bit-AND access is incompatible with block compression.
 *
 * Only cities are indexed. Countries and regions are always scanned
 * linearly regardless of the index (they are too few to matter).
 */
import type { CGeoDataReader } from "./reader.js";
import { readVarint, writeVarint } from "./varint.js";

// ── Alphabet (Section B.2) ────────────────────────────────────────────────────

const ALPHABET_SIZE = 28;
/** Bucket 26: spaces, punctuation, non-Latin characters. */
const SEPARATOR = 26;
/** Bucket 27: '0'-'9'. */
const DIGIT = 27;

const COMBINING = /[\u0300-\u036f]/g;

/** NFD-decompose, strip combining marks, lowercase — so "é" → "e". */
function foldLower(text: string): string {
	return text.normalize("NFD").replace(COMBINING, "").toLowerCase();
}

function classify(cp: number): number {
	if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61; // a-z
	if (cp >= 0x30 && cp <= 0x39) return DIGIT;
	return SEPARATOR;
}

function symbolSequence(text: string): number[] {
	const symbols: number[] = [];
	for (const ch of foldLower(text)) symbols.push(classify(ch.codePointAt(0)!));
	return symbols;
}

function bytesForBits(n: number): number {
	return Math.ceil(n / 8);
}

function setBit(buf: Uint8Array, listByteOffset: number, position: number): void {
	const i = listByteOffset + (position >> 3);
	buf[i] = buf[i]! | (1 << (position & 7));
}

/** OR-pools `fine` into groups of `groupSize` — output bit `g` is 1 iff any
 * of the `groupSize` fine bits `[g*groupSize, g*groupSize+groupSize)` is 1. */
function poolBits(fine: Uint8Array, listCount: number, totalBits: number, groupSize: number): Uint8Array {
	const fineBytesPerList = bytesForBits(totalBits);
	const pooledBitsPerList = Math.ceil(totalBits / groupSize);
	const pooledBytesPerList = bytesForBits(pooledBitsPerList);
	const pooled = new Uint8Array(pooledBytesPerList * listCount);
	for (let list = 0; list < listCount; list++) {
		const srcOff = list * fineBytesPerList;
		const dstOff = list * pooledBytesPerList;
		for (let g = 0; g < pooledBitsPerList; g++) {
			const start = g * groupSize;
			const end = Math.min(start + groupSize, totalBits);
			let any = false;
			for (let bit = start; bit < end && !any; bit++) {
				any = (fine[srcOff + (bit >> 3)]! & (1 << (bit & 7))) !== 0;
			}
			if (any) pooled[dstOff + (g >> 3)]! |= 1 << (g & 7);
		}
	}
	return pooled;
}

// ── Binary format (Section B.5) ───────────────────────────────────────────────

// "CGEODATA" — same signature as the main data file.
const SIGNATURE = Uint8Array.from([0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]);
const KIND_SEARCH_INDEX = 1;
const FORMAT_VERSION = 0; // kind=1, version=0 → stored varint = 16 (0x10)
const STORED_VERSION = KIND_SEARCH_INDEX * 16 + FORMAT_VERSION;
/** OR-pooling factor recommended by Section B.9. */
const GROUP_SIZE = 4;
const INDEX_NGRAM = 2; // bigram

export interface SearchIndex {
	readonly sourceChecksum: bigint;
	readonly ngram: number;
	/** First indexed place id; cities start at countries + regions. */
	readonly firstId: number;
	/** Number of indexed places (cities only). */
	readonly placeCount: number;
	readonly groupSize: number;
	/** Derived: ALPHABET_SIZE^ngram (784 for bigram). */
	readonly listCount: number;
	/** Derived: ceil(placeCount / groupSize). */
	readonly bitsPerList: number;
	/** Derived: ceil(bitsPerList / 8). */
	readonly bytesPerList: number;
	/** list-major bit array: listCount × bytesPerList bytes. */
	readonly bits: Uint8Array;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/** Builds a bigram bitmap index over all cities in `reader` and returns
 * the raw bytes ready to write to a file (Section B.5). */
export function buildSearchIndex(reader: CGeoDataReader): Uint8Array {
	const { cities: placeCount, countries, regions } = reader.placeCounts;
	const firstId = countries + regions;
	const listCount = ALPHABET_SIZE ** INDEX_NGRAM; // 784

	const fineBytesPerList = bytesForBits(placeCount);
	const bigramFine = new Uint8Array(fineBytesPerList * listCount);

	let position = 0;
	for (const city of reader.places({ level: "city" })) {
		const bigramsSeen = new Set<number>();
		for (const name of reader.placeNames(city.id)) {
			const syms = symbolSequence(name);
			for (let i = 0; i + 1 < syms.length; i++) {
				bigramsSeen.add(syms[i]! * ALPHABET_SIZE + syms[i + 1]!);
			}
		}
		for (const bg of bigramsSeen) setBit(bigramFine, bg * fineBytesPerList, position);
		position++;
	}

	const bitsPerList = Math.ceil(placeCount / GROUP_SIZE);
	const bytesPerList = bytesForBits(bitsPerList);
	const packed = poolBits(bigramFine, listCount, placeCount, GROUP_SIZE);

	const checksum = reader.placeTableChecksum();

	// Assemble variable-length header, then append the packed lists.
	const versionBytes = writeVarint(STORED_VERSION);
	const groupSizeBytes = writeVarint(GROUP_SIZE);
	const firstIdBytes = writeVarint(firstId);
	const placeCountBytes = writeVarint(placeCount);
	const headerSize =
		SIGNATURE.length +
		versionBytes.length +
		8 + // source_checksum u64
		1 + // ngram u8
		groupSizeBytes.length +
		firstIdBytes.length +
		placeCountBytes.length;

	const out = new Uint8Array(headerSize + listCount * bytesPerList);
	const dv = new DataView(out.buffer);
	let off = 0;

	out.set(SIGNATURE, off); off += SIGNATURE.length;
	out.set(versionBytes, off); off += versionBytes.length;
	dv.setUint32(off, Number(checksum & 0xffffffffn), true); off += 4;
	dv.setUint32(off, Number(checksum >> 32n), true); off += 4;
	out[off++] = INDEX_NGRAM;
	out.set(groupSizeBytes, off); off += groupSizeBytes.length;
	out.set(firstIdBytes, off); off += firstIdBytes.length;
	out.set(placeCountBytes, off); off += placeCountBytes.length;
	out.set(packed, off);
	return out;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/** Parses a CGEODATA kind-1 search index file and returns a `SearchIndex`
 * ready for `CGeoDataReader.useSearchIndex()`. Validates signature, kind, version, ngram,
 * group_size, and file length. Does NOT verify the source checksum --
 * `useSearchIndex()` does that against the reader it's attached to. */
export function loadSearchIndex(data: Uint8Array): SearchIndex {
	if (data.length < SIGNATURE.length + 1) {
		throw new Error("search index file is too short to be valid");
	}
	for (let i = 0; i < SIGNATURE.length; i++) {
		if (data[i] !== SIGNATURE[i]) {
			throw new Error("not a CGEODATA search index file (wrong magic bytes)");
		}
	}
	let off = SIGNATURE.length;

	const { value: storedVersion, bytesRead: vb } = readVarint(data, off);
	off += vb;
	const kind = storedVersion >> 4;
	const ver = storedVersion & 0xf;
	if (kind !== KIND_SEARCH_INDEX) {
		throw new Error(`not a text search index file (kind ${kind}, expected ${KIND_SEARCH_INDEX})`);
	}
	if (ver !== FORMAT_VERSION) {
		throw new Error(`unsupported search index version ${ver} (expected ${FORMAT_VERSION})`);
	}

	if (data.length < off + 8) throw new Error("search index file is too short for source checksum");
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const sourceChecksum = BigInt(dv.getUint32(off, true)) | (BigInt(dv.getUint32(off + 4, true)) << 32n);
	off += 8;

	if (data.length < off + 1) throw new Error("search index file is too short for ngram");
	const ngram = data[off++]!;
	if (ngram !== 1 && ngram !== 2) throw new Error(`unsupported ngram value ${ngram} (must be 1 or 2)`);

	const { value: groupSize, bytesRead: gb } = readVarint(data, off);
	off += gb;
	if (groupSize === 0) throw new Error("group_size must be at least 1");

	const { value: firstId, bytesRead: fib } = readVarint(data, off);
	off += fib;

	const { value: placeCount, bytesRead: pcb } = readVarint(data, off);
	off += pcb;

	const listCount = ALPHABET_SIZE ** ngram;
	const bitsPerList = Math.ceil(placeCount / groupSize);
	const bytesPerList = bytesForBits(bitsPerList);

	const expectedTotal = off + listCount * bytesPerList;
	if (data.length !== expectedTotal) {
		throw new Error(`search index has ${data.length} bytes but header implies ${expectedTotal}`);
	}

	const bits = data.subarray(off);
	return { sourceChecksum, ngram, firstId, placeCount, groupSize, listCount, bitsPerList, bytesPerList, bits };
}

// ── Candidate lookup (Section B.7) ───────────────────────────────────────────

/** ANDs the named lists together into one buffer of `bytesPerList` bytes.
 * Copies list[0] before ANDing to avoid mutating the source buffer
 * (Section B.7 step 4). */
function andLists(bits: Uint8Array, bytesPerList: number, listIds: readonly number[]): Uint8Array {
	const result = new Uint8Array(bytesPerList);
	result.set(bits.subarray(listIds[0]! * bytesPerList, (listIds[0]! + 1) * bytesPerList));
	for (let k = 1; k < listIds.length; k++) {
		const off = listIds[k]! * bytesPerList;
		for (let b = 0; b < bytesPerList; b++) result[b] = result[b]! & bits[off + b]!;
	}
	return result;
}

/** Expands a surviving packed-bit mask back into place positions: each
 * set bit `g` stands for the group `[g*groupSize, g*groupSize+groupSize)`. */
function expandCandidates(mask: Uint8Array, index: SearchIndex): number[] {
	const positions: number[] = [];
	for (let bit = 0; bit < index.bitsPerList; bit++) {
		if ((mask[bit >> 3]! & (1 << (bit & 7))) === 0) continue;
		const start = bit * index.groupSize;
		const end = Math.min(start + index.groupSize, index.placeCount);
		for (let p = start; p < end; p++) positions.push(p);
	}
	return positions;
}

/**
 * The positions (ascending, relative to `index.firstId`) of every indexed
 * place whose names could contain `text` -- a superset of the real
 * matches, which the caller still has to check name by name. Undefined
 * when `text` is too short to contain a single n-gram, i.e. the index
 * can't rule anything out.
 *
 * `CGeoDataReader.search()` is what uses this once an index is attached
 * with `useSearchIndex()`; it's exported for callers that want the raw
 * candidate set.
 */
export function candidatePositions(index: SearchIndex, text: string): number[] | undefined {
	const symbols = symbolSequence(text);
	const n = index.ngram;
	const seen = new Set<number>();
	for (let i = 0; i + n <= symbols.length; i++) {
		let list = 0;
		for (let j = 0; j < n; j++) list = list * ALPHABET_SIZE + symbols[i + j]!;
		seen.add(list);
	}
	if (seen.size === 0) return undefined;
	return expandCandidates(andLists(index.bits, index.bytesPerList, [...seen]), index);
}
