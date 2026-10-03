import { createReadStream, readFileSync } from "node:fs";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { CityProperties } from "./placeIds.ts";

const RECORD_SEPARATOR = 0x1e;

type CityFeatureCollection = FeatureCollection<Polygon | MultiPolygon, CityProperties>;

/** Loads the city layer, accepting either a plain GeoJSON
 * `FeatureCollection` or a GeoJSON Text Sequence (`.geojsonseq`, one
 * RS-delimited feature per record).
 *
 * The sequence form exists because the worldwide city layer runs to
 * several gigabytes, and neither of the obvious ways to read it works at
 * that size: Node cannot hold a string past ~512MB, and `readFileSync`
 * refuses a file over 2GiB even into a Buffer. So records are split out of
 * a read stream and parsed one at a time -- only the parsed features are
 * ever held, never the file. */
export async function loadCities(path: string): Promise<CityFeatureCollection> {
  if (!path.endsWith(".geojsonseq")) {
    return JSON.parse(readFileSync(path, "utf8")) as CityFeatureCollection;
  }

  const features: Feature<Polygon | MultiPolygon, CityProperties>[] = [];
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 });
  let carry: Buffer = Buffer.alloc(0);

  const push = (raw: Buffer): void => {
    const record = raw.toString("utf8").trim();
    if (record.length > 0) features.push(JSON.parse(record) as Feature<Polygon | MultiPolygon, CityProperties>);
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

  return { type: "FeatureCollection", features };
}
