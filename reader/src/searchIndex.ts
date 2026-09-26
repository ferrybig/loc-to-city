/**
 * Trigram search index (Appendix B of binary-format.md): a sidecar file
 * that lets `CGeoDataReader.search()` confirm only the places whose names
 * could contain the query, instead of scanning every name block.
 *
 * The file is CGEODATA kind 1, version 1 (stored `version` varint 17). It
 * holds, for every place of its source:
 *   - one list of place ids per trigram of folded symbols (Section B.3):
 *     exact lists for Latin trigrams, hashed ones for the rest, each an
 *     id list or a bitmap, whichever is smaller (Section B.4);
 *   - a short-query table (Section B.6): the top places, in relevance
 *     order, for every 1-2 character query that has any match.
 * Nothing is compressed, and the header records every section's length,
 * so a reader reads the header once and afterwards only the lists or the
 * table block a query needs, each cached behind a WeakRef like the
 * reader's name blocks.
 */
import type { CGeoDataReader, PlaceLevel } from "./reader.js";
import { containsTokenRun, LEVEL_BONUS, tokenize } from "./relevance.js";
import { openSource, type RandomAccessSource } from "./source.js";
import { readVarint, writeVarint } from "./varint.js";

// ── Symbol folding (Section B.2) ──────────────────────────────────────────────

/** Symbol 26: every ASCII character other than a letter or digit. */
const SEPARATOR = 26;
/** Symbol 27: every ASCII digit. */
const DIGIT = 27;
const COMBINING = /[\u0300-\u036f]/g;

/** NFD, drop combining diacritics, lowercase, then one symbol per code
 * point: a-z -> 0-25, 0-9 -> 27, other ASCII -> 26, everything from
 * U+0080 up -> its own code point. */
export function foldSymbols(text: string): number[] {
	const symbols: number[] = [];
	for (const ch of text.normalize("NFD").replace(COMBINING, "").toLowerCase()) {
		const cp = ch.codePointAt(0)!;
		if (cp >= 0x61 && cp <= 0x7a) symbols.push(cp - 0x61);
		else if (cp >= 0x30 && cp <= 0x39) symbols.push(DIGIT);
		else if (cp < 0x80) symbols.push(SEPARATOR);
		else symbols.push(cp);
	}
	return symbols;
}

// ── Trigrams (Section B.3) ────────────────────────────────────────────────────

/** 28^3: every trigram of Latin symbols (0-27) has a list of its own. */
const LATIN_LISTS = 28 ** 3;

/** 32-bit FNV-1a. */
export function fnv1a32(bytes: Uint8Array): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
	return h >>> 0;
}

/** The list index of trigram `(a, b, c)`: exact for Latin symbols,
 * otherwise FNV-1a 32 of the three symbols as u24s, xor-folded to
 * `hashExp` bits. */
export function trigramListIndex(a: number, b: number, c: number, hashExp: number): number {
	if (a < 28 && b < 28 && c < 28) return a * 784 + b * 28 + c;
	let h = 0x811c9dc5;
	for (const s of [a, b, c]) {
		h = Math.imul(h ^ (s & 0xff), 0x01000193);
		h = Math.imul(h ^ ((s >>> 8) & 0xff), 0x01000193);
		h = Math.imul(h ^ ((s >>> 16) & 0xff), 0x01000193);
	}
	h >>>= 0;
	return LATIN_LISTS + ((((h >>> hashExp) ^ h) >>> 0) % 2 ** hashExp);
}

/** The distinct list indices of `text`'s trigrams, in order of first
 * occurrence; empty when it folds to fewer than 3 symbols. */
export function trigramListIndices(text: string, hashExp: number): number[] {
	const s = foldSymbols(text);
	const seen = new Set<number>();
	for (let i = 0; i + 3 <= s.length; i++) {
		seen.add(trigramListIndex(s[i]!, s[i + 1]!, s[i + 2]!, hashExp));
	}
	return [...seen];
}

// ── File format (Section B.7) ─────────────────────────────────────────────────

