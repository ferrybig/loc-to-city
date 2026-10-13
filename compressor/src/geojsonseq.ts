import { createReadStream, readFileSync } from "node:fs";
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from "geojson";

const RECORD_SEPARATOR = 0x1e;

/** The features of a GeoJSON Text Sequence (`.geojsonseq`, one
 * RS-delimited feature per record), parsed one at a time.
 *
 * The worldwide layers are written this way because neither of the
 * obvious ways to read them works at that size: Node cannot hold a string
 * past ~512MB, and `readFileSync` refuses a file over 2GiB even into a
 * Buffer. So records are split out of a read stream instead. */
export async function* streamGeoJSONSeq<F extends Feature = Feature>(path: string): AsyncGenerator<F> {
  const stream = createReadStream(path, { highWaterMark: 8 * 1024 * 1024 });
  // A record spanning several reads is kept as a list of chunks and joined
  // once its end turns up: growing one carry buffer re-copies everything
  // read so far on every read, which a large region relation pays for.
  let pending: Buffer[] = [];

  const parse = (raw: Buffer): F | undefined => {
    const record = raw.toString("utf8").trim();
    return record.length > 0 ? (JSON.parse(record) as F) : undefined;
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    for (;;) {
      const idx = chunk.indexOf(RECORD_SEPARATOR, start);
      if (idx === -1) break;
      const piece = chunk.subarray(start, idx);
      const feature = parse(pending.length > 0 ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      if (feature) yield feature;
      start = idx + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  const feature = parse(Buffer.concat(pending));
  if (feature) yield feature;
}

/** A plain GeoJSON `FeatureCollection`, or a `.geojsonseq` read into one
 * (see `streamGeoJSONSeq`): the worldwide region layer is a sequence,
 * since its unsimplified polygons no longer fit in one string. */
export async function loadFeatureCollection<G extends Geometry, P extends GeoJsonProperties>(path: string): Promise<FeatureCollection<G, P>> {
  if (!path.endsWith(".geojsonseq")) return JSON.parse(readFileSync(path, "utf8")) as FeatureCollection<G, P>;
  const features: Feature<G, P>[] = [];
  for await (const feature of streamGeoJSONSeq<Feature<G, P>>(path)) features.push(feature);
  return { type: "FeatureCollection", features };
}
