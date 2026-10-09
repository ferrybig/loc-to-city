import { CGeoDataFormatError } from "./errors.ts";
import { type Inflater, inflateBlock } from "./inflate.ts";
import type { ByteSource } from "./source.ts";
import { IncompleteBufferError, readVarint, readVarintList } from "./varint.ts";

const utf8 = new TextDecoder();

/** The place table's uncompressed part (Section 7.2), parsed: the place
 * counts and where each name block is. */
export interface PlaceTableInfo {
	/** C, the number of countries. */
	countryCount: number;
	/** R, the number of regions. */
	totalRegions: number;
	/** The number of cities. */
	totalCities: number;
	/** N, every place: countries, regions and cities. */
	totalPlaces: number;
	/** Length countryCount + 1; prefix[c] = number of regions before country c. */
	regionCountryPrefix: number[];
	/** Length totalRegions + 1; prefix[r] = number of cities before region r. */
	cityRegionPrefix: number[];
	/** The header's keyframe_exp (Section 7.3). */
	keyframeExp: number;
	/** Absolute file offset of each name block's compressed bytes. */
	blockOffsets: number[];
	/** Compressed byte length of each name block. */
	blockLengths: number[];
}

function sum(values: number[]): number {
	return values.reduce((a, b) => a + b, 0);
}

function prefixSum(values: number[]): number[] {
	const prefix = new Array<number>(values.length + 1);
	prefix[0] = 0;
	for (let i = 0; i < values.length; i++) {
		prefix[i + 1] = prefix[i]! + values[i]!;
	}
	return prefix;
}

/** Parses Section 7.2's uncompressed prefix (counts + block_lengths),
 * growing the read like readHeaderAndDirectory does, since its size depends
 * on country_count/region_counts which aren't known up front. */
export async function parsePlaceTable(
	source: ByteSource,
	placeTableStart: number,
	placeTableLength: number,
	keyframeExp: number,
): Promise<PlaceTableInfo> {
	let size = Math.min(1024, placeTableLength);
	for (;;) {
		const buf = await source.read(placeTableStart, size);
		try {
			return parsePrefix(buf, placeTableStart, placeTableLength, keyframeExp);
		} catch (err) {
			if (err instanceof IncompleteBufferError && size < placeTableLength) {
				size = Math.min(size * 4, placeTableLength);
				continue;
			}
			throw err;
		}
	}
}

function parsePrefix(
	buf: Uint8Array,
	placeTableStart: number,
	placeTableLength: number,
	keyframeExp: number,
): PlaceTableInfo {
	let offset = 0;
	const { value: countryCount, bytesRead: b1 } = readVarint(buf, offset);
	offset += b1;
	const { values: regionCounts, bytesRead: b2 } = readVarintList(
		buf,
		offset,
		countryCount,
	);
	offset += b2;
	const totalRegions = sum(regionCounts);
	const { values: cityCounts, bytesRead: b3 } = readVarintList(
		buf,
		offset,
		totalRegions,
	);
	offset += b3;
	const totalCities = sum(cityCounts);
	const totalPlaces = countryCount + totalRegions + totalCities;

	// Section 7.3.
	const blockSize = keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
	const blockCount =
		totalPlaces === 0
			? 0
			: keyframeExp === 0
				? 1
				: Math.ceil(totalPlaces / blockSize);
	const storedBlockLengthCount = Math.max(blockCount - 1, 0);
	const { values: storedBlockLengths, bytesRead: b4 } = readVarintList(
		buf,
		offset,
		storedBlockLengthCount,
	);
	offset += b4;

	const namesStart = placeTableStart + offset;
	const blockOffsets: number[] = new Array(blockCount);
	const blockLengths: number[] = new Array(blockCount);
	let running = namesStart;
	for (let b = 0; b < blockCount - 1; b++) {
		blockOffsets[b] = running;
		blockLengths[b] = storedBlockLengths[b]!;
		running += storedBlockLengths[b]!;
	}
	if (blockCount > 0) {
		// The last block's length isn't stored -- it extends to the end of the
		// place table (Section 7.3).
		blockOffsets[blockCount - 1] = running;
		blockLengths[blockCount - 1] = placeTableStart + placeTableLength - running;
	}

	return {
		countryCount,
		totalRegions,
		totalCities,
		totalPlaces,
		regionCountryPrefix: prefixSum(regionCounts),
		cityRegionPrefix: prefixSum(cityCounts),
		keyframeExp,
		blockOffsets,
		blockLengths,
	};
}

/** Largest index c such that prefix[c] <= value, per Section 7.5. `prefix`
 * is non-decreasing with prefix[0] = 0. */
