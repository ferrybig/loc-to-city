import {
	type BoundingBox,
	cellBoundingBox,
	chunkBoundingBox,
} from "./cellBounds.js";
import { type ChunkRecords, parseChunk } from "./chunk.js";
import { readHeaderAndDirectory } from "./container.js";
import type { CGeoDataDirectory } from "./directory.js";
import type { CGeoDataHeader } from "./header.js";
import { mortonDecode, mortonEncode, shiftRight } from "./morton.js";
import {
	largestIndexWithPrefixAtMost,
	type PlaceTableInfo,
	parsePlaceTable,
	readNameBlock,
	resolveIdentifier,
} from "./placeTable.js";
import { existsSync } from "node:fs";
import {
	LEVEL_BONUS,
	placeMatchQuality,
	tokenize,
} from "./relevance.js";
import { SearchIndex, searchIndexPathFor } from "./searchIndex.js";
import { openSource, type RandomAccessSource } from "./source.js";
import { safeInflate } from "./zlibUtil.js";

export interface QueryResult {
	country: string[] | null;
	region: string[] | null;
	city: string[] | null;
	/**
	 * The lat/lon rectangle this result is valid for -- every coordinate in
	 * this box resolves to the exact same result as the one just queried.
	 * Callers doing many nearby lookups (e.g. a tile renderer sampling a
	 * grid of pixels) can cache on this to skip repeat queries that would
	 * land in the same underlying cell. It's as tight as the cell that
	 * produced the result when one was matched; for "unknown" results it's
	 * the whole empty chunk when possible, otherwise the single finest-grain
	 * cell containing the query point (always correct, just not maximal --
	 * the actual empty region in a gap between records isn't generally a
	 * plain rectangle, so this doesn't try to find its full extent).
	 */
	boundingBox: BoundingBox;
	/** Index of the chunk the query point falls in (Section 6.1's
	 * `r * W + c`), whether or not that chunk holds any records. Useful for
	 * narrowing a rebuild to one chunk with the compressor's `--only-chunks`
	 * when a query resolves unexpectedly. */
	chunkIndex: number;
}

export type PlaceLevel = "country" | "region" | "city";

/** A place's global id (Section 7.5) and its name entry (Section 7.4). */
export interface PlaceRef {
	id: number;
	names: string[];
}

/**
 * One entry of the place hierarchy with its ancestors resolved. Shaped
 * like QueryResult's country/region/city trio so the two are easy to
 * relate: a country has `region` and `city` null, a region has `city`
 * null and `region` pointing at itself, a city has all three set.
 */
export interface Place extends PlaceRef {
	level: PlaceLevel;
	country: PlaceRef;
	region: PlaceRef | null;
	city: PlaceRef | null;
}

export interface PlaceFilter {
	/** Only places of this level. */
	level?: PlaceLevel;
	/** Only places inside this country (by id); the country itself included. */
	country?: number;
	/** Only places inside this region (by id); the region itself included. */
	region?: number;
}

export interface SearchOptions extends PlaceFilter {
	/** Stop after this many matches. */
	limit?: number;
	/**
	 * Rank matches by relevance instead of id order: an exact name match
	 * outranks a match on a whole word of the name, which outranks a
	 * plain substring match; among equal name-match quality, a city
	 * outranks a region, which outranks a country. `limit` still applies,
	 * but to the top of the ranked list rather than the first N found in
	 * id order -- so with `sort` the whole match set has to be scored
	 * before anything is yielded, since the best match isn't necessarily
	 * the first one found.
	 */
	sort?: boolean;
}

/** One record of a chunk (Section 8.2) with its cell and place resolved. */
export interface ChunkRecord {
	code: number;
	depth: number;
	boundingBox: BoundingBox;
	/** null for a "no place" record (palette index 0). */
	place: Place | null;
}

export interface PlaceCounts {
	countries: number;
	regions: number;
	cities: number;
}