// "CGEODATA" -- same signature as the main data file.
const SIGNATURE = Uint8Array.from([0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]);
const KIND_SEARCH_INDEX = 1;
const FORMAT_VERSION = 1;
const STORED_VERSION = KIND_SEARCH_INDEX * 16 + FORMAT_VERSION; // 17
const ENCODING_ID_LIST = 0;
const ENCODING_BITMAP = 1;
const MAX_EXP = 24;
/** signature + version + checksum + place_count + 3 u8s + 3 lengths,
 * with every varint at its 8-byte maximum. */
const MAX_HEADER_LENGTH = 8 + 8 + 8 + 8 + 3 + 3 * 8;

export interface SearchIndexOptions {
	/** 2^hashExp shared lists for non-Latin trigrams (1-24). */
	hashExp?: number;
	/** Places per short-query entry; 0 leaves the table out (0-255). */
	topCount?: number;
	/** 2^topBlockExp entries per short-query table block (0-24). */
	topBlockExp?: number;
}

/** Appendix B.11's recommended parameters. */
export const DEFAULT_SEARCH_INDEX_OPTIONS: Readonly<Required<SearchIndexOptions>> = {
	hashExp: 15,
	topCount: 5,
	topBlockExp: 6,
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return a.length - b.length;
}

/** A growable byte buffer, for assembling a file far larger than a
 * `number[]` should hold. */
class ByteSink {
	private buf = new Uint8Array(1024);
	length = 0;

	private reserve(extra: number): void {
		if (this.length + extra <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.length + extra) size *= 2;
		const grown = new Uint8Array(size);
		grown.set(this.buf.subarray(0, this.length));
		this.buf = grown;
	}

	byte(value: number): void {
		this.reserve(1);
		this.buf[this.length++] = value;
	}

	bytes(values: Uint8Array): void {
		this.reserve(values.length);
		this.buf.set(values, this.length);
		this.length += values.length;
	}

	varint(value: number): void {
		this.bytes(writeVarint(value));
	}

	toBytes(): Uint8Array {
		return this.buf.slice(0, this.length);
	}
}

// ── Builder ───────────────────────────────────────────────────────────────────

interface Ranked {
	score: number;
	id: number;
}

/** Inserts into a top-`k` list kept in relevance order. Ids arrive in
 * ascending order, so a tie keeps the earlier, lower id ahead. */
function pushTop(top: Ranked[], score: number, id: number, k: number): void {
	if (top.length === k && score <= top[k - 1]!.score) return;
	let i = top.length;
	while (i > 0 && top[i - 1]!.score < score) i--;
	top.splice(i, 0, { score, id });
	if (top.length > k) top.pop();
}

/** Builds a search index (Appendix B) over every place in `reader` and
 * returns the file's bytes. A pure function of the place table and the
 * options: the same input always gives the same bytes. */
