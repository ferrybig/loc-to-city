/**
 * Rewrites a CGEODATA file's chunks in another format version, keeping
 * everything else -- the attribution, grid, place table and every
 * record -- as it is:
 *
 *   node compressor/src/transcode.ts <in.bin> <out.bin> [--format-version 1|2] [--check]
 *
 * Re-encoding a finished file takes seconds, where rebuilding it from
 * `data/02-resolved/` takes a worldwide compressor run. `--check` reads
 * every chunk of the output back and compares its records with the
 * input's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { type ChunkRecords, parseChunk, parseDirectory, parseHeader } from "@ferrybig/cgeodata-reader/format";
import { encodeChunkRecords, type FormatVersion } from "./chunkEncoder.ts";
import { assembleCGeoDataFile } from "./writer.ts";

/** The records of chunk `index` of the file `buf` (undefined when empty). */
function readChunk(
  buf: Uint8Array,
  header: ReturnType<typeof parseHeader>,
  directory: ReturnType<typeof parseDirectory>,
  index: number,
): ChunkRecords | undefined {
  const length = directory.chunkLengths[index]!;
  if (length === 0) return undefined;
  const offset = directory.chunkOffsets[index]!;
  const block = buf.subarray(offset, offset + length);
  return parseChunk(header.version >= 2 ? block : inflateSync(block), header.maxDepth, header.version);
}

/** `input` with its chunks re-encoded for `formatVersion`. */
export function transcode(input: Uint8Array, formatVersion: FormatVersion): Buffer {
  const header = parseHeader(input);
  const directory = parseDirectory(input, header.headerLength, header.width, header.height);
  const chunkBytes: (Buffer | null)[] = [];
  for (let i = 0; i < directory.chunkLengths.length; i++) {
    const chunk = readChunk(input, header, directory, i);
    chunkBytes.push(
      chunk
        ? encodeChunkRecords(chunk.palette, chunk.depths, chunk.paletteIndices, header.maxDepth, formatVersion)
        : null,
    );
  }
  const placeTable = Buffer.from(
    input.subarray(directory.placeTableStart, directory.placeTableStart + directory.placeTableLength),
  );
  return assembleCGeoDataFile({
    formatVersion,
    attribution: header.attribution,
    widthExp: header.widthExp,
    heightExp: header.heightExp,
    maxDepth: header.maxDepth,
    keyframeExp: header.keyframeExp,
    placeTable,
    chunkBytes,
  });
}

/** Throws unless every chunk of `a` and `b` holds the same records. */
export function compareChunks(a: Uint8Array, b: Uint8Array): void {
  const ha = parseHeader(a);
  const hb = parseHeader(b);
  const da = parseDirectory(a, ha.headerLength, ha.width, ha.height);
  const db = parseDirectory(b, hb.headerLength, hb.width, hb.height);
  for (let i = 0; i < da.chunkLengths.length; i++) {
    const ca = readChunk(a, ha, da, i);
    const cb = readChunk(b, hb, db, i);
    if (!ca || !cb) {
      if (ca || cb) throw new Error(`chunk ${i} is empty in only one file`);
      continue;
    }
    const same =
      ca.palette.length === cb.palette.length &&
      ca.palette.every((id, k) => id === cb.palette[k]) &&
      ca.depths.length === cb.depths.length &&
      ca.depths.every((d, k) => d === cb.depths[k] && ca.paletteIndices[k] === cb.paletteIndices[k]);
    if (!same) throw new Error(`chunk ${i}'s records differ`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const versionAt = args.indexOf("--format-version");
  const versionFlag = versionAt >= 0 ? args[versionAt + 1] : "2";
  const [inPath, outPath] = args.filter((arg, k) => !arg.startsWith("--") && (versionAt < 0 || k !== versionAt + 1));
  if (!inPath || !outPath || (versionFlag !== "1" && versionFlag !== "2")) {
    console.error("usage: transcode.ts <in.bin> <out.bin> [--format-version 1|2] [--check]");
    process.exitCode = 1;
    return;
  }
  const input = readFileSync(inPath);
  const startedAt = performance.now();
  const output = transcode(input, versionFlag === "1" ? 1 : 2);
  console.error(
    `wrote ${outPath}: ${input.length} -> ${output.length} bytes ` +
      `(${(((output.length - input.length) / input.length) * 100).toFixed(1)}%) in ` +
      `${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  writeFileSync(outPath, output);
  if (check) {
    compareChunks(input, output);
    console.error("every chunk's records match");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