export class CGeoDataReader {
	private readonly chunkCache = new Map<number, WeakRef<ChunkRecords>>();
	/** Inflated name blocks (Section 7.3), split into entries. One inflate
	 * per block ever touched, whether a lookup wants one name or a walk
	 * wants all of them. */
	private readonly nameBlockCache = new Map<number, WeakRef<string[][]>>();
	/** Narrows `search()`'s city scan; see `useSearchIndex()`. */
	private searchIndex: SearchIndex | undefined;
	/** Whether `searchIndex` was opened here, and so is closed here. */
	private ownsSearchIndex = false;
	/** A `.search-index.bin` next to the file, still to be tried on the
	 * first search that needs it. */
	private pendingSearchIndexPath: string | undefined;
	private cachedPlaceTableChecksum: bigint | undefined;

	private constructor(
		private readonly source: RandomAccessSource,
		readonly header: CGeoDataHeader,
		readonly directory: CGeoDataDirectory,
		private readonly placeTable: PlaceTableInfo,
	) {}

	static open(input: string | Uint8Array): CGeoDataReader {
		const source = openSource(input);
		const { header, directory } = readHeaderAndDirectory(source);
		const placeTable = parsePlaceTable(
			source,
			directory.placeTableStart,
			directory.placeTableLength,
			header.keyframeExp,
		);
		const reader = new CGeoDataReader(source, header, directory, placeTable);
		if (typeof input === "string") {
			reader.pendingSearchIndexPath = searchIndexPathFor(input);
		}
		return reader;
	}

	close(): void {
		this.useSearchIndex(undefined);
		this.source.close?.();
	}

	get placeCounts(): PlaceCounts {
		const { countryCount, totalRegions, totalCities } = this.placeTable;
		return {
			countries: countryCount,
			regions: totalRegions,
			cities: totalCities,
		};
	}

	/** Section 9's lookup procedure. */
	query(lat: number, lon: number): QueryResult {
		if (!(lat >= -90 && lat < 90)) {
			throw new RangeError(
				`latitude ${lat} is outside the valid range [-90, 90)`,
			);
		}
		if (!(lon >= -180 && lon < 180)) {
			throw new RangeError(
				`longitude ${lon} is outside the valid range [-180, 180)`,
			);
		}

		const { width: W, height: H, maxDepth: D } = this.header;
		const NX = W * 2 ** D;
		const NY = H * 2 ** D;

		let gx = Math.floor(((lon + 180) / 360) * NX);
		let gy = Math.floor(((lat + 90) / 180) * NY);
		gx = Math.min(Math.max(gx, 0), NX - 1);
		gy = Math.min(Math.max(gy, 0), NY - 1);

		const cellsPerChunkSide = 2 ** D;
		const c = Math.floor(gx / cellsPerChunkSide);
		const r = Math.floor(gy / cellsPerChunkSide);
		const x = gx - c * cellsPerChunkSide;
		const y = gy - r * cellsPerChunkSide;
		const chunkIndex = r * W + c;
		const chunkBox = chunkBoundingBox(c, r, W, H);

		const chunk = this.getChunk(chunkIndex);
		if (!chunk) return unknownResult(chunkBox, chunkIndex); // whole chunk is empty

		const q = mortonEncode(x, y, D);
		const j = bisectRightMinusOne(chunk.codes, q);
		// Neither of these two "no record covers this" cases can recover the
		// gap's true extent without redoing the encoder's own subdivision
		// work, so fall back to the single finest cell around the query point.
		const finestCellBox = () => cellBoundingBox(chunkBox, x, y, D);
		if (j < 0) return unknownResult(finestCellBox(), chunkIndex);

		const depth = chunk.depths[j]!;
		const shift = 2 * (D - depth);
		const code = chunk.codes[j]!;
		if (shiftRight(q, shift) !== shiftRight(code, shift)) {
			return unknownResult(finestCellBox(), chunkIndex); // gap between records
		}

		// A real record matched: recover its exact cell (Section 8.1) for a
		// tight, correct bounding box, whether or not it resolves to a place.
		const matchedCellBox = this.recordBoundingBox(chunkBox, code, depth);

		const k = chunk.paletteIndices[j]!;
		if (k === 0) return unknownResult(matchedCellBox, chunkIndex);

		const place = this.place(chunk.palette[k - 1]!);
		return {
			country: place.country.names,
			region: place.region?.names ?? null,
			city: place.city?.names ?? null,
			boundingBox: matchedCellBox,
			chunkIndex,
		};
	}

