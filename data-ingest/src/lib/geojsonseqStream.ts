import { createReadStream } from "node:fs";
import type { Feature } from "geojson";

const RECORD_SEPARATOR = 0x1e;

/** Streams an RS-delimited GeoJSON Text Sequence (the format `osmium
 * export -f geojsonseq` produces) one feature at a time, without ever
 * holding the whole file in memory -- needed for multi-GB admin exports
 * (a naive full read is exactly what caused the OOM documented in
 * README.md's "Europe scaling test" section, for the same class of file). */
export async function* streamGeoJSONSeq(path: string): AsyncGenerator<Feature> {
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
  let carry: Buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    const buf: Buffer = carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    for (;;) {
      const idx = buf.indexOf(RECORD_SEPARATOR, start);
      if (idx === -1) break;
      const record = buf.subarray(start, idx).toString("utf8").trim();
      if (record.length > 0) yield JSON.parse(record) as Feature;
      start = idx + 1;
    }
    carry = buf.subarray(start);
  }

  const last = carry.toString("utf8").trim();
  if (last.length > 0) yield JSON.parse(last) as Feature;
}
