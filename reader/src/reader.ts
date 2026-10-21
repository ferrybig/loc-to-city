import { ByteBudgetCache } from "./cache.ts";
import {
	type BoundingBox,
	cellBoundingBox,
	chunkBoundingBox,
} from "./cellBounds.ts";
import { type ChunkRecords, MAX_SUPPORTED_DEPTH, parseChunk } from "./chunk.ts";
import { readHeaderAndDirectory } from "./container.ts";
import type { CGeoDataDirectory } from "./directory.ts";
import {
	CGeoDataError,
	CGeoDataFormatError,
	CGeoDataIndexMismatchError,
	CGeoDataUnsupportedError,
} from "./errors.ts";
import type { CGeoDataHeader } from "./header.ts";
import { type Inflater, inflateBlock, streamInflater } from "./inflate.ts";
import {
	computeLocateCell,
	decodeLocateEntry,
	LocateIndex,
	locateEntryWidth,
	type PlaceLocation,
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
	compareAreaRelevance,
	compareRelevance,
	contextQuality,
	foldDiacritics,
	type Needle,
	parseQualifiedQuery,
	placeMatchQuality,
	prepareNeedle,
	type RankedMatch,
	regionRankArea,
} from "./relevance.ts";
import { RELEVANCE_AREA, RELEVANCE_PLAIN, SearchIndex } from "./searchIndex.ts";
import { type ByteSource, type SourceInput, toSource } from "./source.ts";
import { TurnQueue } from "./turns.ts";

/** `lookup()`'s result: where a point resolves, without names. */
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

/** `query()`'s result: `lookup()`'s, with the place and its ancestors
 * named. A level that doesn't apply is null: `city` for a point resolved
 * only to a region, all three where nothing resolved. */
export interface QueryResult extends PlaceIdResult {
	/** The country the point lies in. */
	country: PlaceRef | null;
	/** The region (province, state, ...) the point lies in. */
	region: PlaceRef | null;
	/** The city -- or whatever finest division the country has; see the
	 * README -- the point lies in. */
	city: PlaceRef | null;
}

/** The three tiers of the place hierarchy (Section 7.1). */
export type PlaceLevel = "country" | "region" | "city";

/** A place's global id (Section 7.5) and its name entry (Section 7.4). */
export interface PlaceRef {
	/** The place's global id (Section 7.5): what `place()`, `placeIds()`
	 * and `locate()` take. Stable within one file, not between builds. */
	id: number;
	/**
	 * The place's name in its own language and script, as people there
	 * write it: "東京都", "Den Haag". Field 0 of its name entry, never
	 * empty.
	 */
	localName: string;
	/**
	 * The place's international (English) name -- "Tokyo", "The Hague" --
	 * or `localName` where it has none, which is also the case for a place
	 * whose names are the same. Field 1 of its name entry. Pick this one
	 * when a name is shown to everyone regardless of their language, or
	 * stored once for all of them.
	 */
	internationalName: string;
	/**
	 * Every name, in name-entry order (Section 7.4): `localName`, then the
	 * international name (`""` where it has none but alternatives follow),
	 * then alternative names and spellings ("'s-Gravenhage"). For search
	 * and for showing alternatives; to display one name, use `localName`
	 * or `internationalName` rather than indexing into this.
	 */
	names: string[];
}

/** A place's level and the global ids of it and its ancestors, shaped
 * like `Place` without the names. */
export interface PlaceIds {
	/** The place's own level. */
	level: PlaceLevel;
	/** Id of its country (the place itself, for a country). */
	country: number;
	/** Id of its region (the place itself, for a region); null for a
	 * country. */
	region: number | null;
	/** The place's own id for a city; null otherwise. */
	city: number | null;
}

/**
 * One entry of the place hierarchy with its ancestors resolved. Shaped
 * like QueryResult's country/region/city trio so the two are easy to
 * relate: a country has `region` and `city` null, a region has `city`
 * null and `region` pointing at itself, a city has all three set.
 */
export interface Place extends PlaceRef {
	/** The place's own level. */
	level: PlaceLevel;
	/** Its country (itself, for a country). */
	country: PlaceRef;
	/** Its region (itself, for a region); null for a country. */
	region: PlaceRef | null;
	/** Itself, for a city; null otherwise. */
	city: PlaceRef | null;
}

/** Narrows `places()` and `search()`. Filters combine: `{ level: "city",
 * country }` is that country's cities. */
export interface PlaceFilter {
	/** Only places of this level. */
	level?: PlaceLevel;
	/** Only places inside this country (by id); the country itself included. */
	country?: number;
	/** Only places inside this region (by id); the region itself included. */
	region?: number;
}

/** Options for `search()`. */
export interface SearchOptions extends PlaceFilter {
	/** Stop after this many matches. */
	limit?: number;
	/**
	 * Rank matches by relevance instead of id order (Appendix B.5): an
	 * exact name match outranks a match on a whole word of the name, which
	 * outranks a plain substring match, each tier further split by whether
	 * the query's own spelling (not just its folded form) matched; among
	 * equal matches, a country outranks a city, which outranks a region. `limit` still applies,
	 * but to the top of the ranked list rather than the first N found in
	 * id order -- so with `sort` the whole match set has to be scored
	 * before anything is yielded, since the best match isn't necessarily
	 * the first one found.
	 */
	sort?: boolean;
	/**
	 * With `sort`, whether to break ties by area (Appendix B.5.1): among
	 * equally good matches, larger places first, so "berlin" puts Berlin,
	 * Germany ahead of the many small Berlins in the United States, while a
	 * province still follows its own same-named city. Areas come from a
	 * locate index (`useLocateIndex()`):
	 *
	 * - `"auto"` (the default): by area when a locate index is attached,
	 *   otherwise by Appendix B.5's plain order. Unlike everything else an
	 *   index does, attaching one therefore changes the order of results
	 *   (never which places match).
	 * - `true`: by area; rejects without a locate index.
	 * - `false`: Appendix B.5's plain order, index or not.
	 */
	areaTieBreak?: "auto" | boolean;
}