export function largestIndexWithPrefixAtMost(
	prefix: number[],
	value: number,
): number {
	let lo = 0;
	let hi = prefix.length - 2;
	let answer = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		if (prefix[mid]! <= value) {
			answer = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return answer;
}

/** A place id classified (Section 7.5): its level, and the level-local
 * index of it and of its ancestors -- a region index, not a global id. */
export type ResolvedPlace =
	| {
			/** A country. */
			level: "country";
			/** The country's index, which is also its global id. */
			countryId: number;
	  }
	| {
			/** A region. */
			level: "region";
			/** Its country's index. */
			countryId: number;
			/** The region's index among all regions. */
			regionId: number;
	  }
	| {
			/** A city. */
			level: "city";
			/** Its country's index. */
			countryId: number;
			/** Its region's index among all regions. */
			regionId: number;
			/** The city's index among all cities. */
			cityId: number;
	  };

/** Classifies a place id per Section 7.5. `regionId`/`cityId` are the
 * level-local indices the spec calls "region index"/"city index" (not
 * global ids) -- add countryCount / countryCount+totalRegions to get the
 * global id for a name lookup. */
export function resolveIdentifier(
	info: PlaceTableInfo,
	id: number,
): ResolvedPlace {
	const {
		countryCount,
		totalRegions,
		totalPlaces,
		regionCountryPrefix,
		cityRegionPrefix,
	} = info;
	if (!Number.isInteger(id) || id < 0 || id >= totalPlaces) {
		throw new RangeError(
			`place id ${id} is out of range for this file (0 <= id < ${totalPlaces})`,
		);
	}
	if (id < countryCount) {
		return { level: "country", countryId: id };
	}
	if (id < countryCount + totalRegions) {
		const regionId = id - countryCount;
		const countryId = largestIndexWithPrefixAtMost(
			regionCountryPrefix,
			regionId,
		);
		return { level: "region", countryId, regionId };
	}
	const cityId = id - countryCount - totalRegions;
	const regionId = largestIndexWithPrefixAtMost(cityRegionPrefix, cityId);
	const countryId = largestIndexWithPrefixAtMost(regionCountryPrefix, regionId);
	return { level: "city", countryId, regionId, cityId };
}

/** Inflates one whole name block (Section 7.3) and splits it into its
 * entries, each split on `|` (Section 7.4). For walking many consecutive
 * ids this is one inflate per block instead of one per id. */
export async function readNameBlock(
	source: ByteSource,
	info: PlaceTableInfo,
	blockIndex: number,
	inflater: Inflater,
	/** Where the CPU-bound part runs; see `TurnQueue`. */
	decode: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
): Promise<string[][]> {
	const { blockOffsets, blockLengths } = info;
	if (blockIndex < 0 || blockIndex >= blockOffsets.length) {
		throw new RangeError(
			`name block ${blockIndex} is out of range for this file (0 <= block < ${blockOffsets.length})`,
		);
	}
	const compressed = await source.read(
		blockOffsets[blockIndex]!,
		blockLengths[blockIndex]!,
	);
	return decode(async () =>
		splitNameBlock(await inflateBlock(inflater, compressed), blockIndex),
	);
}

/** An inflated name block (Section 7.3) split into its entries, each
 * split on `|` (Section 7.4). */
function splitNameBlock(inflated: Uint8Array, blockIndex: number): string[][] {
	const end = inflated.lastIndexOf(0) + 1;
	if (end !== inflated.length) {
		throw new CGeoDataFormatError(
			`name block ${blockIndex} has ${inflated.length - end} trailing bytes after its last NUL terminator`,
		);
	}
	if (end === 0) return [];
	// One decode for the whole block: NUL and `|` are single bytes that
	// never occur inside a multi-byte UTF-8 sequence, so splitting the
	// decoded text finds the same boundaries splitting the bytes would.
	const entries = utf8.decode(inflated.subarray(0, end - 1)).split("\0");
	return entries.map((entry) => entry.split("|"));
}

/** Recovers a place's name entry (Section 7.4, split on `|`) by inflating
 * only the one name block (Section 7.3) that contains it. */
export async function readNameEntry(
	source: ByteSource,
	info: PlaceTableInfo,
	globalId: number,
	inflater: Inflater,
): Promise<string[]> {
	const { keyframeExp, totalPlaces, blockOffsets, blockLengths } = info;
	if (globalId < 0 || globalId >= totalPlaces) {
		throw new RangeError(
			`place id ${globalId} is out of range for this file (0 <= id < ${totalPlaces})`,
		);
	}
	const blockSize = keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
	const blockIndex = Math.floor(globalId / blockSize);
	const withinBlock = globalId - blockIndex * blockSize;

	const compressed = await source.read(
		blockOffsets[blockIndex]!,
		blockLengths[blockIndex]!,
	);
	const inflated = await inflateBlock(inflater, compressed);

	let start = 0;
	for (let i = 0; i < withinBlock; i++) {
		const nul = inflated.indexOf(0, start);
		if (nul === -1) {
			throw new CGeoDataFormatError(
				`name block ${blockIndex} ended before reaching entry ${withinBlock}`,
			);
		}
		start = nul + 1;
	}
	const end = inflated.indexOf(0, start);
	if (end === -1) {
		throw new CGeoDataFormatError(
			`name entry for place ${globalId} is missing its NUL terminator`,
		);
	}
	return utf8.decode(inflated.subarray(start, end)).split("|");
}
