import { existsSync } from "node:fs";
import {
	type BoundingBox,
	cellBoundingBox,
	chunkBoundingBox,
} from "./cellBounds.ts";
import { type ChunkRecords, parseChunk } from "./chunk.ts";
import { readHeaderAndDirectory } from "./container.ts";
import type { CGeoDataDirectory } from "./directory.ts";
import { CGeoDataFormatError, CGeoDataIndexMismatchError } from "./errors.ts";
import type { CGeoDataHeader } from "./header.ts";
import {
	computeLocateCell,
	decodeLocateEntry,
	LocateIndex,
	locateEntryWidth,
	locateIndexPathFor,
} from "./locateIndex.ts";
import { mortonDecode, mortonEncode, shiftRight } from "./morton.ts";
import {
	largestIndexWithPrefixAtMost,
	type PlaceTableInfo,
	parsePlaceTable,
	readNameBlock,
	resolveIdentifier,
} from "./placeTable.ts";
import {
	foldDiacritics,
	LEVEL_BONUS,
	placeMatchQuality,
	prepareNeedle,
} from "./relevance.ts";
import { SearchIndex, searchIndexPathFor } from "./searchIndex.ts";
import { openSource, type RandomAccessSource } from "./source.ts";
import { safeInflate } from "./zlibUtil.ts";

/** `queryPlaceId()`'s result: where a point resolves, without names. */
export interface PlaceIdResult {
	/** The global id (Section 7.5) of the finest place resolved -- the city,
	 * else the region, else the country -- or null where nothing resolved.
	 * Two results with the same id have the same names, so a caller doing
	 * many lookups can key per-place work (a color, a label) on it instead
	 * of on the names. */
	placeId: number | null;
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

export interface QueryResult extends PlaceIdResult {
	country: string[] | null;
	region: string[] | null;
	city: string[] | null;
}

export type PlaceLevel = "country" | "region" | "city";

/** A place's global id (Section 7.5) and its name entry (Section 7.4). */
export interface PlaceRef {
	id: number;
	names: string[];
}

/** A place's level and the global ids of it and its ancestors, shaped
 * like `Place` without the names. */
export interface PlaceIds {
	level: PlaceLevel;
	country: number;
	region: number | null;
	city: number | null;
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
	/** Answers `locate()` without a chunk scan; see `useLocateIndex()`. */
	private locateIndex: LocateIndex | undefined;
	private ownsLocateIndex = false;
	/** A `.locate-index.bin` next to the file, still to be tried on the
	 * first `locate()`. */
	private pendingLocateIndexPath: string | undefined;
	private cachedPrefixChecksum: bigint | undefined;

	private readonly source: RandomAccessSource;
	readonly header: CGeoDataHeader;
	readonly directory: CGeoDataDirectory;
	private readonly placeTable: PlaceTableInfo;