/** One record of a chunk (Section 8.2) with its cell and place resolved. */
export interface ChunkRecord {
	/** The record's stored Morton code within its chunk (Section 8.1). */
	code: number;
	/** The record's depth in the chunk's quadtree (0 = the whole chunk). */
	depth: number;
	/** The cell the record covers. */
	boundingBox: BoundingBox;
	/** null for a "no place" record (palette index 0). */
	place: Place | null;
}

/** How many places of each level a file has. */
export interface PlaceCounts {
	/** Number of countries; their ids are `0 .. countries - 1`. */
	countries: number;
	/** Number of regions; their ids follow the countries'. */
	regions: number;
	/** Number of cities; their ids follow the regions'. */
	cities: number;
}

/** `locate()`'s result: a point inside a place, and the cell it's the
 * centre of. */
export interface Location {
	/** Latitude of the centre of `boundingBox`. */
	lat: number;
	/** Longitude of the centre of `boundingBox`. */
	lon: number;
	/** The place's representative cell (Section C.3). */
	boundingBox: BoundingBox;
	/**
	 * Roughly how large the place is, everything under it included, in
	 * square degrees -- from its area byte (Section C.3), so within about
	 * 9% either way. Useful for zooming a map to it: a square of this area
	 * is `sqrt(area)` degrees on a side, which a Web Mercator map shows
	 * across one 256-pixel tile at zoom `log2(360 / sqrt(area))`.
	 */
	area: number;
}

/**
 * A sidecar index for `OpenOptions`: the index itself (an open one stays
 * the caller's to close), its file as a source, or a function that finds
 * it on first use and resolves to undefined when there is none.
 */
export type IndexOption<I> =
	| I
	| SourceInput
	| (() => Promise<I | SourceInput | undefined>);

/** Options for `CGeoDataReader.open()`. */
export interface OpenOptions {
	/**
	 * Memory budget, in bytes, for decoded chunks and name blocks; least
	 * recently used ones are dropped past it. Default 64 MiB. A worldwide
	 * file decodes to about 1 GB in all, its largest chunk to about 3 MB,
	 * so a budget much below that makes lookups scattered across the
	 * world re-decode often. 0 disables caching, except for the one most
	 * recently used chunk.
	 */
	cacheBytes?: number;
	/** How compressed blocks are inflated. Default `streamInflater`, which
	 * works everywhere; on Node.js, `nodeInflater` from `./node` is
	 * several times faster. */
	inflater?: Inflater;
	/** A search index (Appendix B) for `search()`; see `useSearchIndex()`.
	 * Not read until the first search that can use it. */
	searchIndex?: IndexOption<SearchIndex>;
	/** A locate index (Appendix C) for `locate()`; see `useLocateIndex()`.
	 * Not read until the first `locate()`. */
	locateIndex?: IndexOption<LocateIndex>;
}

/** `OpenOptions.cacheBytes` when not given. */
export const DEFAULT_CACHE_BYTES = 64 * 2 ** 20;

/** A sidecar index slot: what's attached, and what's still to be tried. */
interface IndexSlot<I> {
	index: I | undefined;
	/** Whether `index` was opened here, and so is closed here. */
	owned: boolean;
	/** Finds the index on first use; see `IndexOption`. */
	pending: (() => Promise<I | SourceInput | undefined>) | undefined;
	/** The attempt to use `pending` in progress, shared by everything that
	 * needs the index meanwhile -- two attempts at once would each open it,
	 * and the second would close the first's while it's being read. */
	activating: Promise<I | undefined> | undefined;
}

/**
 * A CGEODATA file opened for reading: answers which country, region and
 * city a point lies in (`query`, `lookup`), what a place is called and
 * where it sits in the hierarchy (`place`, `placeIds`), which places
 * match a name (`search`), and where a place is (`locate`).
 *
 * Opening reads only the header, directory and place counts; each lookup
 * reads and decodes the one chunk its point lies in, which then stays
 * cached (`OpenOptions.cacheBytes`).
 *
 * @example
 * ```ts
 * // Node.js
 * import { openFile } from "@ferrybig/cgeodata-reader/node";
 * const reader = await openFile("world.bin");
 *
 * // Anywhere else
 * import { CGeoDataReader } from "@ferrybig/cgeodata-reader";
 * const reader = await CGeoDataReader.open(await (await fetch(url)).arrayBuffer());
 *
 * const { city, region, country } = await reader.query(52.0799, 4.3113);
 * city?.internationalName; // "The Hague"
 * ```
 */
export class CGeoDataReader {
	/** Decoded chunks (keyed by chunk index) and name blocks (keyed by
	 * `-1 - blockIndex`) under one byte budget. */
	private readonly cache: ByteBudgetCache<ChunkRecords | string[][]>;
	/** Loads in flight, under the same keys as `cache`, so concurrent
	 * lookups in one chunk decode it once. */
	private readonly loading = new Map<
		number,
		Promise<ChunkRecords | string[][]>
	>();
	/** The chunk the last lookup used, held outside `cache`: lookups close
	 * together (a tile's samples) mostly land in the same chunk, and this
	 * answers those without touching the LRU's bookkeeping. */
	private lastChunkIndex = -1;
	private lastChunk: ChunkRecords | undefined;
	/** Decodes take turns, one per macrotask; see `TurnQueue`. */
	private readonly decodes = new TurnQueue();
	/** The full-precision cell of the point `gridCell()` last placed; read
	 * right after, in the same synchronous run. */
	private gx = 0;
	private gy = 0;
	private readonly search_: IndexSlot<SearchIndex>;
	private readonly locate_: IndexSlot<LocateIndex>;
	/** Rank areas of the regions searches have matched so far (Appendix
	 * B.5.1), -1 where not yet known, for the area bytes they came from. */
	private rankAreas: { areas: Uint8Array; regions: Int16Array } | undefined;
	private placeTableChecksumPromise: Promise<bigint> | undefined;
	private prefixChecksumPromise: Promise<bigint> | undefined;

