import { createReadStream, readFileSync } from "node:fs";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { packFeature } from "./candidateIndex.ts";
import type { CityFeature, CityProperties, PackedCityFeature } from "./placeIds.ts";

const RECORD_SEPARATOR = 0x1e;

/** Loads the city layer, accepting either a plain GeoJSON
 * `FeatureCollection` or a GeoJSON Text Sequence (`.geojsonseq`, one
 * RS-delimited feature per record).
 *
 * The sequence form exists because the worldwide city layer runs to
 * several gigabytes, and neither of the obvious ways to read it works at
 * that size: Node cannot hold a string past ~512MB, and `readFileSync`
 * refuses a file over 2GiB even into a Buffer. So records are split out of
 * a read stream and parsed one at a time.
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
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 });
  let carry: Buffer = Buffer.alloc(0);

  const push = (raw: Buffer): void => {
    const record = raw.toString("utf8").trim();
    if (record.length > 0) features.push(packCity(JSON.parse(record) as CityFeature));
  };

  for await (const chunk of stream) {
    const buf: Buffer = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    for (;;) {
      const idx = buf.indexOf(RECORD_SEPARATOR, start);
      if (idx === -1) break;
      push(buf.subarray(start, idx));
      start = idx + 1;
    }
    // A record may straddle the chunk boundary, so keep the tail.
    carry = Buffer.from(buf.subarray(start));
  }
  push(carry);

  return { features };
}

function packCity(feature: CityFeature): PackedCityFeature {
  return { properties: feature.properties, shape: packFeature(feature) };
}
