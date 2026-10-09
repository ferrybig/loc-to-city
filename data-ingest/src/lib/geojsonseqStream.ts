import { createReadStream } from "node:fs";
import type { Feature } from "geojson";

const RECORD_SEPARATOR = 0x1e;

/** Streams an RS-delimited GeoJSON Text Sequence (the format `osmium
 * export -f geojsonseq` produces) one feature at a time, without ever
 * holding the whole file in memory -- needed for multi-GB admin exports
 * (a naive full read is exactly what caused the OOM documented in
 * README.md's "Europe scaling test" section, for the same class of file). */
export async function* streamGeoJSONSeq(path: string): AsyncGenerator<Feature> {
  for await (const record of streamGeoJSONSeqRecords(path)) {
    yield JSON.parse(record.toString("utf8")) as Feature;
  }
}

/** `streamGeoJSONSeq` without the parse: each record's raw UTF-8 bytes,
 * trimmed, so a caller can decide from a cheap peek (`peekFeatureId`,
 * `splitOsmiumFeature`, `peekLeadingProperties`) whether a record is worth
 * a `JSON.parse` at all. A pass that only wants a few ids out of the whole
 * corpus then pays for parsing just those.
 *
 * A record that spans several reads is kept as a list of chunks and joined
 * once, when its end turns up. Growing a single carry buffer chunk by chunk
 * re-copies everything read so far on every 4MB read: a 196MB country
 * relation took 5.1s just to frame that way, against 0.3s joined once. */
export async function* streamGeoJSONSeqRecords(path: string): AsyncGenerator<Buffer> {
  const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024 });
  let pending: Buffer[] = [];

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    for (;;) {
      const idx = chunk.indexOf(RECORD_SEPARATOR, start);
      if (idx === -1) break;
      const piece = chunk.subarray(start, idx);
      const record = trimRecord(pending.length > 0 ? Buffer.concat([...pending, piece]) : piece);
      pending = [];
      if (record.length > 0) yield record;
      start = idx + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }

  const last = trimRecord(Buffer.concat(pending));
  if (last.length > 0) yield last;
}

function trimRecord(record: Buffer): Buffer {
  let start = 0;
  let end = record.length;
  while (start < end && record[start]! <= 0x20) start++;
  while (end > start && record[end - 1]! <= 0x20) end--;
  return record.subarray(start, end);
}

const OSMIUM_ID_PREFIX = Buffer.from('{"type":"Feature","id":"');
const OSMIUM_GEOMETRY_KEY = Buffer.from(',"geometry":');
const OSMIUM_PROPERTIES_KEY = ',"properties":';

/** The id `osmium export --add-unique-id` writes, read straight off the
 * record's fixed `{"type":"Feature","id":"..."` prefix without parsing
 * anything. Undefined when the record isn't shaped that way; the caller
 * then has to parse it to find out. */
export function peekFeatureId(record: Buffer): string | undefined {
  const end = osmiumIdEnd(record);
  return end === undefined ? undefined : record.toString("utf8", OSMIUM_ID_PREFIX.length, end);
}

function osmiumIdEnd(record: Buffer): number | undefined {
  if (record.compare(OSMIUM_ID_PREFIX, 0, OSMIUM_ID_PREFIX.length, 0, OSMIUM_ID_PREFIX.length) !== 0) return undefined;
  const end = record.indexOf(0x22, OSMIUM_ID_PREFIX.length); // osmium ids are a letter plus digits, never escaped
  return end === -1 ? undefined : end;
}

export interface OsmiumFeatureParts {
  /** The geometry object's exact source text, ready to be written back out
   * without a parse/stringify round trip. */
  geometryJson: string;
  properties: Record<string, unknown> | null;
}

/** Splits an osmium record -- `{"type":"Feature","id":"...","geometry":
 * {...},"properties":{...}}`, always in that order -- into its geometry's
 * source text and its parsed properties, without parsing the geometry. A
 * geometry object holds nothing but brackets, numbers and its `"type"`
 * strings, none of which contain a bracket, so bracket depth alone finds
 * where it ends. Undefined for a record that isn't laid out that way. */
export function splitOsmiumFeature(record: Buffer): OsmiumFeatureParts | undefined {
  const idEnd = osmiumIdEnd(record);
  if (idEnd === undefined) return undefined;
  const geometryKey = idEnd + 1;
  if (record.compare(OSMIUM_GEOMETRY_KEY, 0, OSMIUM_GEOMETRY_KEY.length, geometryKey, geometryKey + OSMIUM_GEOMETRY_KEY.length) !== 0) {
    return undefined;
  }
  const geometryStart = geometryKey + OSMIUM_GEOMETRY_KEY.length;
  if (record[geometryStart] !== 0x7b) return undefined; // `"geometry":null`
  let depth = 0;
  let i = geometryStart;
  for (; i < record.length; i++) {
    const c = record[i]!;
    if (c === 0x7b || c === 0x5b) depth++;
    else if ((c === 0x7d || c === 0x5d) && --depth === 0) break;
  }
  if (i >= record.length || record[record.length - 1] !== 0x7d) return undefined;
  const geometryEnd = i + 1;
  const rest = record.toString("utf8", geometryEnd, record.length - 1); // without the feature's own closing brace
  if (!rest.startsWith(OSMIUM_PROPERTIES_KEY)) return undefined;
  return {
    geometryJson: record.toString("utf8", geometryStart, geometryEnd),
    properties: JSON.parse(rest.slice(OSMIUM_PROPERTIES_KEY.length)) as Record<string, unknown> | null,
  };
}

const LEADING_PROPERTIES_PREFIX = Buffer.from('{"type":"Feature","properties":');

/** The `properties` of a record that starts `{"type":"Feature",
 * "properties":{...}` -- the shape `prepare-world.ts` writes its cities in
 * -- parsed on their own, without the geometry that follows. Undefined for
 * any other layout. */
export function peekLeadingProperties(record: Buffer): Record<string, unknown> | undefined {
  const prefix = LEADING_PROPERTIES_PREFIX;
  if (record.compare(prefix, 0, prefix.length, 0, prefix.length) !== 0) return undefined;
  if (record[prefix.length] !== 0x7b) return undefined; // `"properties":null`
  // Unlike geometry, property values are arbitrary strings, so brackets
  // inside them have to be skipped.
  let depth = 0;
  let inString = false;
  for (let i = prefix.length; i < record.length; i++) {
    const c = record[i]!;
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x7b) {
      depth++;
    } else if (c === 0x7d && --depth === 0) {
      return JSON.parse(record.toString("utf8", prefix.length, i + 1)) as Record<string, unknown>;
    }
  }
  return undefined;
}