	private readonly source: ByteSource;
	private readonly inflater: Inflater;
	/** The file's header (Section 5), including its `attribution`. */
	readonly header: CGeoDataHeader;
	/** The file's directory (Section 6): where each chunk is. */
	readonly directory: CGeoDataDirectory;
	private readonly placeTable: PlaceTableInfo;

	private constructor(
		source: ByteSource,
		header: CGeoDataHeader,
		directory: CGeoDataDirectory,
		placeTable: PlaceTableInfo,
		cacheBytes: number,
		options: OpenOptions,
	) {
		this.cache = new ByteBudgetCache(cacheBytes);
		this.source = source;
		this.inflater = options.inflater ?? streamInflater;
		this.header = header;
		this.directory = directory;
		this.placeTable = placeTable;
		this.search_ = pendingSlot(options.searchIndex);
		this.locate_ = pendingSlot(options.locateIndex);
	}

	/**
	 * Opens a CGEODATA file: reads and validates its header, directory and
	 * the uncompressed part of its place table (Sections 5-7.2), and
	 * nothing else -- chunks and names are read on first use. The reader
	 * takes ownership of `input`, if it's a `ByteSource`: `close()` closes
	 * it, as does a failed open.
	 */
	static async open(
		input: SourceInput,
		options: OpenOptions = {},
	): Promise<CGeoDataReader> {
		const { cacheBytes = DEFAULT_CACHE_BYTES } = options;
		if (!(cacheBytes >= 0)) {
			throw new RangeError(
				`cacheBytes must be a non-negative number, not ${cacheBytes}`,
			);
		}
		const source = toSource(input);
		try {
			const { header, directory } = await readHeaderAndDirectory(source);
			if (header.maxDepth > MAX_SUPPORTED_DEPTH) {
				throw new CGeoDataUnsupportedError(
					`max_depth ${header.maxDepth} is past the ${MAX_SUPPORTED_DEPTH} this reader supports: rebuild the file with a bigger chunk grid instead`,
				);
			}
			const placeTable = await parsePlaceTable(
				source,
				directory.placeTableStart,
				directory.placeTableLength,
				header.keyframeExp,
			);
			return new CGeoDataReader(
				source,
				header,
				directory,
				placeTable,
				cacheBytes,
				options,
			);
		} catch (error) {
			await source.close?.();
			throw error;
		}
	}

	/** Closes the source, and any index this reader opened itself. */
	async close(): Promise<void> {
		await this.useSearchIndex(undefined);
		await this.useLocateIndex(undefined);
		this.cache.clear();
		this.lastChunk = undefined;
		this.lastChunkIndex = -1;
		await this.source.close?.();
	}

	/** How many countries, regions and cities the file has. */
	get placeCounts(): PlaceCounts {
		const { countryCount, totalRegions, totalCities } = this.placeTable;
		return {
			countries: countryCount,
			regions: totalRegions,
			cities: totalCities,
		};
	}

	/**
	 * The country, region and city a point lies in: Section 9's lookup
	 * procedure (`lookup()`) with the names resolved (`place()`). Rejects
	 * with a `RangeError` for a latitude outside [-90, 90) or a longitude
	 * outside [-180, 180).
	 *
	 * @example
	 * ```ts
	 * const result = await reader.query(35.6762, 139.6503);
	 * result.city?.localName;         // "杉並区"
	 * result.city?.internationalName; // "Suginami"
	 * result.country?.internationalName; // "Japan"
	 * ```
	 */
	async query(lat: number, lon: number): Promise<QueryResult> {
		const result = await this.lookup(lat, lon);
		if (result.placeId === null) {
			return { ...result, country: null, region: null, city: null };
		}
		const { country, region, city } = await this.place(result.placeId);
		return { ...result, country, region, city };
	}

	/**
	 * Section 9's lookup procedure: the place a point lies in, as an id, and
	 * the cell the answer holds for. Reads and decodes the point's chunk if
	 * it isn't cached; resolve the id with `place()` or `placeIds()`.
	 */
	async lookup(lat: number, lon: number): Promise<PlaceIdResult> {
		const chunkIndex = this.gridCell(lat, lon);
		let chunk = this.loadedChunk(chunkIndex);
		if (chunk === undefined) {
			chunk = await this.loadChunk(chunkIndex, true);
			this.gridCell(lat, lon); // another lookup may have run meanwhile
		}
		return this.resolve(chunkIndex, chunk);
	}

	/**
	 * `lookup()` answered from memory only: the same result when the
	 * point's chunk is already decoded, undefined when answering would
	 * need a read. For callers doing many lookups close together, which
	 * mostly hit the same few chunks:
	 *
	 * ```ts
	 * const result = reader.lookupCached(lat, lon) ?? (await reader.lookup(lat, lon));
	 * ```
	 *
	 * waits only for the lookups that actually read something.
	 */
	lookupCached(lat: number, lon: number): PlaceIdResult | undefined {
		const chunkIndex = this.gridCell(lat, lon);
		const chunk = this.loadedChunk(chunkIndex);
		return chunk === undefined ? undefined : this.resolve(chunkIndex, chunk);
	}

	/** The index of the chunk a point lies in (Section 6.1). */
	chunkIndexAt(lat: number, lon: number): number {
		return this.gridCell(lat, lon);
	}

	/** Validates a point and places it on the full-precision grid
	 * (`this.gx`, `this.gy`), returning its chunk's index. */
	private gridCell(lat: number, lon: number): number {
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
		const gx = Math.floor(((lon + 180) / 360) * NX);
		const gy = Math.floor(((lat + 90) / 180) * NY);
		this.gx = Math.min(Math.max(gx, 0), NX - 1);
		this.gy = Math.min(Math.max(gy, 0), NY - 1);
		return Math.floor(this.gy / 2 ** D) * W + Math.floor(this.gx / 2 ** D);
	}