export function buildSearchIndex(reader: CGeoDataReader, options: SearchIndexOptions = {}): Uint8Array {
	const { hashExp, topCount, topBlockExp } = { ...DEFAULT_SEARCH_INDEX_OPTIONS, ...options };
	if (!(Number.isInteger(hashExp) && hashExp >= 1 && hashExp <= MAX_EXP)) {
		throw new RangeError(`hashExp must be an integer from 1 to ${MAX_EXP}, not ${hashExp}`);
	}
	if (!(Number.isInteger(topCount) && topCount >= 0 && topCount <= 255)) {
		throw new RangeError(`topCount must be an integer from 0 to 255, not ${topCount}`);
	}
	if (!(Number.isInteger(topBlockExp) && topBlockExp >= 0 && topBlockExp <= MAX_EXP)) {
		throw new RangeError(`topBlockExp must be an integer from 0 to ${MAX_EXP}, not ${topBlockExp}`);
	}
	const { countries, regions, cities } = reader.placeCounts;
	const N = countries + regions + cities;
	const levelOf = (id: number): PlaceLevel =>
		id < countries ? "country" : id < countries + regions ? "region" : "city";

	const postings = new Map<number, number[]>();
	const table = new Map<string, Ranked[]>();
	const keyTokens = new Map<string, string[]>();
	for (let id = 0; id < N; id++) {
		const names = reader.placeNames(id);
		const lists = new Set<number>();
		const keyQuality = new Map<string, number>();
		for (const name of names) {
			for (const l of trigramListIndices(name, hashExp)) lists.add(l);
			if (topCount === 0) continue;
			// Every 1-2 code point substring of the lowercase name is a key
			// (Section B.6); grade it as Section B.5's quality would.
			const lower = name.toLowerCase();
			const tokens = tokenize(name);
			const cps = Array.from(lower);
			for (let i = 0; i < cps.length; i++) {
				for (let len = 1; len <= 2 && i + len <= cps.length; len++) {
					const key = len === 1 ? cps[i]! : cps[i]! + cps[i + 1]!;
					if ((keyQuality.get(key) ?? 0) >= 4) continue;
					let needleTokens = keyTokens.get(key);
					if (!needleTokens) {
						needleTokens = tokenize(key);
						keyTokens.set(key, needleTokens);
					}
					const quality = lower === key ? 4 : containsTokenRun(tokens, needleTokens) ? 2 : 1;
					if (quality > (keyQuality.get(key) ?? 0)) keyQuality.set(key, quality);
				}
			}
		}
		for (const l of lists) {
			const list = postings.get(l);
			if (list) list.push(id);
			else postings.set(l, [id]);
		}
		const bonus = LEVEL_BONUS[levelOf(id)];
		for (const [key, quality] of keyQuality) {
			let top = table.get(key);
			if (!top) {
				top = [];
				table.set(key, top);
			}
			pushTop(top, quality + bonus, id, topCount);
		}
	}

	// Lists (Sections B.4, B.7).
	const listCount = LATIN_LISTS + 2 ** hashExp;
	const bitmapLength = Math.ceil(N / 8);
	const presence = new Uint8Array(Math.ceil(listCount / 8));
	const entries = new ByteSink();
	const lists = new ByteSink();
	for (const l of [...postings.keys()].sort((a, b) => a - b)) {
		const ids = postings.get(l)!;
		const idList = new ByteSink();
		let prev = 0;
		for (const id of ids) {
			idList.varint(id - prev);
			prev = id;
		}
		presence[l >> 3]! |= 1 << (l & 7);
		if (idList.length <= bitmapLength) {
			entries.varint(idList.length * 2 + ENCODING_ID_LIST);
			lists.bytes(idList.toBytes());
		} else {
			const bitmap = new Uint8Array(bitmapLength);
			for (const id of ids) bitmap[id >> 3]! |= 1 << (id & 7);
			entries.varint(bitmapLength * 2 + ENCODING_BITMAP);
			lists.bytes(bitmap);
		}
	}

	// Short-query table (Section B.6).
	const tableDirectory = new ByteSink();
	const tableBlocks = new ByteSink();
	if (topCount > 0) {
		const keys = [...table.keys()]
			.map((key) => ({ key, bytes: utf8Encoder.encode(key) }))
			.sort((a, b) => compareBytes(a.bytes, b.bytes));
		const blockSize = 2 ** topBlockExp;
		tableDirectory.varint(keys.length);
		for (let first = 0; first < keys.length; first += blockSize) {
			const block = new ByteSink();
			for (const { key, bytes } of keys.slice(first, first + blockSize)) {
				const top = table.get(key)!;
				block.bytes(bytes);
				block.byte(0);
				block.varint(top.length);
				for (const { id } of top) block.varint(id);
			}
			tableDirectory.bytes(keys[first]!.bytes);
			tableDirectory.byte(0);
			tableDirectory.varint(block.length);
			tableBlocks.bytes(block.toBytes());
		}
	}

	const out = new ByteSink();
	out.bytes(SIGNATURE);
	out.varint(STORED_VERSION);
	const checksum = reader.placeTableChecksum();
	const checksumBytes = new Uint8Array(8);
	const dv = new DataView(checksumBytes.buffer);
	dv.setUint32(0, Number(checksum & 0xffffffffn), true);
	dv.setUint32(4, Number(checksum >> 32n), true);
	out.bytes(checksumBytes);
	out.varint(N);
	out.byte(hashExp);
	out.byte(topCount);
	out.byte(topBlockExp);
	out.varint(presence.length + entries.length);
	out.varint(lists.length);
	out.varint(tableDirectory.length);
	out.bytes(presence);
	out.bytes(entries.toBytes());
	out.bytes(lists.toBytes());
	out.bytes(tableDirectory.toBytes());
	out.bytes(tableBlocks.toBytes());
	return out.toBytes();
}

