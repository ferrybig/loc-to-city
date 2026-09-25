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
import { openSource, type RandomAccessSource } from "./source.js";
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

// ── Reader (Sections B.5, B.7) ────────────────────────────────────────────────

/** Longest possible header: signature, then a version varint, the u64
 * checksum, the ngram byte and three more varints of at most 8 bytes each. */
const MAX_HEADER_LENGTH = SIGNATURE.length + 8 + 8 + 1 + 3 * 8;

/**
 * An open search index file (Section B.5). Opening reads only the header;
 * each list is read from the source the first time a query needs it and
 * cached like the reader's name blocks, so a query touches one list per
 * distinct n-gram of its text rather than the whole file.
 *
 * Opening does NOT verify the source checksum -- `CGeoDataReader`'s
 * `useSearchIndex()` does that against the file it's attached to.
 */
export class SearchIndex {
	/** One list's packed bits, by list index. */
	private readonly listCache = new Map<number, WeakRef<Uint8Array>>();

	private constructor(
		private readonly source: RandomAccessSource,
		private readonly listsStart: number,
		readonly sourceChecksum: bigint,
		readonly ngram: number,
		readonly groupSize: number,
		/** First indexed place id; cities start at countries + regions. */
		readonly firstId: number,
		/** Number of indexed places (cities only). */
		readonly placeCount: number,
	) {}

	/** Opens a search index from a file path (read on demand) or bytes.
	 * Validates signature, kind, version, ngram, group_size, and length. */
	static open(input: string | Uint8Array): SearchIndex {
		const source = openSource(input);
		try {
			return SearchIndex.parseHeader(source);
		} catch (error) {
			source.close?.();
			throw error;
		}
	}

	private static parseHeader(source: RandomAccessSource): SearchIndex {
		const data = source.readSync(0, Math.min(MAX_HEADER_LENGTH, source.size));
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

		const index = new SearchIndex(source, off, sourceChecksum, ngram, groupSize, firstId, placeCount);
		const expectedTotal = off + index.listCount * index.bytesPerList;
		if (source.size !== expectedTotal) {
			throw new Error(`search index has ${source.size} bytes but header implies ${expectedTotal}`);
		}
		return index;
	}

	close(): void {
		this.source.close?.();
	}

	/** ALPHABET_SIZE^ngram (784 for bigram). */
	get listCount(): number {
		return ALPHABET_SIZE ** this.ngram;
	}

	/** ceil(placeCount / groupSize). */
	get bitsPerList(): number {
		return Math.ceil(this.placeCount / this.groupSize);
	}

	/** ceil(bitsPerList / 8). */
	get bytesPerList(): number {
		return bytesForBits(this.bitsPerList);
	}

	/** One list's packed bits (Section B.4). Shared with later queries via
	 * the cache -- callers MUST NOT modify it (Section B.7 step 4). */
	list(listIndex: number): Uint8Array {
		const cached = this.listCache.get(listIndex)?.deref();
		if (cached) return cached;
		const { bytesPerList } = this;
		const list = this.source.readSync(this.listsStart + listIndex * bytesPerList, bytesPerList);
		this.listCache.set(listIndex, new WeakRef(list));
		return list;
	}
}

/** Where a search index for `binPath` conventionally lives, and where
 * `CGeoDataReader.open()` looks for one: `data/world.bin` →
 * `data/world.search-index.bin`. */
export function searchIndexPathFor(binPath: string): string {
	return `${binPath.replace(/\.bin$/, "")}.search-index.bin`;
}

// ── Candidate lookup (Section B.7) ───────────────────────────────────────────

/** ANDs the named lists together into a fresh buffer (Section B.7 step 4),
 * or undefined as soon as the result is known to be all zero. */
function andLists(index: SearchIndex, listIds: readonly number[]): Uint8Array | undefined {
	const result = new Uint8Array(index.bytesPerList);
	result.set(index.list(listIds[0]!));
	for (let k = 1; k < listIds.length; k++) {
		const list = index.list(listIds[k]!);
		let any = 0;
		for (let b = 0; b < result.length; b++) any |= result[b] = result[b]! & list[b]!;
		if (any === 0) return undefined;
	}
	return result;
}

/** Expands a surviving packed-bit mask back into place positions: each
 * set bit `g` stands for the group `[g*groupSize, g*groupSize+groupSize)`. */
function expandCandidates(mask: Uint8Array, index: SearchIndex): number[] {
	const positions: number[] = [];
	for (let byte = 0; byte < mask.length; byte++) {
		const bits = mask[byte]!;
		if (bits === 0) continue;
		for (let bit = byte * 8; bit < byte * 8 + 8; bit++) {
			if ((bits & (1 << (bit & 7))) === 0) continue;
			const start = bit * index.groupSize;
			const end = Math.min(start + index.groupSize, index.placeCount);
			for (let p = start; p < end; p++) positions.push(p);
		}
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
	const mask = andLists(index, [...seen]);
	return mask ? expandCandidates(mask, index) : [];
}
