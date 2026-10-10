/**
 * Trigram search index (Appendix B of binary-format.md): a sidecar file
 * that lets `CGeoDataReader.search()` confirm only the places whose names
 * could contain the query, instead of scanning every name block.
 *
 * The file is CGEODATA kind 1, version 3 (stored `version` varint 19). It
 * holds, for every place of its source:
 *   - one list of place ids per trigram of folded symbols (Section B.3):
 *     exact lists for Latin trigrams, hashed ones for the rest, each an
 *     id list or a bitmap, whichever is smaller (Section B.4);
 *   - a short-query table (Section B.6): the top places, in relevance
 *     order, for every 1-2 character query that has any match -- in the
 *     plain order of Section B.5 or the area order of Section B.5.1, as
 *     its header's `relevance_rule` says.
 * Nothing is compressed, and the header records every section's length,
 * so a reader reads the header once and afterwards only the lists or the
 * table block a query needs, each cached behind a WeakRef.
 */

import { CGeoDataFormatError, CGeoDataVersionError } from "./errors.ts";
import type { CGeoDataReader, PlaceLevel } from "./reader.ts";
import type { Needle, RankedMatch } from "./relevance.ts";
import {
	compareAreaRelevance,
	compareRelevance,
	foldDiacritics,
	nameMatchQuality,
	prepareNeedle,
	QUALITY_MAX,
	regionRankArea,
} from "./relevance.ts";
import { type ByteSource, type SourceInput, toSource } from "./source.ts";
import { readVarint, writeVarint } from "./varint.ts";

// ── Symbol folding (Section B.2) ──────────────────────────────────────────────

/** Symbol 26: every ASCII character other than a letter or digit. */
const SEPARATOR = 26;
/** Symbol 27: every ASCII digit. */
const DIGIT = 27;

/** The folded form (`foldDiacritics`: NFD, drop combining diacritics,
 * lowercase), then one symbol per code point: a-z -> 0-25, 0-9 -> 27,
 * other ASCII -> 26, everything from U+0080 up -> its own code point.
 * Section B.2 defines the symbol sequence as *continuing from* the folded
 * form, so this must reuse `foldDiacritics` rather than repeat it -- two
 * copies of the first three steps could drift, and the index's
 * never-lose-a-match guarantee (Section B.9) rests on them being
 * identical. */