/** Where a search index for `binPath` conventionally lives, and where
 * `CGeoDataReader.open()` looks for one: `data/world.bin` →
 * `data/world.search-index.bin`. */
export function searchIndexPathFor(binPath: string): string {
	return `${binPath.replace(/\.bin$/, "")}.search-index.bin`;
}

// ── Reader ────────────────────────────────────────────────────────────────────

/** The parsed list directory: the stored lists' indices (ascending), with
 * each one's offset into `lists`, length, and encoding. */
interface ListDirectory {
	indices: Int32Array;
	offsets: Float64Array;
	lengths: Int32Array;
	encodings: Uint8Array;
}

/** The parsed table directory: each block's first key, offset into
 * `table_blocks`, and length. */
interface TableDirectory {
	firstKeys: Uint8Array[];
	offsets: number[];
	lengths: number[];
}

/**
 * An open search index file (Appendix B). Opening reads and validates the
 * header only. The list directory, each list, the table directory, and
 * each table block are read the first time a query needs them, and kept
 * behind WeakRefs, so an index that goes unused for weeks costs no memory
 * beyond its header.
 *
 * Opening does NOT verify the source checksum -- `CGeoDataReader`'s
 * `useSearchIndex()` does that against the file it's attached to.
 */
export class SearchIndex {
	private listDirectoryCache: WeakRef<ListDirectory> | undefined;
	private readonly listCache = new Map<number, WeakRef<Uint8Array>>();
	private tableDirectoryCache: WeakRef<TableDirectory> | undefined;
	private readonly tableBlockCache = new Map<number, WeakRef<Map<string, number[]>>>();

	private constructor(
		private readonly source: RandomAccessSource,
		readonly sourceChecksum: bigint,
		/** N, the number of places in the source; every one is indexed. */
		readonly placeCount: number,
		readonly hashExp: number,
		/** Places per short-query entry; 0 when the file has no table. */
		readonly topCount: number,
		readonly topBlockExp: number,
		private readonly listDirectoryStart: number,
		private readonly listDirectoryLength: number,
		private readonly listsStart: number,
		private readonly listsLength: number,
		private readonly tableDirectoryStart: number,
		private readonly tableDirectoryLength: number,
		private readonly tableBlocksStart: number,
		private readonly tableBlocksLength: number,
	) {}

	/** Opens a search index from a file path (read on demand) or bytes,
	 * validating its header (Section B.10). */
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
		const varint = (): number => {
			const { value, bytesRead } = readVarint(data, off);
			off += bytesRead;
			return value;
		};
		const u8 = (what: string): number => {
			if (off >= data.length) throw new Error(`search index file is too short for ${what}`);
			return data[off++]!;
		};

