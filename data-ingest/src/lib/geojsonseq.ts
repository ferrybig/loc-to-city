import { readFileSync } from "node:fs";
import type { Feature } from "geojson";

const RECORD_SEPARATOR = 0x1e;

/** Reads an RS-delimited GeoJSON Text Sequence (the format `osmium export
 * -f geojsonseq` produces) -- plain JSON.parse can't handle this directly
 * since it's not one JSON document. */
export function readGeoJSONSeq(path: string): Feature[] {
  const raw = readFileSync(path);
  const features: Feature[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === RECORD_SEPARATOR) {
      const chunk = raw.subarray(start, i).toString("utf8").trim();
      if (chunk.length > 0) features.push(JSON.parse(chunk) as Feature);
      start = i + 1;
    }
  }
  return features;
}