	/** Section 9 steps 5-8 for the point `gridCell()` just placed, in its
	 * (decoded, or null for empty) chunk. */
	private resolve(
		chunkIndex: number,
		chunk: ChunkRecords | null,
	): PlaceIdResult {
		const { width: W, height: H, maxDepth: D } = this.header;
		const cellsPerChunkSide = 2 ** D;
		const c = chunkIndex % W;
		const r = Math.floor(chunkIndex / W);
		const x = this.gx - c * cellsPerChunkSide;
		const y = this.gy - r * cellsPerChunkSide;
		const chunkBox = chunkBoundingBox(c, r, W, H);
		if (!chunk) return unknownResult(chunkBox, chunkIndex); // whole chunk is empty

		const q = mortonEncode(x, y, D);
		const j = bisectRightMinusOne(chunk.codes, q);
		// Neither of these two "no record covers this" cases can recover the
		// gap's true extent without redoing the encoder's own subdivision
		// work, so fall back to the single finest cell around the query point.
		if (j < 0)
			return unknownResult(cellBoundingBox(chunkBox, x, y, D), chunkIndex);

		const depth = chunk.depths[j]!;
		const shift = 2 * (D - depth);
		const code = chunk.codes[j]!;
		if (shiftRight(q, shift) !== shiftRight(code, shift)) {
			// gap between records
			return unknownResult(cellBoundingBox(chunkBox, x, y, D), chunkIndex);
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
	 * Cheaper than `place()` when only the names are needed. */
	async placeNames(id: number): Promise<string[]> {
		this.checkPlaceId(id);
		return this.loadedNames(id) ?? (await this.loadNames(id));
	}

	/** FNV-1a 64-bit hash of the place table bytes, as defined by
	 * binary-format.md Section B.6. Used to bind a search index to its source. */
	placeTableChecksum(): Promise<bigint> {
		this.placeTableChecksumPromise ??= (async () => {
			const { placeTableStart, placeTableLength } = this.directory;
			return fnv1a64(await this.source.read(placeTableStart, placeTableLength));
		})();
		return this.placeTableChecksumPromise;
	}

	/** FNV-1a 64-bit hash of everything before the first chunk -- header,
	 * directory and place table -- as defined by binary-format.md Section
	 * C.4. Binds a locate index to its source: the chunk lengths it covers
	 * change whenever the chunks do. */
	prefixChecksum(): Promise<bigint> {
		this.prefixChecksumPromise ??= (async () => {
			const { placeTableStart, placeTableLength } = this.directory;
			return fnv1a64(
				await this.source.read(0, placeTableStart + placeTableLength),
			);
		})();
		return this.prefixChecksumPromise;
	}

	/**
	 * Attaches a text search index (Appendix B, built by `buildSearchIndex`
	 * / `cgeodata build-search-index`) so `search()` only checks the places
	 * the index says could match instead of every place. Results are
	 * identical with or without it -- only the speed differs.
	 *
	 * Takes the index's file (as for `open()`; read on demand) or an open
	 * `SearchIndex` (which the caller keeps ownership of), or undefined to
	 * search without one. Replaces `OpenOptions.searchIndex`. Rejects with
	 * a `CGeoDataIndexMismatchError` if it was built from a different file.
	 */
	async useSearchIndex(
		index: SearchIndex | SourceInput | undefined,
	): Promise<void> {
		await this.attach(this.search_, index, SearchIndex.open, (opened) =>
			this.checkSearchIndex(opened),
		);
	}

	/** Whether `search()` will use an index. Reads (and validates) the one
	 * from `OpenOptions.searchIndex` if that hasn't happened yet. */
	async hasSearchIndex(): Promise<boolean> {
		return (await this.activeSearchIndex()) !== undefined;
	}

	/** The attached search index, opening `OpenOptions.searchIndex` on
	 * first use. One that's there but unusable (stale, corrupt) rejects on
	 * every call rather than silently falling back to a linear scan. */
	private activeSearchIndex(): Promise<SearchIndex | undefined> {
		return this.activate(this.search_, "search", (index) =>
			this.useSearchIndex(index),
		);
	}

	private async checkSearchIndex(index: SearchIndex): Promise<void> {
		// An index ranked by area depends on the chunks too (Section B.8).
		const checksum =
			index.relevanceRule === RELEVANCE_AREA
				? await this.prefixChecksum()
				: await this.placeTableChecksum();
		if (index.sourceChecksum !== checksum) {
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
	 * only the speed differs -- except that its areas also let a sorted
	 * `search()` rank equal matches by size (`SearchOptions.areaTieBreak`).
	 *
	 * Takes the index's file (as for `open()`; read on demand) or an open
	 * `LocateIndex` (which the caller keeps ownership of), or undefined to
	 * locate without one. Replaces `OpenOptions.locateIndex`. Rejects with
	 * a `CGeoDataIndexMismatchError` if it was built from a different file.
	 */
	async useLocateIndex(
		index: LocateIndex | SourceInput | undefined,
	): Promise<void> {
		await this.attach(this.locate_, index, LocateIndex.open, (opened) =>
			this.checkLocateIndex(opened),
		);
	}

	/** Whether `locate()` will use an index. Reads (and validates) the one
	 * from `OpenOptions.locateIndex` if that hasn't happened yet. */
	async hasLocateIndex(): Promise<boolean> {
		return (await this.activeLocateIndex()) !== undefined;
	}

	/** The attached locate index, opening `OpenOptions.locateIndex` on
	 * first use. One that's there but unusable (stale, corrupt) rejects on
	 * every call rather than silently falling back to a chunk scan. */
	private activeLocateIndex(): Promise<LocateIndex | undefined> {
		return this.activate(this.locate_, "locate", (index) =>
			this.useLocateIndex(index),
		);
	}

	private async checkLocateIndex(index: LocateIndex): Promise<void> {
		if (index.sourceChecksum !== (await this.prefixChecksum())) {
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

	/** `useSearchIndex`/`useLocateIndex`, for either slot. */
	private async attach<I extends SearchIndex | LocateIndex>(
		slot: IndexSlot<I>,
		index: I | SourceInput | undefined,
		open: (input: SourceInput) => Promise<I>,
		check: (index: I) => Promise<void>,
	): Promise<void> {
		slot.pending = undefined;
		if (slot.owned) await slot.index?.close();
		slot.index = undefined;
		slot.owned = false;
		if (index === undefined) return;

		const owned = !(
			index instanceof SearchIndex || index instanceof LocateIndex
		);
		const opened = owned ? await open(index as SourceInput) : (index as I);
		try {
			await check(opened);
		} catch (error) {
			if (owned) await opened.close();
			throw error;
		}
		slot.index = opened;
		slot.owned = owned;
	}

	/** The slot's index, trying its pending one first. */
	private activate<I extends SearchIndex | LocateIndex>(
		slot: IndexSlot<I>,
		what: "search" | "locate",
		use: (index: I | SourceInput) => Promise<void>,
	): Promise<I | undefined> {
		if (slot.pending === undefined) return Promise.resolve(slot.index);
		slot.activating ??= this.tryPending(slot, what, use).finally(() => {
			slot.activating = undefined;
		});
		return slot.activating;
	}

	private async tryPending<I extends SearchIndex | LocateIndex>(
		slot: IndexSlot<I>,
		what: "search" | "locate",
		use: (index: I | SourceInput) => Promise<void>,
	): Promise<I | undefined> {
		const pending = slot.pending!;
		let input: I | SourceInput | undefined;
		try {
			input = await pending();
			if (input === undefined) slot.pending = undefined;
			else await use(input);
		} catch (error) {
			slot.pending = pending; // `use` cleared it; try again next time
			const name = indexName(input);
			throw name === undefined
				? error
				: withContext(
						error,
						`${name}: `,
						` (or delete it to ${what} without an index)`,
					);
		}
		return slot.index;
	}

	/** Resolves one place id (Section 7.5) to its names and ancestors. */
	async place(id: number): Promise<Place> {
		const loaded = this.loadedPlace(id);
		if (loaded) return loaded;
		const ids = this.placeIds(id);
		await Promise.all(
			[ids.country, ids.region, ids.city].map((globalId) =>
				globalId === null || this.loadedNames(globalId)
					? undefined
					: this.loadNames(globalId),
			),
		);
		// Loaded, though not necessarily still cached: rebuild from the
		// blocks if the budget already let one go.
		return this.loadedPlace(id) ?? this.placeFrom(ids, id);
	}

	/** `place()` when every name it needs is cached, else undefined. */
	private loadedPlace(id: number): Place | undefined {
		const ids = this.placeIds(id);
		const country = this.loadedNames(ids.country);
		if (!country) return undefined;
		let region: string[] | undefined;
		if (ids.region !== null) {
			region = this.loadedNames(ids.region);
			if (!region) return undefined;
		}
		let city: string[] | undefined;
		if (ids.city !== null) {
			city = this.loadedNames(ids.city);
			if (!city) return undefined;
		}
		return assemblePlace(id, ids, country, region, city);
	}

	/** `place()` loading each name block in turn, for when the cache is
	 * too small to hold them all at once. */
	private async placeFrom(ids: PlaceIds, id: number): Promise<Place> {
		const country = await this.loadNames(ids.country);
		const region =
			ids.region === null ? undefined : await this.loadNames(ids.region);
		const city = ids.city === null ? undefined : await this.loadNames(ids.city);
		return assemblePlace(id, ids, country, region, city);
	}

	/** `place()` without the names: the place's level and the global ids
	 * of it and its ancestors, from the place table's counts alone, so no
	 * name block is read -- and so synchronous. */
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

	/** How many places sit directly under `id`: a country's regions, a
	 * region's cities, always 0 for a city. From the place table's counts
	 * alone, like `placeIds()`, so no name block is read and it is
	 * synchronous: `childCount(region) === 0` finds a region with no city
	 * mapped to it. */
	childCount(id: number): number {
		this.checkPlaceId(id);
		const { countryCount: C, totalRegions: R } = this.placeTable;
		const { regionCountryPrefix, cityRegionPrefix } = this.placeTable;
		if (id < C) return regionCountryPrefix[id + 1]! - regionCountryPrefix[id]!;
		if (id < C + R) {
			const region = id - C;
			return cityRegionPrefix[region + 1]! - cityRegionPrefix[region]!;
		}
		return 0;
	}

	/**
	 * Walks the place hierarchy in id order (countries, then regions, then
	 * cities), optionally restricted to one level and/or one ancestor. Each
	 * level's ids for a given parent are contiguous (Section 7.5), so a
	 * filtered walk only touches the ids it yields.
	 */
	async *places(filter: PlaceFilter = {}): AsyncIterableIterator<Place> {
		for (const level of LEVELS) {
			if (filter.level !== undefined && filter.level !== level) continue;
			const [start, end] = this.idRange(level, filter);
			for (let id = start; id < end; id++)
				yield this.loadedPlace(id) ?? (await this.place(id));
		}
	}

	/**
	 * Diacritic- and case-insensitive substring match against every name of
	 * every place (all levels unless filtered) -- Section B.5's "matches":
	 * the folded form (`foldDiacritics`) of a name contains the folded form
	 * of the query. Without a search index this is a plain linear scan over
	 * the name blocks; with one (`useSearchIndex()`), only the places the
	 * index can't rule out are compared. Same results either way.
	 *
	 * A text with commas also reads as a place and the places it lies in
	 * (Appendix B.13): "Paris, Texas" finds a place named "Paris, Texas"
	 * and every "Paris" whose region or country matches "Texas";
	 * "Springfield, Illinois, United States" narrows by both. Each part
	 * after a comma has to match a different ancestor, nearest first.
	 *
	 * @example
	 * ```ts
	 * for await (const place of reader.search("munchen", { sort: true, limit: 20 }))
	 * 	console.log(place.internationalName, place.country.internationalName);
	 * // Munich Germany
	 * // Grafing bei München Germany
	 * // ...
	 * ```
	 */
	async *search(
		text: string,
		options: SearchOptions = {},
	): AsyncIterableIterator<Place> {
		if (options.sort) {
			yield* this.searchRanked(text, options);
			return;
		}
		let remaining = options.limit ?? Infinity;
		if (remaining <= 0) return;
		const query = await this.prepareQuery(text, await this.activeSearchIndex());
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, query.candidates)) {
				// Match on the bare names first; resolving parents is only worth
				// doing for the few that hit.
				if (!(await this.matchQuery(id, level, query))) continue;
				yield this.loadedPlace(id) ?? (await this.place(id));
				if (--remaining <= 0) return;
			}
		}
	}

	/** The `sort: true` path of `search()`: scores every match in relevance
	 * order (Appendix B.5, or B.5.1 when ranking by area; `relevance.ts`),
	 * then yields the best first. `limit` is applied after sorting, not
	 * during the scan -- the top match can turn up anywhere in id order. */
	private async *searchRanked(
		text: string,
		options: SearchOptions,
	): AsyncIterableIterator<Place> {
		const areas = await this.searchAreas(options.areaTieBreak ?? "auto");
		const compare = areas ? compareAreaRelevance : compareRelevance;
		const needle = foldDiacritics(text);
		const index = await this.activeSearchIndex();
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
		// So is one ranked by a different order than the table was built
		// with, and one with a comma, which the table knows nothing about.
		const shortQuery =
			index !== undefined &&
			index.relevanceRule === (areas ? RELEVANCE_AREA : RELEVANCE_PLAIN) &&
			options.limit !== undefined &&
			options.limit <= index.topCount &&
			options.level === undefined &&
			options.country === undefined &&
			options.region === undefined &&
			!text.includes(",") &&
			needle === text.toLowerCase()
				? await index.shortQuery(text)
				: undefined;
		if (shortQuery) {
			// The table already holds the answer (Appendix B.9 step 1); only
			// confirm each place really matches, so a corrupt table can't add
			// a wrong result.
			let remaining = options.limit ?? Infinity;
			for (const id of shortQuery) {
				if (remaining <= 0) return;
				const names = this.loadedNames(id) ?? (await this.loadNames(id));
				if (!names.some((name) => foldDiacritics(name).includes(needle)))
					continue;
				yield this.loadedPlace(id) ?? (await this.place(id));
				remaining--;
			}
			return;
		}

		const query = await this.prepareQuery(text, index);
		const scored: RankedMatch[] = [];
		for (const level of LEVELS) {
			if (options.level !== undefined && options.level !== level) continue;
			for (const id of this.searchScope(level, options, query.candidates)) {
				const match = await this.matchQuery(id, level, query, compare);
				if (match) scored.push(match);
			}
		}
		if (areas) {
			for (const match of scored)
				match.rankArea = await this.rankArea(match.id, match.level, areas);
		}
		scored.sort(compare);

		let remaining = options.limit ?? Infinity;
		for (const { id } of scored) {
			if (remaining-- <= 0) return;
			yield this.loadedPlace(id) ?? (await this.place(id));
		}
	}

	/** `text`'s readings (Appendix B.13) as needles, and the places a search
	 * index says could match any of them (ascending), or undefined when
	 * there's no index or it can't narrow one of the readings down. */
	private async prepareQuery(
		text: string,
		index: SearchIndex | undefined,
	): Promise<PreparedQuery> {
		const parsed = parseQualifiedQuery(text);
		const readings = parsed.map(({ head, contexts }) => ({
			head: prepareNeedle(head),
			contexts: contexts.map(prepareNeedle),
		}));
		if (!index) return { readings, candidates: undefined };
		let candidates: number[] = [];
		for (const { head } of parsed) {
			const found = await index.candidates(head);
			if (!found) return { readings, candidates: undefined };
			candidates =
				candidates.length === 0 ? found : unionSorted(candidates, found);
		}
		return { readings, candidates };
	}

	/** Whether place `id` matches any reading of `query`. With `compare`,
	 * instead the best-ranked way it does (by that order), or undefined;
	 * `rankArea` is left at 0 for the caller to fill in. */
	private async matchQuery(
		id: number,
		level: PlaceLevel,
		query: PreparedQuery,
		compare?: (a: RankedMatch, b: RankedMatch) => number,
	): Promise<RankedMatch | undefined> {
		const names = this.loadedNames(id) ?? (await this.loadNames(id));
		let best: RankedMatch | undefined;
		let ancestors: string[][] | undefined;
		for (const { head, contexts } of query.readings) {
			let quality: number;
			if (compare) {
				quality = placeMatchQuality(names, head);
				if (quality === 0) continue;
			} else {
				if (!names.some((name) => foldDiacritics(name).includes(head.folded)))
					continue;
				quality = 0;
			}
			let context = 0;
			if (contexts.length > 0) {
				ancestors ??= await this.ancestorNames(id);
				context = contextQuality(contexts, ancestors);
				if (context === 0) continue;
			}
			const match = {
				id,
				level,
				quality,
				contextQuality: context,
				rankArea: 0,
			};
			if (!compare) return match;
			if (!best || compare(match, best) < 0) best = match;
		}
		return best;
	}

	/** The names of place `id`'s ancestors, nearest first: a city's region
	 * and country, a region's country, nothing for a country. */
	private async ancestorNames(id: number): Promise<string[][]> {
		const ids = this.placeIds(id);
		const ancestors: number[] = [];
		if (ids.level === "city") ancestors.push(ids.region!);
		if (ids.level !== "country") ancestors.push(ids.country);
		const names: string[][] = [];
		for (const ancestor of ancestors)
			names.push(
				this.loadedNames(ancestor) ?? (await this.loadNames(ancestor)),
			);
		return names;
	}

	/** `areaTieBreak` resolved to the area bytes to rank by, or undefined
	 * for Appendix B.5's plain order. */
	private async searchAreas(
		mode: "auto" | boolean,
	): Promise<Uint8Array | undefined> {
		if (mode === false) return undefined;
		const areas = await this.placeAreas();
		if (!areas && mode === true) {
			throw new CGeoDataError(
				"areaTieBreak: true ranks by the areas in a locate index, and none is attached; build one with build-locate-index",
			);
		}
		return areas;
	}

	/**
	 * The area byte (binary-format.md Section C.3) of every place, by id --
	 * the size of the place and everything under it, on a log scale, a
	 * quarter of a doubling per step -- read from the attached locate index
	 * (`useLocateIndex()`), or undefined without one. What
	 * `search({ sort: true })` breaks ties with (`SearchOptions.areaTieBreak`).
	 * Read once and then kept; the array is shared, so don't modify it.
	 */
	async placeAreas(): Promise<Uint8Array | undefined> {
		return (await this.activeLocateIndex())?.areas();
	}

	/** Place `id`'s rank area (Appendix B.5.1, `regionRankArea`): its area
	 * byte, except for a region with a city of the same local name. That
	 * takes reading the region's city names, so it's worked out only for
	 * the regions a search actually matched, once each. */
	private async rankArea(
		id: number,
		level: PlaceLevel,
		areas: Uint8Array,
	): Promise<number> {
		if (level !== "region") return areas[id]!;
		const C = this.placeTable.countryCount;
		if (this.rankAreas?.areas !== areas) {
			this.rankAreas = {
				areas,
				regions: new Int16Array(this.placeTable.totalRegions).fill(-1),
			};
		}
		const { regions } = this.rankAreas;
		const cached = regions[id - C]!;
		if (cached >= 0) return cached;
		const own = this.loadedNames(id) ?? (await this.loadNames(id));
		const [lo, hi] = this.idRange("city", { region: id });
		const cities: Array<{ localName: string; area: number }> = [];
		for (let city = lo; city < hi; city++) {
			const names = this.loadedNames(city) ?? (await this.loadNames(city));
			cities.push({ localName: names[0] ?? "", area: areas[city]! });
		}
		const value = regionRankArea(own[0] ?? "", areas[id]!, cities);
		regions[id - C] = value;
		return value;
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
	 * chunk is empty. Cached like lookups, unless `cache` is false: a
	 * one-pass walk over every chunk should skip the cache, so it doesn't
	 * evict everything lookups had cached for chunks it only visits once. */
	async chunk(
		index: number,
		{ cache = true }: { cache?: boolean } = {},
	): Promise<ChunkRecords | undefined> {
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= this.directory.chunkLengths.length
		) {
			throw new RangeError(
				`chunk index ${index} is out of range for this file (0 <= index < ${this.directory.chunkLengths.length})`,
			);
		}
		const loaded = this.loadedChunk(index);
		return (
			(loaded === undefined ? await this.loadChunk(index, cache) : loaded) ??
			undefined
		);
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
	 *
	 * @example
	 * ```ts
	 * const position = await reader.locate(place.id);
	 * if (position) map.setView([position.lat, position.lon]);
	 * ```
	 *
	 * Null if neither the place nor anything under it has any cells -- and
	 * that happens to real places, not only to broken files: a place
	 * smaller than the file's finest cell (a tiny island, an enclave, a
	 * boundary sliver) loses every cell to its neighbours. On a worldwide
	 * build that's about 0.15% of places, every one of them still found
	 * by `search()`; drop them from results that need a position rather
	 * than defaulting to a coordinate.
	 *
	 * With a locate index (`useLocateIndex()`) this reads one entry;
	 * without one it scans every chunk. Same result either way.
	 */
	async locate(id: number): Promise<Location | null> {
		this.checkPlaceId(id);
		const index = await this.activeLocateIndex();
		let found: PlaceLocation | null;
		if (index) {
			const cell = decodeLocateEntry(await index.entry(id), this.header);
			found = cell && { cell, area: await index.area(id) };
		} else {
			found = await computeLocateCell(this, id);
		}
		if (!found) return null;
		const { cell, area } = found;
		const box = this.recordBoundingBox(
			this.chunkBoundingBox(cell.chunkIndex),
			cell.code,
			cell.depth,
		);
		const { width, height, maxDepth } = this.header;
		const cellDegrees =
			(360 / (width * 2 ** maxDepth)) * (180 / (height * 2 ** maxDepth));
		return {
			lat: (box.minLat + box.maxLat) / 2,
			lon: (box.minLon + box.maxLon) / 2,
			boundingBox: box,
			// The middle of the byte's range, 2^((area - 1) / 4) up to
			// 2^(area / 4) cells, on the same log scale.
			area: area === 0 ? 0 : 2 ** ((area - 0.5) / 4) * cellDegrees,
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
	async *chunkRecords(index: number): AsyncIterableIterator<ChunkRecord> {
		const chunk = await this.chunk(index);
		if (!chunk) return;
		const chunkBox = this.chunkBoundingBox(index);
		for (let j = 0; j < chunk.codes.length; j++) {
			const code = chunk.codes[j]!;
			const depth = chunk.depths[j]!;
			const k = chunk.paletteIndices[j]!;
			const placeId = k === 0 ? undefined : chunk.palette[k - 1]!;
			yield {
				code,
				depth,
				boundingBox: this.recordBoundingBox(chunkBox, code, depth),
				place:
					placeId === undefined
						? null
						: (this.loadedPlace(placeId) ?? (await this.place(placeId))),
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

	private checkPlaceId(id: number): void {
		const { totalPlaces } = this.placeTable;
		if (!Number.isInteger(id) || id < 0 || id >= totalPlaces) {
			throw new RangeError(
				`${id} is not a place id for this file (0 <= id < ${totalPlaces})`,
			);
		}
	}

	/** A chunk without reading anything: its records when decoded and
	 * cached, null when it's empty, undefined when it would need a read. */
	private loadedChunk(index: number): ChunkRecords | null | undefined {
		if (this.directory.chunkLengths[index] === 0) return null;
		if (index === this.lastChunkIndex) return this.lastChunk;
		const cached = this.cache.get(index) as ChunkRecords | undefined;
		if (cached) {
			this.lastChunkIndex = index;
			this.lastChunk = cached;
		}
		return cached;
	}

	/** Reads and decodes a chunk, sharing one decode among concurrent
	 * callers. */
	private loadChunk(index: number, cache: boolean): Promise<ChunkRecords> {
		if (!cache) return this.decodeChunk(index);
		const inFlight = this.loading.get(index);
		if (inFlight) return inFlight as Promise<ChunkRecords>;
		const load = this.decodeChunk(index)
			.then((chunk) => {
				this.cache.set(index, chunk, chunkBytes(chunk));
				this.lastChunkIndex = index;
				this.lastChunk = chunk;
				return chunk;
			})
			.finally(() => this.loading.delete(index));
		this.loading.set(index, load);
		return load;
	}

	private async decodeChunk(index: number): Promise<ChunkRecords> {
		const compressed = await this.source.read(
			this.directory.chunkOffsets[index]!,
			this.directory.chunkLengths[index]!,
		);
		return this.decodes.run(async () =>
			this.checkPalette(
				index,
				parseChunk(
					await inflateBlock(this.inflater, compressed),
					this.header.maxDepth,
					this.header.version,
				),
			),
		);
	}

	private checkPalette(index: number, chunk: ChunkRecords): ChunkRecords {
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
		return chunk;
	}

	/** A place's names when its name block is cached, else undefined. */
	private loadedNames(globalId: number): string[] | undefined {
		const blockIndex = Math.floor(globalId / this.nameBlockSize);
		const block = this.cache.get(-1 - blockIndex) as string[][] | undefined;
		return block && this.entryOf(block, blockIndex, globalId);
	}

	/** Reads and decodes a place's name block (sharing one read among
	 * concurrent callers), and returns its names. */
	private async loadNames(globalId: number): Promise<string[]> {
		const blockIndex = Math.floor(globalId / this.nameBlockSize);
		const key = -1 - blockIndex;
		let load = this.loading.get(key) as Promise<string[][]> | undefined;
		if (!load) {
			load = readNameBlock(
				this.source,
				this.placeTable,
				blockIndex,
				this.inflater,
				(work) => this.decodes.run(work),
			)
				.then((block) => {
					this.cache.set(key, block, nameBlockBytes(block));
					return block;
				})
				.finally(() => this.loading.delete(key));
			this.loading.set(key, load);
		}
		return this.entryOf(await load, blockIndex, globalId);
	}

	private get nameBlockSize(): number {
		const { keyframeExp, totalPlaces } = this.placeTable;
		return keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
	}

	private entryOf(
		block: string[][],
		blockIndex: number,
		globalId: number,
	): string[] {
		const entry = block[globalId - blockIndex * this.nameBlockSize];
		if (!entry)
			throw new CGeoDataFormatError(
				`name block ${blockIndex} ended before reaching place ${globalId}`,
			);
		return entry;
	}
}

const LEVELS: readonly PlaceLevel[] = ["country", "region", "city"];

function pendingSlot<I>(option: IndexOption<I> | undefined): IndexSlot<I> {
	return {
		index: undefined,
		owned: false,
		activating: undefined,
		pending:
			option === undefined
				? undefined
				: typeof option === "function"
					? (option as () => Promise<I | SourceInput | undefined>)
					: () => Promise.resolve(option),
	};
}

/** What an index's errors are prefixed with, if anything names it. */
function indexName(input: unknown): string | undefined {
	const name = (input as { name?: unknown } | undefined)?.name;
	return typeof name === "string" ? name : undefined;
}

function assemblePlace(
	id: number,
	ids: PlaceIds,
	country: string[],
	region: string[] | undefined,
	city: string[] | undefined,
): Place {
	const countryRef = placeRef(ids.country, country);
	const regionRef = ids.region === null ? null : placeRef(ids.region, region!);
	const cityRef = ids.city === null ? null : placeRef(ids.city, city!);
	const own = cityRef ?? regionRef ?? countryRef;
	return {
		id,
		localName: own.localName,
		internationalName: own.internationalName,
		names: own.names,
		level: ids.level,
		country: countryRef,
		region: regionRef,
		city: cityRef,
	};
}

function placeRef(id: number, names: string[]): PlaceRef {
	const localName = names[0] ?? "";
	return {
		id,
		localName,
		internationalName: names[1] || localName,
		names,
	};
}

/** A decoded chunk's size, for the cache budget. */
function chunkBytes(chunk: ChunkRecords): number {
	return (
		chunk.codes.byteLength +
		chunk.depths.byteLength +
		chunk.paletteIndices.byteLength +
		chunk.palette.length * 8
	);
}

/** A rough size of a decoded name block, for the cache budget: two bytes
 * per character (V8's worst case), plus per-string and per-array
 * overhead. */
function nameBlockBytes(block: string[][]): number {
	let bytes = 0;
	for (const entry of block) {
		bytes += 32;
		for (const name of entry) bytes += 24 + 2 * name.length;
	}
	return bytes;
}

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

/** A search text's readings as needles, and what an index narrowed them
 * to (`CGeoDataReader.prepareQuery`). */
interface PreparedQuery {
	readings: Array<{ head: Needle; contexts: Needle[] }>;
	candidates: number[] | undefined;
}

/** The union of two ascending id lists, ascending, without duplicates. */
function unionSorted(a: readonly number[], b: readonly number[]): number[] {
	const out: number[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		const x = i < a.length ? a[i]! : Infinity;
		const y = j < b.length ? b[j]! : Infinity;
		out.push(Math.min(x, y));
		if (x <= y) i++;
		if (y <= x) j++;
	}
	return out;
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