		const storedVersion = varint();
		const kind = Math.floor(storedVersion / 16);
		const version = storedVersion % 16;
		if (kind !== KIND_SEARCH_INDEX) {
			throw new Error(`not a text search index file (kind ${kind}, expected ${KIND_SEARCH_INDEX})`);
		}
		if (version !== FORMAT_VERSION) {
			throw new Error(
				version === 0
					? "search index is the old bigram layout (kind 1, version 0); rebuild it with build-search-index"
					: `unsupported search index version ${version} (expected ${FORMAT_VERSION})`,
			);
		}
		if (data.length < off + 8) throw new Error("search index file is too short for source checksum");
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const sourceChecksum = BigInt(dv.getUint32(off, true)) | (BigInt(dv.getUint32(off + 4, true)) << 32n);
		off += 8;
		const placeCount = varint();
		const hashExp = u8("hash_exp");
		const topCount = u8("top_count");
		const topBlockExp = u8("top_block_exp");
		if (hashExp < 1 || hashExp > MAX_EXP) throw new Error(`hash_exp must be from 1 to ${MAX_EXP}, not ${hashExp}`);
		if (topBlockExp > MAX_EXP) throw new Error(`top_block_exp must be at most ${MAX_EXP}, not ${topBlockExp}`);
		const listDirectoryLength = varint();
		const listsLength = varint();
		const tableDirectoryLength = varint();

