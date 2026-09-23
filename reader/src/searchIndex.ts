/**
 * Bigram bitmap search index (Appendix B of binary-format.md): a compact
 * sidecar file that lets `cgeodata search` skip ~97-99% of the city table
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
import type {
	CGeoDataReader,
	Place,
	PlaceLevel,
	SearchOptions,
} from "./reader.js";
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
 * ready for `searchWithIndex`. Validates signature, kind, version, ngram,
 * group_size, and file length. Does NOT verify the source checksum — callers
 * that want that guarantee should compare `index.sourceChecksum` against
 * `reader.placeTableChecksum()` before use. */
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

// ── Searcher ──────────────────────────────────────────────────────────────────

/** ANDs the named lists together into one buffer of `bytesPerList` bytes.
 * Returns undefined when there are no lists to AND. Copies list[0] before
 * ANDing to avoid mutating the source buffer (Section B.7 step 4). */
function andLists(bits: Uint8Array, bytesPerList: number, listIds: readonly number[]): Uint8Array | undefined {
	if (listIds.length === 0) return undefined;
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

// ── Scoring (mirrors reader.ts's searchRanked internals) ─────────────────────

function tokenize(text: string): string[] {
	return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

function containsTokenRun(haystack: string[], needle: readonly string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

function nameScore(names: string[], needle: string, needleTokens: readonly string[]): number {
	let best = 0;
	for (const name of names) {
		const lower = name.toLowerCase();
		if (lower === needle) return 4;
		if (best < 2 && containsTokenRun(tokenize(name), needleTokens)) best = 2;
		if (best < 1 && lower.includes(needle)) best = 1;
	}
	return best;
}

// Must stay in sync with LEVEL_BONUS in reader.ts.
const LEVEL_BONUS: Record<PlaceLevel, number> = { city: 4, region: 2, country: 1 };

// ── Public search entry point ─────────────────────────────────────────────────

/**
 * Drop-in replacement for `CGeoDataReader.search()` that uses `index` to
 * skip most of the city table. Falls back to `reader.search()` when:
 *   - the query is shorter than 2 characters (no bigrams to extract), or
 *   - `--level` is `country` or `region` (the index only covers cities).
 *
 * Countries and regions are always scanned linearly and yielded before city
 * results when not sorted, matching `reader.search()`'s id-order behaviour.
 * All filters (`--level`, `--country`, `--sort`, `--limit`) work identically
 * with or without the index (Section B.7 step 7).
 */
export function* searchWithIndex(
	reader: CGeoDataReader,
	index: SearchIndex,
	text: string,
	options: SearchOptions = {},
): IterableIterator<Place> {
	const symbols = symbolSequence(text);
	const canUseIndex =
		symbols.length >= 2 &&
		options.level !== "country" &&
		options.level !== "region";

	if (!canUseIndex) {
		yield* reader.search(text, options);
		return;
	}

	// Collect distinct bigram list ids.
	const seen = new Set<number>();
	for (let i = 0; i + 1 < symbols.length; i++) seen.add(symbols[i]! * ALPHABET_SIZE + symbols[i + 1]!);
	const listIds = [...seen];

	const mask = andLists(index.bits, index.bytesPerList, listIds);
	// mask === undefined only when listIds is empty — can't happen here since
	// symbols.length >= 2 guarantees at least one bigram. Treat as all-candidates.
	const candidates = mask ? expandCandidates(mask, index) : range(index.placeCount);
	const needle = text.toLowerCase();

	if (!options.sort) {
		yield* unsortedSearch(reader, index, candidates, needle, options);
		return;
	}
	yield* sortedSearch(reader, index, candidates, needle, options);
}

function* unsortedSearch(
	reader: CGeoDataReader,
	index: SearchIndex,
	candidates: number[],
	needle: string,
	options: SearchOptions,
): IterableIterator<Place> {
	let remaining = options.limit ?? Infinity;
	// Drop limit/sort — we control pacing and sorting ourselves.
	const { limit: _l, sort: _s, ...subOpts } = options;

	// Countries and regions first (mirroring reader.search()'s id order).
	if (options.level !== "city") {
		for (const place of reader.search(needle, { ...subOpts, level: "country" })) {
			yield place;
			if (--remaining <= 0) return;
		}
		for (const place of reader.search(needle, { ...subOpts, level: "region" })) {
			yield place;
			if (--remaining <= 0) return;
		}
	}

	for (const position of candidates) {
		const id = index.firstId + position;
		if (!reader.placeNames(id).some((name) => name.toLowerCase().includes(needle))) continue;
		const place = reader.place(id);
		if (options.country !== undefined && place.country.id !== options.country) continue;
		if (options.region !== undefined && place.region?.id !== options.region) continue;
		yield place;
		if (--remaining <= 0) return;
	}
}

function* sortedSearch(
	reader: CGeoDataReader,
	index: SearchIndex,
	candidates: number[],
	needle: string,
	options: SearchOptions,
): IterableIterator<Place> {
	const needleTokens = tokenize(needle);
	const scored: { id: number; score: number }[] = [];
	const { limit: _l, sort: _s, ...subOpts } = options;

	if (options.level !== "city") {
		for (const place of reader.search(needle, { ...subOpts, level: "country" })) {
			scored.push({ id: place.id, score: nameScore(place.names, needle, needleTokens) + LEVEL_BONUS.country });
		}
		for (const place of reader.search(needle, { ...subOpts, level: "region" })) {
			scored.push({ id: place.id, score: nameScore(place.names, needle, needleTokens) + LEVEL_BONUS.region });
		}
	}

	for (const position of candidates) {
		const id = index.firstId + position;
		const names = reader.placeNames(id);
		const quality = nameScore(names, needle, needleTokens);
		if (quality === 0) continue;
		const place = reader.place(id);
		if (options.country !== undefined && place.country.id !== options.country) continue;
		if (options.region !== undefined && place.region?.id !== options.region) continue;
		scored.push({ id, score: quality + LEVEL_BONUS.city });
	}

	scored.sort((a, b) => b.score - a.score || a.id - b.id);
	let remaining = options.limit ?? Infinity;
	for (const { id } of scored) {
		if (--remaining < 0) return;
		yield reader.place(id);
	}
}

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}
