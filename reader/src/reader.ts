import { openSource, type RandomAccessSource } from "./source.js";
import { readHeaderAndDirectory } from "./container.js";
import type { CGeoDataHeader } from "./header.js";
import type { CGeoDataDirectory } from "./directory.js";
import {
  parsePlaceTable,
  resolveIdentifier,
  readNameEntry,
  type PlaceTableInfo,
} from "./placeTable.js";
import { parseChunk, type ChunkRecords } from "./chunk.js";
import { mortonEncode, mortonDecode, shiftRight } from "./morton.js";
import { safeInflate } from "./zlibUtil.js";
import { chunkBoundingBox, cellBoundingBox, type BoundingBox } from "./cellBounds.js";

export interface QueryResult {
  country: string[] | null;
  region: string[] | null;
  city: string[] | null;
  /**
   * The lat/lon rectangle this result is valid for -- every coordinate in
   * this box resolves to the exact same result as the one just queried.
   * Callers doing many nearby lookups (e.g. a tile renderer sampling a
   * grid of pixels) can cache on this to skip repeat queries that would
   * land in the same underlying cell. It's as tight as the cell that
   * produced the result when one was matched; for "unknown" results it's
   * the whole empty chunk when possible, otherwise the single finest-grain
   * cell containing the query point (always correct, just not maximal --
   * the actual empty region in a gap between records isn't generally a
   * plain rectangle, so this doesn't try to find its full extent).
   */
  boundingBox: BoundingBox;
}

export class CGeoDataReader {
  private readonly chunkCache = new Map<number, ChunkRecords>();
  private readonly nameCache = new Map<number, string[]>();

  private constructor(
    private readonly source: RandomAccessSource,
    readonly header: CGeoDataHeader,
    private readonly directory: CGeoDataDirectory,
    private readonly placeTable: PlaceTableInfo,
  ) {}

  static open(input: string | Uint8Array): CGeoDataReader {
    const source = openSource(input);
    const { header, directory } = readHeaderAndDirectory(source);
    const placeTable = parsePlaceTable(
      source,
      directory.placeTableStart,
      directory.placeTableLength,
      header.keyframeExp,
    );
    return new CGeoDataReader(source, header, directory, placeTable);
  }

  close(): void {
    this.source.close?.();
  }

  /** Section 9's lookup procedure. */
  query(lat: number, lon: number): QueryResult {
    if (!(lat >= -90 && lat < 90)) {
      throw new RangeError(`latitude ${lat} is outside the valid range [-90, 90)`);
    }
    if (!(lon >= -180 && lon < 180)) {
      throw new RangeError(`longitude ${lon} is outside the valid range [-180, 180)`);
    }

    const { width: W, height: H, maxDepth: D } = this.header;
    const NX = W * 2 ** D;
    const NY = H * 2 ** D;

    let gx = Math.floor(((lon + 180) / 360) * NX);
    let gy = Math.floor(((lat + 90) / 180) * NY);
    gx = Math.min(Math.max(gx, 0), NX - 1);
    gy = Math.min(Math.max(gy, 0), NY - 1);

    const cellsPerChunkSide = 2 ** D;
    const c = Math.floor(gx / cellsPerChunkSide);
    const r = Math.floor(gy / cellsPerChunkSide);
    const x = gx - c * cellsPerChunkSide;
    const y = gy - r * cellsPerChunkSide;
    const chunkIndex = r * W + c;
    const chunkBox = chunkBoundingBox(c, r, W, H);

    const chunk = this.getChunk(chunkIndex);
    if (!chunk) return unknownResult(chunkBox); // whole chunk is empty

    const q = mortonEncode(x, y, D);
    const j = bisectRightMinusOne(chunk.codes, q);
    // Neither of these two "no record covers this" cases can recover the
    // gap's true extent without redoing the encoder's own subdivision
    // work, so fall back to the single finest cell around the query point.
    const finestCellBox = () => cellBoundingBox(chunkBox, x, y, D);
    if (j < 0) return unknownResult(finestCellBox());

    const depth = chunk.depths[j]!;
    const shift = 2 * (D - depth);
    const code = chunk.codes[j]!;
    if (shiftRight(q, shift) !== shiftRight(code, shift)) {
      return unknownResult(finestCellBox()); // gap between records
    }

    // A real record matched: recover its exact cell (Section 8.1) for a
    // tight, correct bounding box, whether or not it resolves to a place.
    const { x: fullX, y: fullY } = mortonDecode(code, D);
    const cellX = shiftRight(fullX, D - depth);
    const cellY = shiftRight(fullY, D - depth);
    const matchedCellBox = cellBoundingBox(chunkBox, cellX, cellY, depth);

    const k = chunk.paletteIndices[j]!;
    if (k === 0) return unknownResult(matchedCellBox);

    const placeId = chunk.palette[k - 1]!;
    return this.resolveNames(placeId, matchedCellBox);
  }

  private getChunk(index: number): ChunkRecords | undefined {
    const length = this.directory.chunkLengths[index]!;
    if (length === 0) return undefined;
    const cached = this.chunkCache.get(index);
    if (cached) return cached;
    const compressed = this.source.readSync(this.directory.chunkOffsets[index]!, length);
    const inflated = safeInflate(compressed);
    const chunk = parseChunk(inflated, this.header.maxDepth);
    this.chunkCache.set(index, chunk);
    return chunk;
  }

  private getName(globalId: number): string[] {
    const cached = this.nameCache.get(globalId);
    if (cached) return cached;
    const names = readNameEntry(this.source, this.placeTable, globalId);
    this.nameCache.set(globalId, names);
    return names;
  }

  private resolveNames(placeId: number, boundingBox: BoundingBox): QueryResult {
    const resolved = resolveIdentifier(this.placeTable, placeId);
    const C = this.placeTable.countryCount;
    const R = this.placeTable.totalRegions;

    const country = this.getName(resolved.countryId);
    const region = "regionId" in resolved ? this.getName(C + resolved.regionId) : null;
    const city = resolved.level === "city" ? this.getName(C + R + resolved.cityId) : null;

    return { country, region, city, boundingBox };
  }
}

function unknownResult(boundingBox: BoundingBox): QueryResult {
  return { country: null, region: null, city: null, boundingBox };
}

/** bisect_right(sorted, value) - 1, per Section 9 step 6. */
function bisectRightMinusOne(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
