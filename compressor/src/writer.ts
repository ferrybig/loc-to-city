import { writeVarint } from "@loc-to-city/reader/format";

export interface WriteFileOptions {
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
  const signature = Buffer.from("CGEODATA", "ascii");
  const attributionBytes = Buffer.from(opts.attribution, "utf8");

  const header = Buffer.concat([
    signature,
    Buffer.from(writeVarint(0)), // version
    Buffer.from(writeVarint(attributionBytes.length)),
    attributionBytes,
    Buffer.from([opts.widthExp, opts.heightExp, opts.maxDepth, opts.keyframeExp]),
  ]);

  const placeTablePrefix = Buffer.concat([
    Buffer.from(writeVarint(opts.countryCount)),
    concatVarints(opts.regionCounts),
    concatVarints(opts.cityCounts),
    concatVarints(opts.nameBlockLengths.slice(0, -1)),
  ]);
  const placeTable = Buffer.concat([placeTablePrefix, ...opts.nameBlockBytes]);

  const chunkLengths = opts.chunkBytes.map((block) => (block ? block.length : 0));
  const directory = Buffer.concat([Buffer.from(writeVarint(placeTable.length)), concatVarints(chunkLengths)]);

  const chunks = opts.chunkBytes.filter((block): block is Buffer => block !== null);

  return Buffer.concat([header, directory, placeTable, ...chunks]);
}