export function foldSymbols(text: string): number[] {
	const symbols: number[] = [];
	for (const ch of foldDiacritics(text)) {
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
	for (let i = 0; i < bytes.length; i++)
		h = Math.imul(h ^ bytes[i]!, 0x01000193);
	return h >>> 0;
}

/** The list index of trigram `(a, b, c)`: exact for Latin symbols,
 * otherwise FNV-1a 32 of the three symbols as u24s, xor-folded to
 * `hashExp` bits. */
export function trigramListIndex(
	a: number,
	b: number,
	c: number,
	hashExp: number,
): number {
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
const SIGNATURE = Uint8Array.from([
	0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41,
]);
const KIND_SEARCH_INDEX = 1;
// Version 2: relevance order (Section B.5) folds diacritics and reverses
// the per-level bonus to favor country over city -- a version-1 file's
// short-query table was built under the old, un-folded rule and would
// silently rank or match differently under new code, with nothing in its
// bytes to tell a reader it's stale (Section B.8's checksum only covers
// the source place table, not the ranking rule an index was built with).
// Version 3 records that rule in `relevance_rule`, since a table can now
// be built in either of two orders.
const FORMAT_VERSION = 3;
const STORED_VERSION = KIND_SEARCH_INDEX * 16 + FORMAT_VERSION; // 19
/** `relevance_rule` of a short-query table in Section B.5's plain order. */
export const RELEVANCE_PLAIN = 0;
/** `relevance_rule` of a short-query table in Section B.5.1's area order. */
export const RELEVANCE_AREA = 1;
const ENCODING_ID_LIST = 0;
const ENCODING_BITMAP = 1;
const MAX_EXP = 24;
/** signature + version + checksum + place_count + 4 u8s + 3 lengths,
 * with every varint at its 8-byte maximum. */
const MAX_HEADER_LENGTH = 8 + 8 + 8 + 8 + 4 + 3 * 8;

/** Parameters of a search index (Appendix B.11); every one has a
 * recommended default (`DEFAULT_SEARCH_INDEX_OPTIONS`). */
export interface SearchIndexOptions {
	/** 2^hashExp shared lists for non-Latin trigrams (1-24). */
	hashExp?: number;
	/** Places per short-query entry; 0 leaves the table out (0-255). */
	topCount?: number;
	/** 2^topBlockExp entries per short-query table block (0-24). */
	topBlockExp?: number;
	/**
	 * Which order to build the short-query table in, as
	 * `SearchOptions.areaTieBreak` would rank a search: `"auto"` by area
	 * when the reader has a locate index (`CGeoDataReader.placeAreas()`),
	 * `true` by area (rejecting without one), `false` plainly. A reader
	 * only answers from the table when it ranks the same way, so build it
	 * the way the index will be used: with `"auto"`, after the locate index.
	 */
	areaTieBreak?: "auto" | boolean;
}

/** Appendix B.11's recommended parameters. */
export const DEFAULT_SEARCH_INDEX_OPTIONS: Readonly<
	Required<SearchIndexOptions>
> = {
	hashExp: 15,
	topCount: 5,
	topBlockExp: 6,
	areaTieBreak: "auto",
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

/** Inserts into a top-`k` list kept in `compare`'s order. */
function pushTop(
	top: RankedMatch[],
	match: RankedMatch,
	k: number,
	compare: (a: RankedMatch, b: RankedMatch) => number,
): void {
	if (top.length === k && compare(match, top[k - 1]!) >= 0) return;
	let i = top.length;
	while (i > 0 && compare(match, top[i - 1]!) < 0) i--;
	top.splice(i, 0, match);
	if (top.length > k) top.pop();
}

/** Builds a search index (Appendix B) over every place in `reader` and
 * returns the file's bytes. A pure function of the place table and the
 * options: the same input always gives the same bytes. */
export async function buildSearchIndex(
	reader: CGeoDataReader,
	options: SearchIndexOptions = {},
): Promise<Uint8Array> {
	const { hashExp, topCount, topBlockExp, areaTieBreak } = {
		...DEFAULT_SEARCH_INDEX_OPTIONS,
		...options,
	};
	if (!(Number.isInteger(hashExp) && hashExp >= 1 && hashExp <= MAX_EXP)) {
		throw new RangeError(
			`hashExp must be an integer from 1 to ${MAX_EXP}, not ${hashExp}`,
		);
	}
	if (!(Number.isInteger(topCount) && topCount >= 0 && topCount <= 255)) {
		throw new RangeError(
			`topCount must be an integer from 0 to 255, not ${topCount}`,
		);
	}
	if (
		!(
			Number.isInteger(topBlockExp) &&
			topBlockExp >= 0 &&
			topBlockExp <= MAX_EXP
		)
	) {
		throw new RangeError(
			`topBlockExp must be an integer from 0 to ${MAX_EXP}, not ${topBlockExp}`,
		);
	}
	const { countries, regions, cities } = reader.placeCounts;
	const N = countries + regions + cities;
	const levelOf = (id: number): PlaceLevel =>
		id < countries ? "country" : id < countries + regions ? "region" : "city";

	const found = areaTieBreak === false ? undefined : await reader.placeAreas();
	if (areaTieBreak === true && !found) {
		throw new RangeError(
			"areaTieBreak true ranks by the areas in a locate index, and the reader has none",
		);
	}
	// Only the short-query table is ranked; without one, there's nothing to
	// rank by area, and no reason to bind the index to the chunks.
	const areas = topCount > 0 ? found : undefined;
	const rule = areas ? RELEVANCE_AREA : RELEVANCE_PLAIN;
	const compare = areas ? compareAreaRelevance : compareRelevance;
	const rankAreas = areas ? await placeRankAreas(reader, areas) : undefined;

	const postings = new Map<number, number[]>();
	const table = new Map<string, RankedMatch[]>();
	const keyNeedles = new Map<string, Needle>();
	for (let id = 0; id < N; id++) {
		const names = await reader.placeNames(id);
		const lists = new Set<number>();
		const keyQuality = new Map<string, number>();
		for (const name of names) {
			for (const l of trigramListIndices(name, hashExp)) lists.add(l);
			if (topCount === 0) continue;
			// Every 1-2 code point substring of the name's folded form is a
			// key (Section B.6); grade it exactly as a live query of that key
			// would be -- `nameMatchQuality` is the same function `search()`
			// uses, so the table can never rank differently than a live
			// search over the same data would.
			const folded = foldDiacritics(name);
			const cps = Array.from(folded);
			for (let i = 0; i < cps.length; i++) {
				for (let len = 1; len <= 2 && i + len <= cps.length; len++) {
					const key = len === 1 ? cps[i]! : cps[i]! + cps[i + 1]!;
					if ((keyQuality.get(key) ?? 0) >= QUALITY_MAX) continue;
					let needle = keyNeedles.get(key);
					if (!needle) {
						needle = prepareNeedle(key);
						keyNeedles.set(key, needle);
					}
					const quality = nameMatchQuality(name, needle);
					if (quality > (keyQuality.get(key) ?? 0))
						keyQuality.set(key, quality);
				}
			}
		}
		for (const l of lists) {
			const list = postings.get(l);
			if (list) list.push(id);
			else postings.set(l, [id]);
		}
		const level = levelOf(id);
		const rankArea = rankAreas?.[id] ?? 0;
		for (const [key, quality] of keyQuality) {
			let top = table.get(key);
			if (!top) {
				top = [];
				table.set(key, top);
			}
			pushTop(
				top,
				{ id, level, quality, contextQuality: 0, rankArea },
				topCount,
				compare,
			);
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
	// A table ranked by area depends on the chunks too (Section B.8).
	const checksum =
		rule === RELEVANCE_AREA
			? await reader.prefixChecksum()
			: await reader.placeTableChecksum();
	const checksumBytes = new Uint8Array(8);
	const dv = new DataView(checksumBytes.buffer);
	dv.setUint32(0, Number(checksum & 0xffffffffn), true);
	dv.setUint32(4, Number(checksum >> 32n), true);
	out.bytes(checksumBytes);
	out.varint(N);
	out.byte(hashExp);
	out.byte(topCount);
	out.byte(topBlockExp);
	out.byte(rule);
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

/** Every place's rank area (Section B.5.1), by id: its area byte, or for
 * a region with a same-named city, that city's. */
async function placeRankAreas(
	reader: CGeoDataReader,
	areas: Uint8Array,
): Promise<Uint8Array> {
	const rankAreas = areas.slice();
	const { countries, regions } = reader.placeCounts;
	for (let region = countries; region < countries + regions; region++) {
		const [lo, hi] = reader.subtreeIdRanges(region)[1] ?? [0, 0];
		const cities: Array<{ localName: string; area: number }> = [];
		for (let city = lo; city < hi; city++) {
			const names = await reader.placeNames(city);
			cities.push({ localName: names[0] ?? "", area: areas[city]! });
		}
		const own = await reader.placeNames(region);
		rankAreas[region] = regionRankArea(own[0] ?? "", areas[region]!, cities);
	}
	return rankAreas;
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
	private readonly tableBlockCache = new Map<
		number,
		WeakRef<Map<string, number[]>>
	>();

	private readonly source: ByteSource;
	/** The index file's name, when its source has one (`ByteSource.name`). */
	readonly name?: string;
	/** Checksum of the source it was built from (Section B.8): of its
	 * place table, or for `RELEVANCE_AREA`, of everything before its first
	 * chunk. A reader only accepts the index when it matches its own. */
	readonly sourceChecksum: bigint;
	/** N, the number of places in the source; every one is indexed. */
	readonly placeCount: number;
	/** 2^hashExp shared lists for non-Latin trigrams (Section B.3). */
	readonly hashExp: number;
	/** Places per short-query entry; 0 when the file has no table. */
	readonly topCount: number;
	/** 2^topBlockExp short-query entries per table block (Section B.6). */
	readonly topBlockExp: number;
	/** The order its short-query table is in: `RELEVANCE_PLAIN` (Section
	 * B.5) or `RELEVANCE_AREA` (Section B.5.1). */
	readonly relevanceRule: number;
	private readonly listDirectoryStart: number;
	private readonly listDirectoryLength: number;
	private readonly listsStart: number;
	private readonly listsLength: number;
	private readonly tableDirectoryStart: number;
	private readonly tableDirectoryLength: number;
	private readonly tableBlocksStart: number;
	private readonly tableBlocksLength: number;

	private constructor(
		source: ByteSource,
		sourceChecksum: bigint,
		placeCount: number,
		hashExp: number,
		topCount: number,
		topBlockExp: number,
		relevanceRule: number,
		listDirectoryStart: number,
		listDirectoryLength: number,
		listsStart: number,
		listsLength: number,
		tableDirectoryStart: number,
		tableDirectoryLength: number,
		tableBlocksStart: number,
		tableBlocksLength: number,
	) {
		this.source = source;
		if (source.name !== undefined) this.name = source.name;
		this.sourceChecksum = sourceChecksum;
		this.placeCount = placeCount;
		this.hashExp = hashExp;
		this.topCount = topCount;
		this.topBlockExp = topBlockExp;
		this.relevanceRule = relevanceRule;
		this.listDirectoryStart = listDirectoryStart;
		this.listDirectoryLength = listDirectoryLength;
		this.listsStart = listsStart;
		this.listsLength = listsLength;
		this.tableDirectoryStart = tableDirectoryStart;
		this.tableDirectoryLength = tableDirectoryLength;
		this.tableBlocksStart = tableBlocksStart;
		this.tableBlocksLength = tableBlocksLength;
	}

	/** Opens a search index file (read on demand, like a `.bin`),
	 * validating its header (Section B.10). Takes ownership of a
	 * `ByteSource`: `close()` closes it, as does a failed open. */
	static async open(input: SourceInput): Promise<SearchIndex> {
		const source = toSource(input);
		try {
			return await SearchIndex.parseHeader(source);
		} catch (error) {
			await source.close?.();
			throw error;
		}
	}

	private static async parseHeader(source: ByteSource): Promise<SearchIndex> {
		const data = await source.read(0, Math.min(MAX_HEADER_LENGTH, source.size));
		if (data.length < SIGNATURE.length + 1) {
			throw new CGeoDataFormatError(
				"search index file is too short to be valid",
			);
		}
		for (let i = 0; i < SIGNATURE.length; i++) {
			if (data[i] !== SIGNATURE[i]) {
				throw new CGeoDataFormatError(
					"not a CGEODATA search index file (wrong magic bytes)",
				);
			}
		}
		let off = SIGNATURE.length;
		const varint = (): number => {
			const { value, bytesRead } = readVarint(data, off);
			off += bytesRead;
			return value;
		};
		const u8 = (what: string): number => {
			if (off >= data.length)
				throw new CGeoDataFormatError(
					`search index file is too short for ${what}`,
				);
			return data[off++]!;
		};

		const storedVersion = varint();
		const kind = Math.floor(storedVersion / 16);
		const version = storedVersion % 16;
		if (kind !== KIND_SEARCH_INDEX) {
			throw new CGeoDataFormatError(
				`not a text search index file (kind ${kind}, expected ${KIND_SEARCH_INDEX})`,
			);
		}
		if (version !== FORMAT_VERSION) {
			throw new CGeoDataVersionError(
				version === 0
					? "search index is the old bigram layout (kind 1, version 0); rebuild it with build-search-index"
					: version === 1
						? "search index predates diacritic folding (kind 1, version 1); rebuild it with build-search-index"
						: version === 2
							? "search index predates ranking by area (kind 1, version 2); rebuild it with build-search-index"
							: `unsupported search index version ${version} (expected ${FORMAT_VERSION})`,
				version,
			);
		}
		if (data.length < off + 8)
			throw new CGeoDataFormatError(
				"search index file is too short for source checksum",
			);
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const sourceChecksum =
			BigInt(dv.getUint32(off, true)) |
			(BigInt(dv.getUint32(off + 4, true)) << 32n);
		off += 8;
		const placeCount = varint();
		const hashExp = u8("hash_exp");
		const topCount = u8("top_count");
		const topBlockExp = u8("top_block_exp");
		const relevanceRule = u8("relevance_rule");
		if (relevanceRule !== RELEVANCE_PLAIN && relevanceRule !== RELEVANCE_AREA)
			throw new CGeoDataFormatError(
				`unknown search index relevance_rule ${relevanceRule}`,
			);
		if (hashExp < 1 || hashExp > MAX_EXP)
			throw new CGeoDataFormatError(
				`hash_exp must be from 1 to ${MAX_EXP}, not ${hashExp}`,
			);
		if (topBlockExp > MAX_EXP)
			throw new CGeoDataFormatError(
				`top_block_exp must be at most ${MAX_EXP}, not ${topBlockExp}`,
			);
		const listDirectoryLength = varint();
		const listsLength = varint();
		const tableDirectoryLength = varint();

		const listDirectoryStart = off;
		const listsStart = listDirectoryStart + listDirectoryLength;
		const tableDirectoryStart = listsStart + listsLength;
		const tableBlocksStart = tableDirectoryStart + tableDirectoryLength;
		if (tableBlocksStart > source.size) {
			throw new CGeoDataFormatError(
				`search index header's section lengths run to byte ${tableBlocksStart}, past the end of the ${source.size}-byte file`,
			);
		}
		const tableBlocksLength = source.size - tableBlocksStart;
		if (topCount === 0 && tableDirectoryLength + tableBlocksLength > 0) {
			throw new CGeoDataFormatError(
				"search index has a short-query table but top_count 0",
			);
		}
		const presenceLength = Math.ceil((LATIN_LISTS + 2 ** hashExp) / 8);
		if (listDirectoryLength < presenceLength) {
			throw new CGeoDataFormatError(
				`search index list directory is ${listDirectoryLength} bytes, shorter than its ${presenceLength}-byte presence bitmap`,
			);
		}
		return new SearchIndex(
			source,
			sourceChecksum,
			placeCount,
			hashExp,
			topCount,
			topBlockExp,
			relevanceRule,
			listDirectoryStart,
			listDirectoryLength,
			listsStart,
			listsLength,
			tableDirectoryStart,
			tableDirectoryLength,
			tableBlocksStart,
			tableBlocksLength,
		);
	}

	/** Closes the index's source. */
	async close(): Promise<void> {
		await this.source.close?.();
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
	async candidates(text: string): Promise<number[] | undefined> {
		const indices = trigramListIndices(text, this.hashExp);
		if (indices.length === 0) return undefined;
		const dir = await this.listDirectory();
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
			const list = await this.list(dir, slot);
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
	 * isn't one or two code points long once folded.
	 *
	 * The key is `foldDiacritics(text)`, so an accented query and its
	 * unaccented spelling land on the same entry -- which is only the
	 * right answer for a query that needed no folding in the first place.
	 * Callers MUST therefore apply Section B.9 step 1's own precondition
	 * (the query's folded form already equals its plain lowercase form)
	 * before trusting this; `CGeoDataReader.searchRanked` does.
	 */
	async shortQuery(text: string): Promise<number[] | undefined> {
		if (this.topCount === 0) return undefined;
		const key = foldDiacritics(text);
		const length = Array.from(key).length;
		if (length < 1 || length > 2) return undefined;
		const dir = await this.tableDirectory();
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
		return (await this.tableBlock(dir, lo - 1)).get(key) ?? [];
	}

	private async listDirectory(): Promise<ListDirectory> {
		const cached = this.listDirectoryCache?.deref();
		if (cached) return cached;
		const data = await this.source.read(
			this.listDirectoryStart,
			this.listDirectoryLength,
		);
		const listCount = this.listCount;
		const presenceLength = Math.ceil(listCount / 8);
		const present: number[] = [];
		for (let byte = 0; byte < presenceLength; byte++) {
			const bits = data[byte]!;
			if (bits === 0) continue;
			for (let bit = 0; bit < 8; bit++) {
				if ((bits & (1 << bit)) === 0) continue;
				const l = byte * 8 + bit;
				if (l >= listCount)
					throw new CGeoDataFormatError(
						`search index presence bitmap marks list ${l}, beyond its ${listCount} lists`,
					);
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
			if (length === 0)
				throw new CGeoDataFormatError(
					`search index stores list ${present[slot]} with length 0`,
				);
			if (encoding === ENCODING_BITMAP && length !== bitmapLength) {
				throw new CGeoDataFormatError(
					`search index bitmap for list ${present[slot]} is ${length} bytes, expected ${bitmapLength}`,
				);
			}
			dir.offsets[slot] = listOffset;
			dir.lengths[slot] = length;
			dir.encodings[slot] = encoding;
			listOffset += length;
		}
		if (off !== data.length) {
			throw new CGeoDataFormatError(
				`search index list directory has ${data.length - off} bytes after its last entry`,
			);
		}
		if (listOffset !== this.listsLength) {
			throw new CGeoDataFormatError(
				`search index list lengths add up to ${listOffset}, but lists_length is ${this.listsLength}`,
			);
		}
		this.listDirectoryCache = new WeakRef(dir);
		return dir;
	}

	/** One stored list's bytes. Shared with later queries through the
	 * cache: callers MUST NOT modify it. */
	private async list(dir: ListDirectory, slot: number): Promise<Uint8Array> {
		const l = dir.indices[slot]!;
		const cached = this.listCache.get(l)?.deref();
		if (cached) return cached;
		const list = await this.source.read(
			this.listsStart + dir.offsets[slot]!,
			dir.lengths[slot]!,
		);
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
			if (ids.length > 0 && value === 0)
				throw new CGeoDataFormatError(
					"search index id list is not strictly increasing",
				);
			id += value;
			if (id >= this.placeCount)
				throw new CGeoDataFormatError(
					`search index lists place ${id}, beyond its ${this.placeCount} places`,
				);
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
				if (id >= this.placeCount)
					throw new CGeoDataFormatError(
						`search index bitmap sets place ${id}, beyond its ${this.placeCount} places`,
					);
				ids.push(id);
			}
		}
		return ids;
	}

	private async tableDirectory(): Promise<TableDirectory> {
		const cached = this.tableDirectoryCache?.deref();
		if (cached) return cached;
		const data = await this.source.read(
			this.tableDirectoryStart,
			this.tableDirectoryLength,
		);
		let off = 0;
		const { value: keyCount, bytesRead } = readVarint(data, off);
		off += bytesRead;
		const blockCount = Math.ceil(keyCount / 2 ** this.topBlockExp);
		const dir: TableDirectory = { firstKeys: [], offsets: [], lengths: [] };
		let blockOffset = 0;
		for (let b = 0; b < blockCount; b++) {
			const end = data.indexOf(0, off);
			if (end < 0)
				throw new CGeoDataFormatError(
					"search index table directory ends inside a key",
				);
			const firstKey = data.slice(off, end);
			off = end + 1;
			const { value: length, bytesRead: lb } = readVarint(data, off);
			off += lb;
			const prev = dir.firstKeys[b - 1];
			if (prev && compareBytes(prev, firstKey) >= 0)
				throw new CGeoDataFormatError(
					"search index table directory keys are not in increasing order",
				);
			dir.firstKeys.push(firstKey);
			dir.offsets.push(blockOffset);
			dir.lengths.push(length);
			blockOffset += length;
		}
		if (off !== data.length) {
			throw new CGeoDataFormatError(
				`search index table directory has ${data.length - off} bytes after its last block`,
			);
		}
		if (blockOffset !== this.tableBlocksLength) {
			throw new CGeoDataFormatError(
				`search index table block lengths add up to ${blockOffset}, but the table is ${this.tableBlocksLength} bytes`,
			);
		}
		this.tableDirectoryCache = new WeakRef(dir);
		return dir;
	}

	private async tableBlock(
		dir: TableDirectory,
		b: number,
	): Promise<Map<string, number[]>> {
		const cached = this.tableBlockCache.get(b)?.deref();
		if (cached) return cached;
		const data = await this.source.read(
			this.tableBlocksStart + dir.offsets[b]!,
			dir.lengths[b]!,
		);
		const entries = new Map<string, number[]>();
		let off = 0;
		let prevKey: Uint8Array | undefined;
		while (off < data.length) {
			const end = data.indexOf(0, off);
			if (end < 0)
				throw new CGeoDataFormatError(
					`search index table block ${b} ends inside a key`,
				);
			const keyBytes = data.subarray(off, end);
			if (
				prevKey
					? compareBytes(prevKey, keyBytes) >= 0
					: compareBytes(dir.firstKeys[b]!, keyBytes) !== 0
			) {
				throw new CGeoDataFormatError(
					`search index table block ${b} is not in key order`,
				);
			}
			prevKey = keyBytes;
			off = end + 1;
			const { value: count, bytesRead } = readVarint(data, off);
			off += bytesRead;
			if (count < 1 || count > this.topCount) {
				throw new CGeoDataFormatError(
					`search index table entry has ${count} places, expected 1 to ${this.topCount}`,
				);
			}
			const ids: number[] = [];
			for (let i = 0; i < count; i++) {
				const { value: id, bytesRead: ib } = readVarint(data, off);
				off += ib;
				if (id >= this.placeCount)
					throw new CGeoDataFormatError(
						`search index table lists place ${id}, beyond its ${this.placeCount} places`,
					);
				ids.push(id);
			}
			entries.set(utf8Decoder.decode(keyBytes), ids);
		}
		if (entries.size > 2 ** this.topBlockExp) {
			throw new CGeoDataFormatError(
				`search index table block ${b} has ${entries.size} entries, more than 2^${this.topBlockExp}`,
			);
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
