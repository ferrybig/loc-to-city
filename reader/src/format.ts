/**
 * binary-format.md at the byte level: the codecs and parsers the reader is
 * built from, for tools that write or inspect CGEODATA files (the
 * compressor uses them). They follow the format, not a stable API, and
 * may change when it does; `CGeoDataReader` is the interface for reading.
 *
 * @module @ferrybig/cgeodata-reader/format
 */
export {
	type BoundingBox,
	cellBoundingBox,
	chunkBoundingBox,
} from "./cellBounds.ts";
export { type ChunkRecords, parseChunk } from "./chunk.ts";
export { readHeaderAndDirectory } from "./container.ts";
export { type CGeoDataDirectory, parseDirectory } from "./directory.ts";
export { type CGeoDataHeader, parseHeader } from "./header.ts";
export {
	type Inflater,
	inflateBlock,
	inflateCeiling,
	streamInflater,
} from "./inflate.ts";
export {
	decodeLocateEntry,
	encodeLocateEntry,
	type LocateCell,
	type LocateGrid,
	locateEntryWidth,
} from "./locateIndex.ts";
export { lowBits, mortonDecode, mortonEncode, shiftRight } from "./morton.ts";
export {
	type PlaceTableInfo,
	parsePlaceTable,
	type ResolvedPlace,
	readNameBlock,
	readNameEntry,
	resolveIdentifier,
} from "./placeTable.ts";
export {
	containsTokenRun,
	EXACT_SPELLING_BONUS,
	foldDiacritics,
	LEVEL_BONUS,
	type Needle,
	nameMatchQuality,
	placeMatchQuality,
	prepareNeedle,
	QUALITY_EXACT,
	QUALITY_MAX,
	QUALITY_SUBSTRING,
	QUALITY_WHOLE_WORD,
	tokenize,
	tokenizeFolded,
} from "./relevance.ts";
export {
	fnv1a32,
	foldSymbols,
	trigramListIndex,
	trigramListIndices,
} from "./searchIndex.ts";
export { toSource } from "./source.ts";
export {
	IncompleteBufferError,
	readDeltaVarintList,
	readDeltaVarints32Into,
	readDeltaVarintsInto,
	readVarint,
	readVarintList,
	type VarintListResult,
	type VarintResult,
	writeVarint,
} from "./varint.ts";
