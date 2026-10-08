import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { HierarchyCountry } from "./hierarchy.ts";
import { buildPlaceIdSpace, type CityCollection, type PlaceIdSpace } from "./placeIds.ts";
import { buildNameBlocks } from "./nameBlocks.ts";
import { CandidateIndex, packFeature, type CandidateEntry } from "./candidateIndex.ts";
import { writeCGeoDataFile } from "./writer.ts";
import { buildRegionCountryCandidates } from "./regionCountryCandidates.ts";
import type { CellBounds } from "./geometry.ts";

/** Shared by both the sequential (`build.ts`) and worker-pool
 * (`buildParallel.ts`) paths, so they can't silently drift apart. */
export interface BuildOptions {
  attribution: string;
  widthExp: number;
  heightExp: number;
  maxDepth: number;
  keyframeExp: number;
  /** Region (province) polygons, matched to the hierarchy by `properties.name`.
   * Without these, a point outside every city polygon but still inside a
   * region resolves to "unknown" instead of that region (Section 7.1). */
  regions?: FeatureCollection<Polygon | MultiPolygon, { name: string; country: string }> | undefined;
  /** Country polygons, matched to the hierarchy by `properties.code`. */
  countries?: FeatureCollection<Polygon | MultiPolygon, { code: string }> | undefined;
  /** When set, only these chunk indices are compressed; every other chunk
   * is left empty (directory length 0), exactly as if it had no candidates.
   * Nothing before the chunk stage changes -- the place table, name blocks
   * and candidate index are still built in full -- so this only narrows
   * which chunks are worth spending quadtree time on. An empty set builds
   * no chunks at all, which still yields a complete, readable place table. */
  onlyChunks?: ReadonlySet<number> | undefined;
  /** Fires once per chunk that actually did quadtree work -- which
   * includes chunks that produced no records (`recordCount === 0`), since
   * those still cost real time and are exactly the ones worth seeing when
   * hunting for slow areas. Chunks skipped before any work (empty root
   * bbox query, or excluded by `onlyChunks`) never fire it. Both paths fire
   * it as the chunk finishes, so it doubles as live progress on a long
   * build; the worker-pool path fires out of order (whichever worker
   * finishes next), not in chunk-index order. `elapsedMs` covers the same
   * span in both paths: `buildChunkRecords` plus `encodeChunk`, excluding
   * any queueing. A throwing callback fails the build. */
  onChunkBuilt?: (info: {
    chunkIndex: number;
    chunkCount: number;
    recordCount: number;
    elapsedMs: number;
  }) => void;
}

export interface BuildStats {
  countryCount: number;
  regionCount: number;
  cityCount: number;
  unmatchedCityCount: number;
  chunkCount: number;
  nonEmptyChunkCount: number;
  totalRecords: number;
  fileBytes: number;
}

export interface PreparedBuild {
  placeIds: PlaceIdSpace;
  blockLengths: number[];
  blockBytes: Buffer[];
  candidateIndex: CandidateIndex;
  width: number;
  height: number;
}

/** Everything needed before chunks can be built: the place hierarchy, the
 * compressed name blocks, and the spatial index over every candidate
 * (cities + regions + countries). Independent of how chunks then get
 * processed (sequential loop or worker pool). */
export function prepareBuild(
  hierarchy: HierarchyCountry[],
  cities: CityCollection,
  options: BuildOptions,
): PreparedBuild {
  const placeIds = buildPlaceIdSpace(hierarchy, cities);
  const { blockLengths, blockBytes } = buildNameBlocks(placeIds.nameEntries, options.keyframeExp);

  const regionCountryCandidates = buildRegionCountryCandidates(hierarchy, options.countries, options.regions);
  const cityCandidates: CandidateEntry[] = [...placeIds.cityFeaturesById].map(([globalId, city]) => ({
    globalId,
    shape: "shape" in city ? city.shape : packFeature(city),
    ancestorIds: placeIds.cityAncestors.get(globalId) ?? [],
  }));
  const candidateIndex = new CandidateIndex([...regionCountryCandidates, ...cityCandidates]);

  return {
    placeIds,
    blockLengths,
    blockBytes,
    candidateIndex,
    width: 2 ** options.widthExp,
    height: 2 ** options.heightExp,
  };
}

/** The lat/lon bounds of chunk `chunkIndex` in a `width x height` grid
 * (Section 6.1), row-major: `chunkIndex = r * width + c`. */
export function chunkBoundsOf(chunkIndex: number, width: number, height: number): CellBounds {
  const r = Math.floor(chunkIndex / width);
  const c = chunkIndex - r * width;
  const latMin = -90 + (r * 180) / height;
  const latMax = -90 + ((r + 1) * 180) / height;
  const lonMin = -180 + (c * 360) / width;
  const lonMax = -180 + ((c + 1) * 360) / width;
  return { lonMin, lonMax, latMin, latMax };
}

/** Assembles the final file once every chunk's compressed bytes (or
 * `null` for empty chunks) are known, regardless of how they were
 * produced. */
export function finishBuild(
  prepared: PreparedBuild,
  options: BuildOptions,
  chunkBytes: (Buffer | null)[],
  totalRecords: number,
  nonEmptyChunkCount: number,
): { bytes: Buffer; stats: BuildStats } {
  const { placeIds, blockLengths, blockBytes, width, height } = prepared;

  const bytes = writeCGeoDataFile({
    attribution: options.attribution,
    widthExp: options.widthExp,
    heightExp: options.heightExp,
    maxDepth: options.maxDepth,
    keyframeExp: options.keyframeExp,
    countryCount: placeIds.countryCount,
    regionCounts: placeIds.regionCounts,
    cityCounts: placeIds.cityCounts,
    nameBlockLengths: blockLengths,
    nameBlockBytes: blockBytes,
    chunkBytes,
  });

  return {
    bytes,
    stats: {
      countryCount: placeIds.countryCount,
      regionCount: placeIds.regionCounts.reduce((a, b) => a + b, 0),
      cityCount: placeIds.cityFeaturesById.size,
      unmatchedCityCount: placeIds.unmatched.length,
      chunkCount: width * height,
      nonEmptyChunkCount,
      totalRecords,
      fileBytes: bytes.length,
    },
  };
}