	private constructor(
		source: RandomAccessSource,
		header: CGeoDataHeader,
		directory: CGeoDataDirectory,
		placeTable: PlaceTableInfo,
	) {
		this.source = source;
		this.header = header;
		this.directory = directory;
		this.placeTable = placeTable;
	}

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
			reader.pendingLocateIndexPath = locateIndexPathFor(input);
		}
		return reader;
	}

	close(): void {
		this.useSearchIndex(undefined);
		this.useLocateIndex(undefined);
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
		const result = this.queryPlaceId(lat, lon);
		if (result.placeId === null) {
			return { ...result, country: null, region: null, city: null };
		}
		const place = this.place(result.placeId);
		return {
			...result,
			country: place.country.names,
			region: place.region?.names ?? null,
			city: place.city?.names ?? null,
		};
	}

	/**
	 * `query()` without resolving the place's names: just its id, for a
	 * caller doing many lookups that resolves each distinct place once
	 * (with `place()`, `placeIds()` or `placeNames()`) rather than once per
	 * lookup, as a tile renderer sampling a grid of points does.
	 */
	queryPlaceId(lat: number, lon: number): PlaceIdResult {
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

		return {
			placeId: chunk.palette[k - 1]!,
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

	/** FNV-1a 64-bit hash of everything before the first chunk -- header,
	 * directory and place table -- as defined by binary-format.md Section
	 * C.4. Binds a locate index to its source: the chunk lengths it covers
	 * change whenever the chunks do. */
	prefixChecksum(): bigint {
		if (this.cachedPrefixChecksum === undefined) {
			const { placeTableStart, placeTableLength } = this.directory;
			this.cachedPrefixChecksum = fnv1a64(
				this.source.readSync(0, placeTableStart + placeTableLength),
			);
		}
		return this.cachedPrefixChecksum;
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
		const opened =
			index instanceof SearchIndex ? index : SearchIndex.open(index);
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
					throw withContext(
						error,
						`${path}: `,
						" (or delete it to search without an index)",
					);
				}
			}
		}
		return this.searchIndex;
	}

	private checkSearchIndex(index: SearchIndex): void {
		if (index.sourceChecksum !== this.placeTableChecksum()) {
			throw new CGeoDataIndexMismatchError(
				"search index was built from a different .bin file (checksum mismatch); rebuild it with build-search-index",
			);
		}
		if (index.placeCount !== this.placeTable.totalPlaces) {
			throw new CGeoDataIndexMismatchError(
				`search index covers ${index.placeCount} places, but this file has ${this.placeTable.totalPlaces}`,
			);
		}
	}

	/**
	 * Attaches a locate index (Appendix C, built by `buildLocateIndex` /
	 * `cgeodata build-locate-index`) so `locate()` reads one entry instead
	 * of scanning every chunk. Results are identical with or without it --
	 * only the speed differs.
	 *
	 * A reader opened from a path already picks up `<name>.locate-index.bin`
	 * next to it (`locateIndexPathFor`) on the first `locate()`; call this
	 * to use a different index, or with `undefined` to locate without one.
	 * Takes a path (read on demand, like the .bin itself), the file's bytes,
	 * or an open `LocateIndex` (which the caller keeps ownership of); throws
	 * if it was built from a different file.
	 */
	useLocateIndex(index: string | Uint8Array | LocateIndex | undefined): void {
		this.pendingLocateIndexPath = undefined;
		if (this.ownsLocateIndex) this.locateIndex?.close();
		this.locateIndex = undefined;
		this.ownsLocateIndex = false;
		if (index === undefined) return;

		const owned = !(index instanceof LocateIndex);
		const opened =
			index instanceof LocateIndex ? index : LocateIndex.open(index);
		try {
			this.checkLocateIndex(opened);
		} catch (error) {
			if (owned) opened.close();
			throw error;
		}
		this.locateIndex = opened;
		this.ownsLocateIndex = owned;
	}

	/** Whether `locate()` will use an index. Opens (and validates) the
	 * `.locate-index.bin` next to the file if that hasn't happened yet. */
	get hasLocateIndex(): boolean {
		return this.activeLocateIndex() !== undefined;
	}

	/** The attached locate index, opening the one next to the file on
	 * first use. One that's there but unusable (stale, corrupt) throws on
	 * every call rather than silently falling back to a chunk scan. */
	private activeLocateIndex(): LocateIndex | undefined {
		const path = this.pendingLocateIndexPath;
		if (path !== undefined) {
			if (!existsSync(path)) {
				this.pendingLocateIndexPath = undefined;
			} else {
				try {
					this.useLocateIndex(path);
				} catch (error) {
					this.pendingLocateIndexPath = path;
					throw withContext(
						error,
						`${path}: `,
						" (or delete it to locate without an index)",
					);
				}
			}
		}
		return this.locateIndex;
	}

	private checkLocateIndex(index: LocateIndex): void {
		if (index.sourceChecksum !== this.prefixChecksum()) {
			throw new CGeoDataIndexMismatchError(
				"locate index was built from a different .bin file (checksum mismatch); rebuild it with build-locate-index",
			);
		}
		const { totalPlaces } = this.placeTable;
		if (index.placeCount !== totalPlaces) {
			throw new CGeoDataIndexMismatchError(
				`locate index covers ${index.placeCount} places, but this file has ${totalPlaces}`,
			);
		}
		const expectedWidth = locateEntryWidth(this.header);
		if (index.entryWidth !== expectedWidth) {
			throw new CGeoDataIndexMismatchError(
				`locate index has ${index.entryWidth}-byte entries, but this file's grid needs ${expectedWidth}`,
			);
		}
	}

	/** Resolves one place id (Section 7.5) to its names and ancestors. */
	place(id: number): Place {
		const ids = this.placeIds(id);
		const ref = (globalId: number): PlaceRef => ({
			id: globalId,
			names: this.names(globalId),
		});
		const country = ref(ids.country);
		const region = ids.region === null ? null : ref(ids.region);
		const city = ids.city === null ? null : ref(ids.city);
		return {
			id,
			names: (city ?? region ?? country).names,
			level: ids.level,
			country,
			region,
			city,
		};
	}

	/** `place()` without the names: the place's level and the global ids
	 * of it and its ancestors, from the place table's counts alone, so no
	 * name block is read. */
	placeIds(id: number): PlaceIds {
		const resolved = resolveIdentifier(this.placeTable, id);
		const C = this.placeTable.countryCount;
		const R = this.placeTable.totalRegions;
		return {
			level: resolved.level,
			country: resolved.countryId,
			region: "regionId" in resolved ? C + resolved.regionId : null,
			city: resolved.level === "city" ? C + R + resolved.cityId : null,
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
	 * Diacritic- and case-insensitive substring match against every name of
	 * every place (all levels unless filtered) -- Section B.5's "matches":
	 * the folded form (`foldDiacritics`) of a name contains the folded form
	 * of the query. Without a search index this is a plain linear scan over
	 * the name blocks; with one (`useSearchIndex()`), only the places the
	 * index can't rule out are compared. Same results either way.
	 */
	*search(text: string, options: SearchOptions = {}): IterableIterator<Place> {
		if (options.sort) {
			yield* this.searchRanked(text, options);
			return;
		}
		const needle = foldDiacritics(text);
		let remaining = options.limit ?? Infinity;
		if (remaining <= 0) return;
		const candidates = this.activeSearchIndex()?.candidates(text);
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, candidates)) {
				// Match on the bare names first; resolving parents is only worth
				// doing for the few that hit.
				if (
					!this.names(id).some((name) => foldDiacritics(name).includes(needle))
				)
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
		const needle = foldDiacritics(text);
		const index = this.activeSearchIndex();
		// The table is keyed, and was scored, by each key's own folded form
		// (Section B.6) -- the same needle a live query would use only when
		// the query itself already equals its folded form, i.e. has no
		// diacritic of its own to fold away. A query that does (`ë`, say)
		// would need `nameMatchQuality`'s exact-spelling bonus evaluated
		// against ITS OWN raw spelling, not the plain, diacritic-free key
		// ("e") the table was built from -- those can legitimately disagree
		// (an accented query can give a different field its spelling bonus
		// than the plain key would). Falling back to the live scan for such
		// a query is the only way to keep index and no-index results equal.
		const shortQuery =
			index !== undefined &&
			options.limit !== undefined &&
			options.limit <= index.topCount &&
			options.level === undefined &&
			options.country === undefined &&
			options.region === undefined &&
			needle === text.toLowerCase()
				? index.shortQuery(text)
				: undefined;
		if (shortQuery) {
			// The table already holds the answer (Appendix B.9 step 1); only
			// confirm each place really matches, so a corrupt table can't add
			// a wrong result.
			let remaining = options.limit ?? Infinity;
			for (const id of shortQuery) {
				if (remaining <= 0) return;
				if (
					!this.names(id).some((name) => foldDiacritics(name).includes(needle))
				)
					continue;
				yield this.place(id);
				remaining--;
			}
			return;
		}

		const parsedNeedle = prepareNeedle(text);
		const candidates = index?.candidates(text);
		const scored: Array<{ id: number; score: number }> = [];
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, candidates)) {
				const quality = placeMatchQuality(this.names(id), parsedNeedle);
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
	 * chunk is empty. Cached, like lookups, unless `cache` is false -- a
	 * cached chunk stays alive at least until the current synchronous job
	 * ends (WeakRef semantics), so a one-pass walk over every chunk should
	 * skip the cache to keep memory flat. */
	chunk(
		index: number,
		{ cache = true }: { cache?: boolean } = {},
	): ChunkRecords | undefined {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.directory.chunkLengths.length
		) {
			throw new RangeError(
				`chunk index ${index} is out of range for this file (0 <= index < ${this.directory.chunkLengths.length})`,
			);
		}
		return this.getChunk(index, cache);
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
	 * A representative lat/lon for a place id: the centre of the place's
	 * representative cell (binary-format.md Section C.3), a cell near the
	 * middle of the place's area -- its own cells plus those of every place
	 * under it -- that is guaranteed to lie in that area, so `query()` at
	 * the returned point resolves to the place or one of its descendants.
	 * Null if neither the place nor anything under it has any cells.
	 *
	 * With a locate index (`useLocateIndex()`) this reads one entry;
	 * without one it scans every chunk. Same result either way.
	 */
	locate(
		id: number,
	): { lat: number; lon: number; boundingBox: BoundingBox } | null {
		if (!Number.isInteger(id) || id < 0 || id >= this.placeTable.totalPlaces) {
			throw new RangeError(
				`${id} is not a place id for this file (0 <= id < ${this.placeTable.totalPlaces})`,
			);
		}
		const index = this.activeLocateIndex();
		const cell = index
			? decodeLocateEntry(index.entry(id), this.header)
			: computeLocateCell(this, id);
		if (!cell) return null;
		const box = this.recordBoundingBox(
			this.chunkBoundingBox(cell.chunkIndex),
			cell.code,
			cell.depth,
		);
		return {
			lat: (box.minLat + box.maxLat) / 2,
			lon: (box.minLon + box.maxLon) / 2,
			boundingBox: box,
		};
	}

	/**
	 * The ids of place `id` and of every place under it, as half-open
	 * ranges: `[id, id + 1]` first, then for a country its regions and
	 * their cities, for a region its cities. Each level's children are
	 * contiguous (Section 7.1), so this is at most three ranges.
	 */
	subtreeIdRanges(id: number): Array<[number, number]> {
		const resolved = resolveIdentifier(this.placeTable, id);
		const ranges: Array<[number, number]> = [[id, id + 1]];
		if (resolved.level === "country") {
			ranges.push(this.idRange("region", { country: id }));
			ranges.push(this.idRange("city", { country: id }));
		} else if (resolved.level === "region") {
			ranges.push(this.idRange("city", { region: id }));
		}
		return ranges;
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

	private getChunk(index: number, cache = true): ChunkRecords | undefined {
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
		// Section 11: "every palette entry [MUST be] less than N".
		// `parseChunk` can't check that -- it has no place table -- and this
		// is the one place that has both, so a corrupt palette fails here
		// with a format error naming the chunk, instead of surfacing much
		// later as an out-of-range place id (`chunkRecords`) or as a bare
		// TypeError on an undefined lookup (`buildLocateIndex`'s
		// `countryOf[placeId]`).
		const { totalPlaces } = this.placeTable;
		for (const placeId of chunk.palette) {
			if (placeId >= totalPlaces) {
				throw new CGeoDataFormatError(
					`chunk ${index}'s palette references place ${placeId}, beyond this file's ${totalPlaces} places`,
				);
			}
		}
		if (cache) this.chunkCache.set(index, new WeakRef(chunk));
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
			throw new CGeoDataFormatError(
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

/** `error` with `prefix` and `suffix` added to its message, keeping its
 * class -- so a stale index next to the file still throws a
 * `CGeoDataIndexMismatchError`, and says which file it was. */
function withContext(error: unknown, prefix: string, suffix: string): unknown {
	if (!(error instanceof Error)) return error;
	const message = `${prefix}${error.message}${suffix}`;
	if (error.stack) error.stack = error.stack.replace(error.message, message);
	error.message = message;
	return error;
}

function unknownResult(
	boundingBox: BoundingBox,
	chunkIndex: number,
): PlaceIdResult {
	return { placeId: null, boundingBox, chunkIndex };
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
function bisectRightMinusOne(sorted: ArrayLike<number>, value: number): number {
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
		hi =
			(hi * 0x1b3 + Math.floor(loProduct / 0x100000000) + ((lo << 8) >>> 0)) >>>
			0;
		lo = loProduct >>> 0;
	}
	return (BigInt(hi) << 32n) | BigInt(lo);
}