	/** The names of one place by global id, without resolving its ancestors.
	 * Much cheaper than `place()` when only the names are needed. */
	placeNames(id: number): string[] {
		if (!Number.isInteger(id) || id < 0 || id >= this.placeTable.totalPlaces) {
			throw new RangeError(
				`${id} is not a place id for this file (0 <= id < ${this.placeTable.totalPlaces})`,
			);
		}
		return this.names(id);
	}

	/** FNV-1a 64-bit hash of the place table bytes, as defined by
	 * binary-format.md Section B.6. Used to bind a search index to its source. */
	placeTableChecksum(): bigint {
		if (this.cachedPlaceTableChecksum === undefined) {
			const { placeTableStart, placeTableLength } = this.directory;
			this.cachedPlaceTableChecksum = fnv1a64(
				this.source.readSync(placeTableStart, placeTableLength),
			);
		}
		return this.cachedPlaceTableChecksum;
	}

	/**
	 * Attaches a text search index (Appendix B, built by `buildSearchIndex`
	 * / `cgeodata build-search-index`) so `search()` only checks the cities
	 * the index says could match instead of every city. Results are
	 * identical with or without it -- only the speed differs.
	 *
	 * A reader opened from a path already picks up `<name>.search-index.bin`
	 * next to it (`searchIndexPathFor`) on the first search that needs it;
	 * call this to use a different index, or with `undefined` to search
	 * without one. Takes a path (read on demand, like the .bin itself), the
	 * file's bytes, or an open `SearchIndex` (which the caller keeps
	 * ownership of); throws if it was built from a different file.
	 */
	useSearchIndex(index: string | Uint8Array | SearchIndex | undefined): void {
		this.pendingSearchIndexPath = undefined;
		if (this.ownsSearchIndex) this.searchIndex?.close();
		this.searchIndex = undefined;
		this.ownsSearchIndex = false;
		if (index === undefined) return;

		const owned = !(index instanceof SearchIndex);
		const opened = index instanceof SearchIndex ? index : SearchIndex.open(index);
		try {
			this.checkSearchIndex(opened);
		} catch (error) {
			if (owned) opened.close();
			throw error;
		}
		this.searchIndex = opened;
		this.ownsSearchIndex = owned;
	}

	/** Whether `search()` will use an index. Opens (and validates) the
	 * `.search-index.bin` next to the file if that hasn't happened yet. */
	get hasSearchIndex(): boolean {
		return this.activeSearchIndex() !== undefined;
	}

	/** The attached search index, opening the one next to the file on
	 * first use. One that's there but unusable (stale, corrupt) throws on
	 * every call rather than silently falling back to a linear scan. */
	private activeSearchIndex(): SearchIndex | undefined {
		const path = this.pendingSearchIndexPath;
		if (path !== undefined) {
			if (!existsSync(path)) {
				this.pendingSearchIndexPath = undefined;
			} else {
				try {
					this.useSearchIndex(path);
				} catch (error) {
					this.pendingSearchIndexPath = path;
					throw new Error(
						`${path}: ${(error as Error).message} (or delete it to search without an index)`,
					);
				}
			}
		}
		return this.searchIndex;
	}

	private checkSearchIndex(index: SearchIndex): void {
		if (index.sourceChecksum !== this.placeTableChecksum()) {
			throw new Error(
				"search index was built from a different .bin file (checksum mismatch); rebuild it with build-search-index",
			);
		}
		if (index.placeCount !== this.placeTable.totalPlaces) {
			throw new Error(
				`search index covers ${index.placeCount} places, but this file has ${this.placeTable.totalPlaces}`,
			);
		}
	}

