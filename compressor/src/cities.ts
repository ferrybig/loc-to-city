import { readFileSync } from "node:fs";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { packFeature } from "./candidateIndex.ts";
import { streamGeoJSONSeq } from "./geojsonseq.ts";
import type { CityFeature, CityProperties, PackedCityFeature } from "./placeIds.ts";

/** Loads the city layer, accepting either a plain GeoJSON
 * `FeatureCollection` or a GeoJSON Text Sequence (`.geojsonseq`, one
 * RS-delimited feature per record).
 *
 * The sequence form exists because the worldwide city layer runs to
 * several gigabytes, and neither of the obvious ways to read it works at
 * that size (see `streamGeoJSONSeq`).
 *
 * Each feature is packed (`packFeature`) as soon as it is parsed, and its
 * GeoJSON coordinates dropped: nested `[x, y]` arrays cost ~70 bytes of heap
 * per vertex against 16 packed, which on the worldwide layer is the
 * difference between ~7GB and ~1.7GB held for the whole build. */
export async function loadCities(path: string): Promise<{ features: PackedCityFeature[] }> {
  if (!path.endsWith(".geojsonseq")) {
    const collection = JSON.parse(readFileSync(path, "utf8")) as FeatureCollection<Polygon | MultiPolygon, CityProperties>;
    return { features: collection.features.map(packCity) };
  }

  const features: PackedCityFeature[] = [];
  for await (const feature of streamGeoJSONSeq<CityFeature>(path)) features.push(packCity(feature));
  return { features };
}

function packCity(feature: CityFeature): PackedCityFeature {
  return { properties: feature.properties, shape: packFeature(feature) };
}
