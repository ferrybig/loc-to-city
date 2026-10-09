/**
 * The sidecar indexes (binary-format.md Appendices B and C): building
 * them from a `.bin` file, and opening them yourself -- to share one
 * index between several readers, say. A reader opened with `openFile()`
 * already finds the ones next to its file; elsewhere,
 * `OpenOptions.searchIndex` / `locateIndex` take an index's bytes.
 *
 * @module @ferrybig/cgeodata-reader/indexes
 */
export {
	type BuildLocateIndexOptions,
	buildLocateIndex,
	LocateIndex,
} from "./locateIndex.ts";
export {
	buildSearchIndex,
	DEFAULT_SEARCH_INDEX_OPTIONS,
	SearchIndex,
	type SearchIndexOptions,
} from "./searchIndex.ts";