	/** Resolves one place id (Section 7.5) to its names and ancestors. */
	place(id: number): Place {
		const resolved = resolveIdentifier(this.placeTable, id);
		const C = this.placeTable.countryCount;
		const R = this.placeTable.totalRegions;
		const ref = (globalId: number): PlaceRef => ({
			id: globalId,
			names: this.names(globalId),
		});

		const country = ref(resolved.countryId);
		const region = "regionId" in resolved ? ref(C + resolved.regionId) : null;
		const city =
			resolved.level === "city" ? ref(C + R + resolved.cityId) : null;
		const self = city ?? region ?? country;
		return {
			id,
			names: self.names,
			level: resolved.level,
			country,
			region,
			city,
		};
	}

	/**
	 * Walks the place hierarchy in id order (countries, then regions, then
	 * cities), optionally restricted to one level and/or one ancestor. Each
	 * level's ids for a given parent are contiguous (Section 7.5), so a
	 * filtered walk only touches the ids it yields.
	 */
	*places(filter: PlaceFilter = {}): IterableIterator<Place> {
		for (const level of LEVELS) {
			if (filter.level !== undefined && filter.level !== level) continue;
			const [start, end] = this.idRange(level, filter);
			for (let id = start; id < end; id++) yield this.place(id);
		}
	}

