/**
 * CGEODATA reader: resolves a latitude/longitude to the country, region
 * and city containing it, from a CGEODATA file (see binary-format.md).
 *
 * This entry point is platform-neutral. On Node.js, open files with
 * `openFile()` from `./node`; anywhere else, hand `CGeoDataReader.open()`
 * the file's bytes or a `Blob`. Search and locate indexes, and their
 * builders, are in `./indexes`; the format's low-level codecs, for tools
 * that write or inspect files, in `./format`.
 *
 * @module
 */
export { type BoundingBox, boundingBoxContains } from "./cellBounds.ts";
export type { ChunkRecords } from "./chunk.ts";
export type { CGeoDataDirectory } from "./directory.ts";
export {
	CGeoDataError,
	CGeoDataFormatError,
	CGeoDataIndexMismatchError,
	CGeoDataVersionError,
} from "./errors.ts";
export type { CGeoDataHeader } from "./header.ts";
export { type Inflater, streamInflater } from "./inflate.ts";
export type { LocateIndex } from "./locateIndex.ts";
export {
	CGeoDataReader,
	type ChunkRecord,
	DEFAULT_CACHE_BYTES,
	type IndexOption,
	type Location,
	type OpenOptions,
	type Place,
	type PlaceCounts,
	type PlaceFilter,
	type PlaceIdResult,
	type PlaceIds,
	type PlaceLevel,
	type PlaceRef,
	type QueryResult,
	type SearchOptions,
} from "./reader.ts";
export type { SearchIndex } from "./searchIndex.ts";
export {
	BlobSource,
	type ByteSource,
	BytesSource,
	type SourceInput,
} from "./source.ts";
