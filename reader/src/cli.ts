#!/usr/bin/env node
import { createInterface } from "node:readline";
import { CGeoDataReader, type QueryResult } from "./reader.js";

const USAGE = `usage: cgeodata-query <file.bin> <lat,lon> [<lat,lon> ...]
       cgeodata-query <file.bin> --stdin [< points.txt]

Resolves each point to its country/region/city, the lat/lon cell the
answer is valid for, and the chunk it was read from.

  --stdin  read one point per line instead of from the arguments.
           A line is "lat,lon" or "lat<TAB>lon"; anything after that
           (tab-separated) is echoed back on the output unchanged, so a
           batch can carry an id or name through. Blank lines and lines
           starting with # are skipped; a malformed line is reported on
           stderr and skipped rather than aborting the batch.
  --json   one JSON object per point (the query result plus the input
           lat/lon and any echoed text) instead of the readable form.`;

interface Point {
  lat: number;
  lon: number;
  /** Trailing text from a --stdin line, carried through to the output. */
  tag: string;
}

function parseCoordinate(text: string, what: "latitude" | "longitude"): number {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) throw new Error(`${what} ${JSON.stringify(text)} is not a number`);
  return value;
}

/** Accepts "lat,lon" as one field or lat and lon as two; anything after
 * the coordinates is the tag. */
function parsePoint(line: string): Point {
  const fields = line.split("\t");
  const first = fields[0] ?? "";
  if (first.includes(",")) {
    const [lat = "", lon = ""] = first.split(",", 2);
    return { lat: parseCoordinate(lat, "latitude"), lon: parseCoordinate(lon, "longitude"), tag: fields.slice(1).join("\t") };
  }
  if (fields.length < 2) throw new Error(`expected "lat,lon" or "lat<TAB>lon", got ${JSON.stringify(line)}`);
  return {
    lat: parseCoordinate(first, "latitude"),
    lon: parseCoordinate(fields[1] ?? "", "longitude"),
    tag: fields.slice(2).join("\t"),
  };
}

function names(list: string[] | null): string {
  return list === null ? "-" : list.join(" | ");
}

function formatReadable(point: Point, result: QueryResult, reader: CGeoDataReader): string {
  const { boundingBox: box, chunkIndex } = result;
  const col = chunkIndex % reader.header.width;
  const row = Math.floor(chunkIndex / reader.header.width);
  const head = point.tag ? `${point.lat},${point.lon}\t${point.tag}` : `${point.lat},${point.lon}`;
  return [
    head,
    `  country  ${names(result.country)}`,
    `  region   ${names(result.region)}`,
    `  city     ${names(result.city)}`,
    `  cell     lat ${box.minLat}..${box.maxLat}  lon ${box.minLon}..${box.maxLon}`,
    `  chunk    ${chunkIndex}  (col ${col}, row ${row} of ${reader.header.width}x${reader.header.height})`,
  ].join("\n");
}

function formatJson(point: Point, result: QueryResult): string {
  return JSON.stringify({
    lat: point.lat,
    lon: point.lon,
    ...(point.tag ? { tag: point.tag } : {}),
    country: result.country,
    region: result.region,
    city: result.city,
    boundingBox: result.boundingBox,
    chunkIndex: result.chunkIndex,
  });
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  const unknownFlag = [...flags].find((flag) => flag !== "--stdin" && flag !== "--json");
  if (unknownFlag) {
    process.stderr.write(`unknown flag ${unknownFlag}\n${USAGE}\n`);
    return 2;
  }

  const [file, ...pointArgs] = positional;
  const fromStdin = flags.has("--stdin");
  if (!file || (fromStdin ? pointArgs.length > 0 : pointArgs.length === 0)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const reader = CGeoDataReader.open(file);
  const json = flags.has("--json");
  const emit = (point: Point): void => {
    const result = reader.query(point.lat, point.lon);
    process.stdout.write((json ? formatJson(point, result) : formatReadable(point, result, reader)) + "\n");
  };

  try {
    if (!fromStdin) {
      for (const arg of pointArgs) emit(parsePoint(arg));
      return 0;
    }

    // Batch mode: a bad line is somebody's data problem, not a reason to
    // throw away the rest of a long run, so report it and keep going.
    let lineNumber = 0;
    let skipped = 0;
    for await (const raw of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      lineNumber++;
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      try {
        emit(parsePoint(line));
      } catch (err) {
        skipped++;
        process.stderr.write(`line ${lineNumber}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    if (skipped > 0) process.stderr.write(`skipped ${skipped} malformed line${skipped === 1 ? "" : "s"}\n`);
    return 0;
  } finally {
    reader.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
