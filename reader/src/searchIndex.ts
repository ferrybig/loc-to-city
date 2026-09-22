/**
 * Bigram bitmap search index: a compact sidecar file that lets
 * `cgeodata search` skip ~97-99% of the city table on typical 3+
 * character queries, at the cost of ~6 MiB for the world dataset.
 *
 * Only cities are indexed (countries and regions are few enough that
 * scanning them linearly is negligible). For queries shorter than 2
 * characters (no bigrams to extract), `searchWithIndex` falls back
 * automatically to `CGeoDataReader.search()`.
 *
 * Binary format (little-endian):
 *   [0..3]   Magic "CGSI"
 *   [4]      version = 1
 *   [5]      ngram = 2  (bigram; reserved for future unigram support)
 *   [6..7]   groupSize uint16  (production default: 4)
 *   [8..11]  cityCount uint32
 *   [12..15] cityIdBase uint32
 *   [16..19] listCount uint32  (= ALPHABET_SIZE^ngram = 784)
 *   [20..23] bytesPerList uint32
 *   [24..27] bitsPerList uint32  (= ceil(cityCount / groupSize))
 *   [28..]   bits: listCount × bytesPerList bytes, list-major
 */
import type {
	CGeoDataReader,
	Place,
	PlaceLevel,
	SearchOptions,
} from "./reader.js";

// ── Alphabet ─────────────────────────────────────────────────────────────────

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

function setBit(
	buf: Uint8Array,
	listByteOffset: number,
	position: number,
): void {
	const i = listByteOffset + (position >> 3);
	buf[i] = buf[i]! | (1 << (position & 7));
}

/** OR-pools `fine` into groups of `groupSize` — output bit `g` is 1 iff any
 * of the `groupSize` fine bits `[g*groupSize, g*groupSize+groupSize)` is 1. */
function poolBits(
	fine: Uint8Array,
	listCount: number,
	totalBits: number,
	groupSize: number,
): Uint8Array {
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

// ── Binary format ─────────────────────────────────────────────────────────────

const MAGIC = [0x43, 0x47, 0x53, 0x49] as const; // "CGSI"
const FORMAT_VERSION = 1;
const INDEX_NGRAM = 2;
/** OR-pooling factor: 1 bit per 4 cities. Benchmarked as the best
 * size/speed trade-off on the world dataset (see experiments/README.md). */
const GROUP_SIZE = 4;
const HEADER_SIZE = 28;

export interface SearchIndex {
	readonly cityCount: number;
	readonly cityIdBase: number;
	readonly groupSize: number;
	readonly listCount: number;
	readonly bitsPerList: number;
	readonly bytesPerList: number;
	/** list-major bit array; listCount × bytesPerList bytes. */
	readonly bits: Uint8Array;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/** Builds a bigram bitmap index over all cities in `reader` and returns
 * the raw bytes ready to write to a file. */
export function buildSearchIndex(reader: CGeoDataReader): Uint8Array {
	const { cities: cityCount, countries, regions } = reader.placeCounts;
	const cityIdBase = countries + regions;
	const listCount = ALPHABET_SIZE ** INDEX_NGRAM; // 784
	const fineBytesPerList = bytesForBits(cityCount);
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
		for (const bg of bigramsSeen)
			setBit(bigramFine, bg * fineBytesPerList, position);
		position++;
	}

	const bitsPerList = Math.ceil(cityCount / GROUP_SIZE);
	const bytesPerList = bytesForBits(bitsPerList);
	const packed = poolBits(bigramFine, listCount, cityCount, GROUP_SIZE);

	const out = new Uint8Array(HEADER_SIZE + listCount * bytesPerList);
	const dv = new DataView(out.buffer);
	for (let i = 0; i < 4; i++) out[i] = MAGIC[i]!;
	out[4] = FORMAT_VERSION;
	out[5] = INDEX_NGRAM;
	dv.setUint16(6, GROUP_SIZE, true);
	dv.setUint32(8, cityCount, true);
	dv.setUint32(12, cityIdBase, true);
	dv.setUint32(16, listCount, true);
	dv.setUint32(20, bytesPerList, true);
	dv.setUint32(24, bitsPerList, true);
	out.set(packed, HEADER_SIZE);
	return out;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/** Parses a search index file (built with `buildSearchIndex` or the
 * `build-search-index` command) and returns a `SearchIndex` ready for
 * `searchWithIndex`. Throws on invalid magic or unsupported version. */
export function loadSearchIndex(data: Uint8Array): SearchIndex {
	if (data.length < HEADER_SIZE)
		throw new Error("search index file is too short to be valid");
	for (let i = 0; i < 4; i++) {
		if (data[i] !== MAGIC[i])
			throw new Error("not a CGSI search index file (wrong magic bytes)");
	}
	const version = data[4]!;
	if (version !== FORMAT_VERSION)
		throw new Error(
			`unsupported search index version ${version} (expected ${FORMAT_VERSION})`,
		);
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const cityCount = dv.getUint32(8, true);
	const cityIdBase = dv.getUint32(12, true);
	const groupSize = dv.getUint16(6, true);
	const listCount = dv.getUint32(16, true);
	const bytesPerList = dv.getUint32(20, true);
	const bitsPerList = dv.getUint32(24, true);
	const expectedBytes = HEADER_SIZE + listCount * bytesPerList;
	if (data.length !== expectedBytes) {
		throw new Error(
			`search index has ${data.length} bytes but header says ${expectedBytes}`,
		);
	}
	const bits = data.subarray(HEADER_SIZE);
	return {
		cityCount,
		cityIdBase,
		groupSize,
		listCount,
		bitsPerList,
		bytesPerList,
		bits,
	};
}

// ── Searcher ──────────────────────────────────────────────────────────────────

/** ANDs the named lists together into one buffer of `bytesPerList` bytes.
 * Returns undefined when there are no lists to AND (caller falls back to
 * treating all positions as candidates). Copies list[0] before ANDing to
 * avoid mutating the source buffer when `bits` is a view into a larger
 * mmap'd buffer. */
function andLists(
	bits: Uint8Array,
	bytesPerList: number,
	listIds: readonly number[],
): Uint8Array | undefined {
	if (listIds.length === 0) return undefined;
	const result = new Uint8Array(bytesPerList);
	result.set(
		bits.subarray(listIds[0]! * bytesPerList, (listIds[0]! + 1) * bytesPerList),
	);
	for (let k = 1; k < listIds.length; k++) {
		const off = listIds[k]! * bytesPerList;
		for (let b = 0; b < bytesPerList; b++)
			result[b] = result[b]! & bits[off + b]!;
	}
	return result;
}

/** Expands a surviving packed-bit mask back into city positions: each
 * set bit `g` stands for the group `[g*groupSize, g*groupSize+groupSize)`. */
function expandCandidates(mask: Uint8Array, index: SearchIndex): number[] {
	const positions: number[] = [];
	for (let bit = 0; bit < index.bitsPerList; bit++) {
		if ((mask[bit >> 3]! & (1 << (bit & 7))) === 0) continue;
		const start = bit * index.groupSize;
		const end = Math.min(start + index.groupSize, index.cityCount);
		for (let p = start; p < end; p++) positions.push(p);
	}
	return positions;
}

// ── Scoring (mirrors reader.ts's searchRanked internals) ─────────────────────

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 0);
}