	/**
	 * Case-insensitive substring match against every name of every place
	 * (all levels unless filtered). Without a search index this is a plain
	 * linear scan over the name blocks; with one (`useSearchIndex()`), only
	 * the places the index can't rule out are compared. Same results
	 * either way.
	 */
	*search(text: string, options: SearchOptions = {}): IterableIterator<Place> {
		if (options.sort) {
			yield* this.searchRanked(text, options);
			return;
		}
		const needle = text.toLowerCase();
		let remaining = options.limit ?? Infinity;
		if (remaining <= 0) return;
		const candidates = this.activeSearchIndex()?.candidates(text);
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, candidates)) {
				// Match on the bare names first; resolving parents is only worth
				// doing for the few that hit.
				if (!this.names(id).some((name) => name.toLowerCase().includes(needle)))
					continue;
				yield this.place(id);
				if (--remaining <= 0) return;
			}
		}
	}

	/** The `sort: true` path of `search()`: scores every match in relevance
	 * order (Appendix B.5, `relevance.ts`), then yields highest-scored
	 * first, ties broken by id. `limit` is applied after sorting, not
	 * during the scan -- the top match can turn up anywhere in id order. */
	private *searchRanked(
		text: string,
		options: SearchOptions,
	): IterableIterator<Place> {
		const needle = text.toLowerCase();
		const index = this.activeSearchIndex();
		const shortQuery =
			index !== undefined &&
			options.limit !== undefined &&
			options.limit <= index.topCount &&
			options.level === undefined &&
			options.country === undefined &&
			options.region === undefined
				? index.shortQuery(text)
				: undefined;
		if (shortQuery) {
			// The table already holds the answer (Appendix B.9 step 1); only
			// confirm each place really matches, so a corrupt table can't add
			// a wrong result.
			let remaining = options.limit ?? Infinity;
			for (const id of shortQuery) {
				if (remaining <= 0) return;
				if (!this.names(id).some((name) => name.toLowerCase().includes(needle)))
					continue;
				yield this.place(id);
				remaining--;
			}
			return;
		}

		const needleTokens = tokenize(needle);
		const candidates = index?.candidates(text);
		const scored: Array<{ id: number; score: number }> = [];
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, candidates)) {
				const quality = placeMatchQuality(this.names(id), needle, needleTokens);
				if (quality === 0) continue;
				scored.push({ id, score: quality + LEVEL_BONUS[level] });
			}
		}
		scored.sort((a, b) => b.score - a.score || a.id - b.id);

		let remaining = options.limit ?? Infinity;
		for (const { id } of scored) {
			if (remaining-- <= 0) return;
			yield this.place(id);
		}
	}

	/** The ids (ascending) of `level` under the filter that `search()` has
	 * to check: the whole `idRange`, or, when a search index narrowed the
	 * query to `candidates` (ascending), just those within it. */
	private *searchScope(
		level: PlaceLevel,
		filter: PlaceFilter,
		candidates: readonly number[] | undefined,
	): IterableIterator<number> {
		const [start, end] = this.idRange(level, filter);
		if (!candidates) {
			for (let id = start; id < end; id++) yield id;
			return;
		}
		for (let i = lowerBound(candidates, start); i < candidates.length; i++) {
			const id = candidates[i]!;
			if (id >= end) return;
			yield id;
		}
	}

	/** The parsed records of one chunk (Section 8), or undefined when the
	 * chunk is empty. Cached, like lookups. */
	chunk(index: number): ChunkRecords | undefined {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.directory.chunkLengths.length
		) {
			throw new RangeError(
				`chunk index ${index} is out of range for this file (0 <= index < ${this.directory.chunkLengths.length})`,
			);
		}
		return this.getChunk(index);
	}

	/** The lat/lon extent of a chunk (Section 6.1). */
	chunkBoundingBox(index: number): BoundingBox {
		const { width, height } = this.header;
		return chunkBoundingBox(
			index % width,
			Math.floor(index / width),
			width,
			height,
		);
	}

	/**
	 * Finds a representative lat/lon for a place id by scanning all chunks,
	 * using each chunk's palette to skip chunks that don't reference the id.
	 * Returns the centre of the largest bounding box assigned to this place,
	 * or null if the id has no geometry in the file.
	 */
	locate(id: number): { lat: number; lon: number; boundingBox: BoundingBox } | null {
		if (!Number.isInteger(id) || id < 0 || id >= this.placeTable.totalPlaces) {
			throw new RangeError(
				`${id} is not a place id for this file (0 <= id < ${this.placeTable.totalPlaces})`,
			);
		}
		let largestArea = -1;
		let bestBox: BoundingBox | null = null;
		const chunkCount = this.directory.chunkLengths.length;
		for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
			const chunk = this.getChunk(chunkIndex);
			if (!chunk) continue;
			const palettePos = chunk.palette.indexOf(id);
			if (palettePos === -1) continue;
			const targetIndex = palettePos + 1; // 1-based; 0 = "no place"
			const chunkBox = this.chunkBoundingBox(chunkIndex);
			for (let j = 0; j < chunk.codes.length; j++) {
				if (chunk.paletteIndices[j] !== targetIndex) continue;
				const box = this.recordBoundingBox(chunkBox, chunk.codes[j]!, chunk.depths[j]!);
				const area = (box.maxLat - box.minLat) * (box.maxLon - box.minLon);
				if (area > largestArea) {
					largestArea = area;
					bestBox = box;
				}
			}
		}
		if (!bestBox) return null;
		return {
			lat: (bestBox.minLat + bestBox.maxLat) / 2,
			lon: (bestBox.minLon + bestBox.maxLon) / 2,
			boundingBox: bestBox,
		};
	}

	/** One chunk's records with their cells and places resolved -- what a
	 * lookup in that chunk can answer with, laid out for inspection. */
	*chunkRecords(index: number): IterableIterator<ChunkRecord> {
		const chunk = this.chunk(index);
		if (!chunk) return;
		const chunkBox = this.chunkBoundingBox(index);
		for (let j = 0; j < chunk.codes.length; j++) {
			const code = chunk.codes[j]!;
			const depth = chunk.depths[j]!;
			const k = chunk.paletteIndices[j]!;
			yield {
				code,
				depth,
				boundingBox: this.recordBoundingBox(chunkBox, code, depth),
				place: k === 0 ? null : this.place(chunk.palette[k - 1]!),
			};
		}
	}

	private recordBoundingBox(
		chunkBox: BoundingBox,
		code: number,
		depth: number,
	): BoundingBox {
		const D = this.header.maxDepth;
		const { x: fullX, y: fullY } = mortonDecode(code, D);
		return cellBoundingBox(
			chunkBox,
			shiftRight(fullX, D - depth),
			shiftRight(fullY, D - depth),
			depth,
		);
	}

	/** The half-open global id range of `level` under the filter's
	 * narrowest ancestor, via the Section 7.5 prefix arrays. */
	private idRange(level: PlaceLevel, filter: PlaceFilter): [number, number] {
		const {
			countryCount: C,
			totalRegions: R,
			totalPlaces,
			regionCountryPrefix,
			cityRegionPrefix,
		} = this.placeTable;
		let { country } = filter;
		const { region } = filter;
		if (country !== undefined) checkId(country, 0, C, "country");
		if (region !== undefined) {
			checkId(region, C, C + R, "region");
			const owner = largestIndexWithPrefixAtMost(
				regionCountryPrefix,
				region - C,
			);
			if (country !== undefined && country !== owner) return [0, 0]; // region isn't in that country
			country = owner;
		}

		// Region-local index range under the narrowest ancestor, then the
		// level's own ids from there.
		const regionLo =
			region !== undefined
				? region - C
				: country !== undefined
					? regionCountryPrefix[country]!
					: 0;
		const regionHi =
			region !== undefined
				? region - C + 1
				: country !== undefined
					? regionCountryPrefix[country + 1]!
					: R;
		switch (level) {
			case "country":
				return country !== undefined ? [country, country + 1] : [0, C];
			case "region":
				return [C + regionLo, C + regionHi];
			case "city":
				return [
					Math.min(C + R + cityRegionPrefix[regionLo]!, totalPlaces),
					Math.min(C + R + cityRegionPrefix[regionHi]!, totalPlaces),
				];
		}
	}

	private getChunk(index: number): ChunkRecords | undefined {
		const length = this.directory.chunkLengths[index]!;
		if (length === 0) return undefined;
		const cached = this.chunkCache.get(index)?.deref();
		if (cached) return cached;
		const compressed = this.source.readSync(
			this.directory.chunkOffsets[index]!,
			length,
		);
		const inflated = safeInflate(compressed);
		const chunk = parseChunk(inflated, this.header.maxDepth);
		this.chunkCache.set(index, new WeakRef(chunk));
		return chunk;
	}

	private names(globalId: number): string[] {
		const { keyframeExp, totalPlaces } = this.placeTable;
		const blockSize = keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
		const blockIndex = Math.floor(globalId / blockSize);
		let block = this.nameBlockCache.get(blockIndex)?.deref();
		if (!block) {
			block = readNameBlock(this.source, this.placeTable, blockIndex);
			this.nameBlockCache.set(blockIndex, new WeakRef(block));
		}
		const entry = block[globalId - blockIndex * blockSize];
		if (!entry)
			throw new Error(
				`name block ${blockIndex} ended before reaching place ${globalId}`,
			);
		return entry;
	}
}

