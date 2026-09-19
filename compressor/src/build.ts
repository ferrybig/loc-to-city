import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { HierarchyCountry } from "./hierarchy.js";
import { buildPlaceIdSpace, type CityProperties } from "./placeIds.js";
import { buildNameBlocks } from "./nameBlocks.js";
import { CandidateIndex, type CandidateEntry } from "./candidateIndex.js";
import { buildChunkRecords } from "./quadtree.js";
import { encodeChunk } from "./chunkEncoder.js";
import { writeCGeoDataFile } from "./writer.js";
import { buildRegionCountryCandidates } from "./regionCountryCandidates.js";

export interface BuildOptions {
  attribution: string;
  widthExp: number;
  heightExp: number;
  maxDepth: number;
  keyframeExp: number;
  /** Region (province) polygons, matched to the hierarchy by `properties.name`.
   * Without these, a point outside every city polygon but still inside a
   * region resolves to "unknown" instead of that region (Section 7.1). */
  regions?: FeatureCollection<Polygon | MultiPolygon, { name: string }> | undefined;
  /** Country polygons, matched to the hierarchy by `properties.code`. */
  countries?: FeatureCollection<Polygon | MultiPolygon, { code: string }> | undefined;
  onChunkBuilt?: (info: { chunkIndex: number; chunkCount: number; recordCount: number }) => void;
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

export function buildCGeoDataFile(
  hierarchy: HierarchyCountry[],
  cities: FeatureCollection<Polygon | MultiPolygon, CityProperties>,
  options: BuildOptions,
): { bytes: Buffer; stats: BuildStats } {
  const placeIds = buildPlaceIdSpace(hierarchy, cities);
  const { blockLengths, blockBytes } = buildNameBlocks(placeIds.nameEntries, options.keyframeExp);

  const regionCountryCandidates = buildRegionCountryCandidates(hierarchy, options.countries, options.regions);
  const cityCandidates: CandidateEntry[] = [...placeIds.cityFeaturesById].map(([globalId, feature]) => ({
    globalId,
    feature,
    ancestorIds: placeIds.cityAncestors.get(globalId) ?? [],
  }));
  const candidateIndex = new CandidateIndex([...regionCountryCandidates, ...cityCandidates]);

  const width = 2 ** options.widthExp;
  const height = 2 ** options.heightExp;
  const chunkBytes: (Buffer | null)[] = new Array(width * height).fill(null);

  let totalRecords = 0;
  let nonEmptyChunkCount = 0;
  for (let r = 0; r < height; r++) {
    const latMin = -90 + (r * 180) / height;
    const latMax = -90 + ((r + 1) * 180) / height;
    for (let c = 0; c < width; c++) {
      const lonMin = -180 + (c * 360) / width;
      const lonMax = -180 + ((c + 1) * 360) / width;

      const records = buildChunkRecords(candidateIndex, { lonMin, lonMax, latMin, latMax }, options.maxDepth);
      if (records.length === 0) continue;

      const chunkIndex = r * width + c;
      chunkBytes[chunkIndex] = encodeChunk(records);
      totalRecords += records.length;
      nonEmptyChunkCount++;
      options.onChunkBuilt?.({ chunkIndex, chunkCount: width * height, recordCount: records.length });
    }
  }

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