function containsTokenRun(
	haystack: string[],
	needle: readonly string[],
): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

function nameScore(
	names: string[],
	needle: string,
	needleTokens: readonly string[],
): number {
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
const LEVEL_BONUS: Record<PlaceLevel, number> = {
	city: 4,
	region: 2,
	country: 1,
};

// ── Public search entry point ─────────────────────────────────────────────────

/**
 * Drop-in replacement for `CGeoDataReader.search()` that uses `index` to
 * skip most of the city table. Falls back to `reader.search()` when:
 *   - the query is shorter than 2 characters (no bigrams to extract), or
 *   - `--level` is `country` or `region` (the index only covers cities).
 *
 * Countries and regions are always scanned linearly (they are too few to
 * benefit from indexing) and yielded before city results when no `--sort`
 * is requested, matching `reader.search()`'s id-order behaviour.
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

	// Extract unique bigram list ids.
	const seen = new Set<number>();
	for (let i = 0; i + 1 < symbols.length; i++)
		seen.add(symbols[i]! * ALPHABET_SIZE + symbols[i + 1]!);
	const listIds = [...seen];

	const mask = andLists(index.bits, index.bytesPerList, listIds);
	// mask === undefined only when listIds is empty, which can't happen here
	// (symbols.length >= 2 guarantees at least one bigram). Treat undefined as
	// "all candidates" for defensive correctness.
	const candidates = mask
		? expandCandidates(mask, index)
		: range(index.cityCount);

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
		const id = index.cityIdBase + position;
		if (
			!reader.placeNames(id).some((name) => name.toLowerCase().includes(needle))
		)
			continue;
		const place = reader.place(id);
		if (options.country !== undefined && place.country.id !== options.country)
			continue;
		if (options.region !== undefined && place.region?.id !== options.region)
			continue;
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
		const id = index.cityIdBase + position;
		const names = reader.placeNames(id);
		const quality = nameScore(names, needle, needleTokens);
		if (quality === 0) continue;
		const place = reader.place(id);
		if (options.country !== undefined && place.country.id !== options.country)
			continue;
		if (options.region !== undefined && place.region?.id !== options.region)
			continue;
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