const LEVELS: readonly PlaceLevel[] = ["country", "region", "city"];

function checkId(id: number, lo: number, hi: number, what: string): void {
	if (!Number.isInteger(id) || id < lo || id >= hi) {
		throw new RangeError(
			`${id} is not a ${what} id for this file (${what} ids are ${lo} <= id < ${hi})`,
		);
	}
}

function unknownResult(
	boundingBox: BoundingBox,
	chunkIndex: number,
): QueryResult {
	return { country: null, region: null, city: null, boundingBox, chunkIndex };
}

/** The first index of the ascending `sorted` whose value is >= `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid]! < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** bisect_right(sorted, value) - 1, per Section 9 step 6. */
function bisectRightMinusOne(sorted: number[], value: number): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (sorted[mid]! <= value) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/** FNV-1a 64-bit hash per binary-format.md Section B.6.
 * offset_basis = 0xcbf29ce484222325, prime = 0x100000001b3.
 *
 * Done in two 32-bit halves rather than with BigInt, which costs ~100ms
 * on a world-sized place table: prime = 2^40 + 0x1b3, so
 * h * prime mod 2^64 = h * 0x1b3 + (lo << 40), and every intermediate
 * below stays under 2^53. */
function fnv1a64(data: Uint8Array): bigint {
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (let i = 0; i < data.length; i++) {
		lo ^= data[i]!;
		const loProduct = (lo >>> 0) * 0x1b3;
		hi = (hi * 0x1b3 + Math.floor(loProduct / 0x100000000) + ((lo << 8) >>> 0)) >>> 0;
		lo = loProduct >>> 0;
	}
	return (BigInt(hi) << 32n) | BigInt(lo);
}
