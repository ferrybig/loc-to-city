import { writeVarint } from "@ferrybig/cgeodata-reader/format";

export interface WriteFileOptions {
  /** Section 5's version field: 1 or 2, matching how the chunks were
   * encoded. */
  formatVersion: number;
  attribution: string;
  widthExp: number;
  heightExp: number;
  maxDepth: number;
  keyframeExp: number;
  countryCount: number;
  regionCounts: number[];
  cityCounts: number[];
  /** All K name-block lengths; only the first K-1 are stored (the last is
   * implied by place_table_length, Section 7.3). */
  nameBlockLengths: number[];
  nameBlockBytes: Buffer[];
  /** W*H entries, row-major; null = empty chunk (Section 6.2). */
  chunkBytes: (Buffer | null)[];
}

function concatVarints(values: number[]): Buffer {
  return Buffer.concat(values.map((v) => Buffer.from(writeVarint(v))));
}

/** Assembles a complete CGEODATA file (Section 4). */
export function writeCGeoDataFile(opts: WriteFileOptions): Buffer {
  const placeTablePrefix = Buffer.concat([
    Buffer.from(writeVarint(opts.countryCount)),
    concatVarints(opts.regionCounts),
    concatVarints(opts.cityCounts),
    concatVarints(opts.nameBlockLengths.slice(0, -1)),
  ]);
  return assembleCGeoDataFile({ ...opts, placeTable: Buffer.concat([placeTablePrefix, ...opts.nameBlockBytes]) });
}

/** What `assembleCGeoDataFile` needs: the header fields, the place table
 * as finished bytes (Section 7), and the chunk blocks. */
export interface AssembleFileOptions {
  formatVersion: number;
  attribution: string;
  widthExp: number;
  heightExp: number;
  maxDepth: number;
  keyframeExp: number;
  placeTable: Buffer;
  /** W*H entries, row-major; null = empty chunk (Section 6.2). */
  chunkBytes: (Buffer | null)[];
}

/** Assembles a CGEODATA file from an already-built place table. */
export function assembleCGeoDataFile(opts: AssembleFileOptions): Buffer {
  const signature = Buffer.from("CGEODATA", "ascii");
  const attributionBytes = Buffer.from(opts.attribution, "utf8");

  const header = Buffer.concat([
    signature,
    Buffer.from(writeVarint(opts.formatVersion)),
    Buffer.from(writeVarint(attributionBytes.length)),
    attributionBytes,
    Buffer.from([opts.widthExp, opts.heightExp, opts.maxDepth, opts.keyframeExp]),
  ]);

  const { placeTable } = opts;
  const chunkLengths = opts.chunkBytes.map((block) => (block ? block.length : 0));
  const directory = Buffer.concat([Buffer.from(writeVarint(placeTable.length)), concatVarints(chunkLengths)]);

  const chunks = opts.chunkBytes.filter((block): block is Buffer => block !== null);

  return Buffer.concat([header, directory, placeTable, ...chunks]);
}
