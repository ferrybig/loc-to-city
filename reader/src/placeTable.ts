import type { RandomAccessSource } from "./source.js";
import { readVarint, readVarintList, IncompleteBufferError } from "./varint.js";
import { safeInflate } from "./zlibUtil.js";

export interface PlaceTableInfo {
  countryCount: number;
  totalRegions: number;
  totalCities: number;
  totalPlaces: number;
  /** Length countryCount + 1; prefix[c] = number of regions before country c. */
  regionCountryPrefix: number[];
  /** Length totalRegions + 1; prefix[r] = number of cities before region r. */
  cityRegionPrefix: number[];
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
export function parsePlaceTable(
  source: RandomAccessSource,
  placeTableStart: number,
  placeTableLength: number,
  keyframeExp: number,
): PlaceTableInfo {
  let size = Math.min(1024, placeTableLength);
  for (;;) {
    const buf = source.readSync(placeTableStart, size);
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
  const { values: regionCounts, bytesRead: b2 } = readVarintList(buf, offset, countryCount);
  offset += b2;
  const totalRegions = sum(regionCounts);
  const { values: cityCounts, bytesRead: b3 } = readVarintList(buf, offset, totalRegions);
  offset += b3;
  const totalCities = sum(cityCounts);
  const totalPlaces = countryCount + totalRegions + totalCities;

  // Section 7.3.
  const blockSize = keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
  const blockCount = totalPlaces === 0 ? 0 : keyframeExp === 0 ? 1 : Math.ceil(totalPlaces / blockSize);
  const storedBlockLengthCount = Math.max(blockCount - 1, 0);
  const { values: storedBlockLengths, bytesRead: b4 } = readVarintList(buf, offset, storedBlockLengthCount);
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
export function largestIndexWithPrefixAtMost(prefix: number[], value: number): number {
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

export type ResolvedPlace =
  | { level: "country"; countryId: number }
  | { level: "region"; countryId: number; regionId: number }
  | { level: "city"; countryId: number; regionId: number; cityId: number };

/** Classifies a place id per Section 7.5. `regionId`/`cityId` are the
 * level-local indices the spec calls "region index"/"city index" (not
 * global ids) -- add countryCount / countryCount+totalRegions to get the
 * global id for a name lookup. */
export function resolveIdentifier(info: PlaceTableInfo, id: number): ResolvedPlace {
  const { countryCount, totalRegions, totalPlaces, regionCountryPrefix, cityRegionPrefix } = info;
  if (!Number.isInteger(id) || id < 0 || id >= totalPlaces) {
    throw new RangeError(`place id ${id} is out of range for this file (0 <= id < ${totalPlaces})`);
  }
  if (id < countryCount) {
    return { level: "country", countryId: id };
  }
  if (id < countryCount + totalRegions) {
    const regionId = id - countryCount;
    const countryId = largestIndexWithPrefixAtMost(regionCountryPrefix, regionId);
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
export function readNameBlock(source: RandomAccessSource, info: PlaceTableInfo, blockIndex: number): string[][] {
  const { blockOffsets, blockLengths } = info;
  if (blockIndex < 0 || blockIndex >= blockOffsets.length) {
    throw new RangeError(`name block ${blockIndex} is out of range for this file (0 <= block < ${blockOffsets.length})`);
  }
  const inflated = safeInflate(source.readSync(blockOffsets[blockIndex]!, blockLengths[blockIndex]!));
  const entries: string[][] = [];
  let start = 0;
  for (;;) {
    const end = inflated.indexOf(0, start);
    if (end === -1) break;
    entries.push(inflated.toString("utf8", start, end).split("|"));
    start = end + 1;
  }
  if (start !== inflated.length) {
    throw new Error(`name block ${blockIndex} has ${inflated.length - start} trailing bytes after its last NUL terminator`);
  }
  return entries;
}

/** Recovers a place's name entry (Section 7.4, split on `|`) by inflating
 * only the one name block (Section 7.3) that contains it. */
export function readNameEntry(
  source: RandomAccessSource,
  info: PlaceTableInfo,
  globalId: number,
): string[] {
  const { keyframeExp, totalPlaces, blockOffsets, blockLengths } = info;
  if (globalId < 0 || globalId >= totalPlaces) {
    throw new RangeError(`place id ${globalId} is out of range for this file (0 <= id < ${totalPlaces})`);
  }
  const blockSize = keyframeExp === 0 ? totalPlaces : 2 ** keyframeExp;
  const blockIndex = Math.floor(globalId / blockSize);
  const withinBlock = globalId - blockIndex * blockSize;

  const compressed = source.readSync(blockOffsets[blockIndex]!, blockLengths[blockIndex]!);
  const inflated = safeInflate(compressed);

  let start = 0;
  for (let i = 0; i < withinBlock; i++) {
    const nul = inflated.indexOf(0, start);
    if (nul === -1) {
      throw new Error(`name block ${blockIndex} ended before reaching entry ${withinBlock}`);
    }
    start = nul + 1;
  }
  const end = inflated.indexOf(0, start);
  if (end === -1) {
    throw new Error(`name entry for place ${globalId} is missing its NUL terminator`);
  }
  return inflated.toString("utf8", start, end).split("|");
}