		const listDirectoryStart = off;
		const listsStart = listDirectoryStart + listDirectoryLength;
		const tableDirectoryStart = listsStart + listsLength;
		const tableBlocksStart = tableDirectoryStart + tableDirectoryLength;
		if (tableBlocksStart > source.size) {
			throw new Error(`search index header's section lengths run to byte ${tableBlocksStart}, past the end of the ${source.size}-byte file`);
		}
		const tableBlocksLength = source.size - tableBlocksStart;
		if (topCount === 0 && tableDirectoryLength + tableBlocksLength > 0) {
			throw new Error("search index has a short-query table but top_count 0");
		}
		const presenceLength = Math.ceil((LATIN_LISTS + 2 ** hashExp) / 8);
		if (listDirectoryLength < presenceLength) {
			throw new Error(`search index list directory is ${listDirectoryLength} bytes, shorter than its ${presenceLength}-byte presence bitmap`);
		}
		return new SearchIndex(
			source, sourceChecksum, placeCount, hashExp, topCount, topBlockExp,
			listDirectoryStart, listDirectoryLength, listsStart, listsLength,
			tableDirectoryStart, tableDirectoryLength, tableBlocksStart, tableBlocksLength,
		);
	}

	close(): void {
		this.source.close?.();
	}

	/** L = 28^3 + 2^hashExp possible list indices. */
	get listCount(): number {
		return LATIN_LISTS + 2 ** this.hashExp;
	}

	/**
	 * Section B.9 steps 2-4: every place whose names could contain `text`,
	 * ascending -- a superset of the real matches, which the caller still
	 * has to confirm name by name. Undefined when `text` folds to fewer
	 * than 3 symbols, i.e. the lists can't rule anything out.
	 */
	candidates(text: string): number[] | undefined {
		const indices = trigramListIndices(text, this.hashExp);
		if (indices.length === 0) return undefined;
		const dir = this.listDirectory();
		const slots: number[] = [];
		for (const l of indices) {
			const slot = findSlot(dir.indices, l);
			if (slot < 0) return []; // an empty list: nothing can match
			slots.push(slot);
		}
		// Shortest first: an id list's length tracks its size, and every
		// bitmap is as long as the longest id list could be.
		slots.sort((a, b) => dir.lengths[a]! - dir.lengths[b]!);
		let candidates: number[] | undefined;
		for (const slot of slots) {
			const list = this.list(dir, slot);
			if (dir.encodings[slot] === ENCODING_ID_LIST) {
				const ids = this.decodeIdList(list);
				candidates = candidates ? intersectSorted(candidates, ids) : ids;
			} else {
				candidates = candidates
					? candidates.filter((id) => (list[id >> 3]! & (1 << (id & 7))) !== 0)
					: this.expandBitmap(list);
			}
			if (candidates.length === 0) break;
		}
		return candidates!;
	}

	/**
	 * Section B.9 step 1: the short-query table's entry for `text` -- its
	 * top `topCount` places in relevance order (Section B.5), or `[]` when
	 * nothing matches. Undefined when the file has no table or `text`
	 * isn't one or two code points long once lowercased.
	 */
	shortQuery(text: string): number[] | undefined {
		if (this.topCount === 0) return undefined;
		const key = text.toLowerCase();
		const length = Array.from(key).length;
		if (length < 1 || length > 2) return undefined;
		const dir = this.tableDirectory();
		const keyBytes = utf8Encoder.encode(key);
		// The last block whose first key is at most `key`.
		let lo = 0;
		let hi = dir.firstKeys.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (compareBytes(dir.firstKeys[mid]!, keyBytes) <= 0) lo = mid + 1;
			else hi = mid;
		}
		if (lo === 0) return [];
		return this.tableBlock(dir, lo - 1).get(key) ?? [];
	}

	private listDirectory(): ListDirectory {
		const cached = this.listDirectoryCache?.deref();
		if (cached) return cached;
		const data = this.source.readSync(this.listDirectoryStart, this.listDirectoryLength);
		const listCount = this.listCount;
		const presenceLength = Math.ceil(listCount / 8);
		const present: number[] = [];
		for (let byte = 0; byte < presenceLength; byte++) {
			const bits = data[byte]!;
			if (bits === 0) continue;
			for (let bit = 0; bit < 8; bit++) {
				if ((bits & (1 << bit)) === 0) continue;
				const l = byte * 8 + bit;
				if (l >= listCount) throw new Error(`search index presence bitmap marks list ${l}, beyond its ${listCount} lists`);
				present.push(l);
			}
		}
		const dir: ListDirectory = {
			indices: Int32Array.from(present),
			offsets: new Float64Array(present.length),
			lengths: new Int32Array(present.length),
			encodings: new Uint8Array(present.length),
		};
		const bitmapLength = Math.ceil(this.placeCount / 8);
		let off = presenceLength;
		let listOffset = 0;
		for (let slot = 0; slot < present.length; slot++) {
			const { value, bytesRead } = readVarint(data, off);
			off += bytesRead;
			const length = Math.floor(value / 2);
			const encoding = value % 2;
			if (length === 0) throw new Error(`search index stores list ${present[slot]} with length 0`);
			if (encoding === ENCODING_BITMAP && length !== bitmapLength) {
				throw new Error(`search index bitmap for list ${present[slot]} is ${length} bytes, expected ${bitmapLength}`);
			}
			dir.offsets[slot] = listOffset;
			dir.lengths[slot] = length;
			dir.encodings[slot] = encoding;
			listOffset += length;
		}
		if (off !== data.length) {
			throw new Error(`search index list directory has ${data.length - off} bytes after its last entry`);
		}
		if (listOffset !== this.listsLength) {
			throw new Error(`search index list lengths add up to ${listOffset}, but lists_length is ${this.listsLength}`);
		}
		this.listDirectoryCache = new WeakRef(dir);
		return dir;
	}

	/** One stored list's bytes. Shared with later queries through the
	 * cache: callers MUST NOT modify it. */
	private list(dir: ListDirectory, slot: number): Uint8Array {
		const l = dir.indices[slot]!;
		const cached = this.listCache.get(l)?.deref();
		if (cached) return cached;
		const list = this.source.readSync(this.listsStart + dir.offsets[slot]!, dir.lengths[slot]!);
		this.listCache.set(l, new WeakRef(list));
		return list;
	}

	private decodeIdList(list: Uint8Array): number[] {
		const ids: number[] = [];
		let off = 0;
		let id = 0;
		while (off < list.length) {
			const { value, bytesRead } = readVarint(list, off);
			off += bytesRead;
			if (ids.length > 0 && value === 0) throw new Error("search index id list is not strictly increasing");
			id += value;
			if (id >= this.placeCount) throw new Error(`search index lists place ${id}, beyond its ${this.placeCount} places`);
			ids.push(id);
		}
		return ids;
	}

	private expandBitmap(bitmap: Uint8Array): number[] {
		const ids: number[] = [];
		for (let byte = 0; byte < bitmap.length; byte++) {
			const bits = bitmap[byte]!;
			if (bits === 0) continue;
			for (let bit = 0; bit < 8; bit++) {
				if ((bits & (1 << bit)) === 0) continue;
				const id = byte * 8 + bit;
				if (id >= this.placeCount) throw new Error(`search index bitmap sets place ${id}, beyond its ${this.placeCount} places`);
				ids.push(id);
			}
		}
		return ids;
	}

	private tableDirectory(): TableDirectory {
		const cached = this.tableDirectoryCache?.deref();
		if (cached) return cached;
		const data = this.source.readSync(this.tableDirectoryStart, this.tableDirectoryLength);
		let off = 0;
		const { value: keyCount, bytesRead } = readVarint(data, off);
		off += bytesRead;
		const blockCount = Math.ceil(keyCount / 2 ** this.topBlockExp);
		const dir: TableDirectory = { firstKeys: [], offsets: [], lengths: [] };
		let blockOffset = 0;
		for (let b = 0; b < blockCount; b++) {
			const end = data.indexOf(0, off);
			if (end < 0) throw new Error("search index table directory ends inside a key");
			const firstKey = data.slice(off, end);
			off = end + 1;
			const { value: length, bytesRead: lb } = readVarint(data, off);
			off += lb;
			const prev = dir.firstKeys[b - 1];
			if (prev && compareBytes(prev, firstKey) >= 0) throw new Error("search index table directory keys are not in increasing order");
			dir.firstKeys.push(firstKey);
			dir.offsets.push(blockOffset);
			dir.lengths.push(length);
			blockOffset += length;
		}
		if (off !== data.length) {
			throw new Error(`search index table directory has ${data.length - off} bytes after its last block`);
		}
		if (blockOffset !== this.tableBlocksLength) {
			throw new Error(`search index table block lengths add up to ${blockOffset}, but the table is ${this.tableBlocksLength} bytes`);
		}
		this.tableDirectoryCache = new WeakRef(dir);
		return dir;
	}

	private tableBlock(dir: TableDirectory, b: number): Map<string, number[]> {
		const cached = this.tableBlockCache.get(b)?.deref();
		if (cached) return cached;
		const data = this.source.readSync(this.tableBlocksStart + dir.offsets[b]!, dir.lengths[b]!);
		const entries = new Map<string, number[]>();
		let off = 0;
		let prevKey: Uint8Array | undefined;
		while (off < data.length) {
			const end = data.indexOf(0, off);
			if (end < 0) throw new Error(`search index table block ${b} ends inside a key`);
			const keyBytes = data.subarray(off, end);
			if (prevKey ? compareBytes(prevKey, keyBytes) >= 0 : compareBytes(dir.firstKeys[b]!, keyBytes) !== 0) {
				throw new Error(`search index table block ${b} is not in key order`);
			}
			prevKey = keyBytes;
			off = end + 1;
			const { value: count, bytesRead } = readVarint(data, off);
			off += bytesRead;
			if (count < 1 || count > this.topCount) {
				throw new Error(`search index table entry has ${count} places, expected 1 to ${this.topCount}`);
			}
			const ids: number[] = [];
			for (let i = 0; i < count; i++) {
				const { value: id, bytesRead: ib } = readVarint(data, off);
				off += ib;
				if (id >= this.placeCount) throw new Error(`search index table lists place ${id}, beyond its ${this.placeCount} places`);
				ids.push(id);
			}
			entries.set(utf8Decoder.decode(keyBytes), ids);
		}
		if (entries.size > 2 ** this.topBlockExp) {
			throw new Error(`search index table block ${b} has ${entries.size} entries, more than 2^${this.topBlockExp}`);
		}
		this.tableBlockCache.set(b, new WeakRef(entries));
		return entries;
	}
}

/** Position of `value` in the ascending `sorted`, or -1. */
function findSlot(sorted: Int32Array, value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo < sorted.length && sorted[lo] === value ? lo : -1;
}

function intersectSorted(a: readonly number[], b: readonly number[]): number[] {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i]! < b[j]!) i++;
		else if (a[i]! > b[j]!) j++;
		else {
			out.push(a[i]!);
			i++;
			j++;
		}
	}
	return out;
}
