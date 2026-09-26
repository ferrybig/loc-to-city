/**
 * Place location index (Appendix C of binary-format.md): a sidecar file
 * that stores one representative cell per place, so that
 * `CGeoDataReader.locate()` is a single read of a few bytes instead of a
 * scan through every chunk.
 *
 * The file is CGEODATA kind 2: the 8-byte "CGEODATA" signature and a
 * `version` varint (kind × 16 + version = 32), then an FNV-1a 64-bit
 * checksum over the source's header, directory and place table, the
 * entry width, the place count, and one fixed-width entry per place id.
 * Entries are raw, so an entry is found by multiplying its id by the
 * entry width.
 *
 * The representative cell of a place is defined in Section C.3, and
 * `locate()` without an index computes exactly the same cell by scanning
 * (`computeLocateCell`). The index is only a precomputed copy of it.
 */
import type { CGeoDataHeader } from "./header.js";
import { mortonDecode, mortonEncode, shiftRight } from "./morton.js";
import type { CGeoDataReader } from "./reader.js";
import { openSource, type RandomAccessSource } from "./source.js";
import { readVarint, writeVarint } from "./varint.js";

// "CGEODATA" — same signature as the main data file.
const SIGNATURE = Uint8Array.from([0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]);
const KIND_LOCATE_INDEX = 2;
const FORMAT_VERSION = 0; // kind=2, version=0 → stored varint = 32 (0x20)
const STORED_VERSION = KIND_LOCATE_INDEX * 16 + FORMAT_VERSION;
/** Entries are at most 48 bits, so they are exact JavaScript integers
 * (Section C.2). */
const MAX_ENTRY_WIDTH = 6;

type Grid = Pick<CGeoDataHeader, "widthExp" | "heightExp" | "maxDepth">;

/** One cell as an index entry names it (Section C.2): a cell of a chunk,
 * addressed like a chunk record (Section 8.4) -- `code` is the stored
 * `2 × max_depth`-bit Morton code, `depth` the cell's depth. */
export interface LocateCell {
	chunkIndex: number;
	code: number;
	depth: number;
}

// ── Entries (Section C.2) ─────────────────────────────────────────────────────

/** `ceil((width_exp + height_exp + 2 × max_depth + 1) / 8)`: enough bytes
 * for a depth-`max_depth` cell plus its marker bit. */
export function locateEntryWidth(grid: Grid): number {
	return Math.ceil((grid.widthExp + grid.heightExp + 2 * grid.maxDepth + 1) / 8);
}

/** The entry for `cell`, or `0` ("no geometry") for null. */
export function encodeLocateEntry(cell: LocateCell | null, grid: Grid): number {
	if (!cell) return 0;
	const chunkBits = grid.widthExp + grid.heightExp;
	const { depth } = cell;
	const localCode = shiftRight(cell.code, 2 * (grid.maxDepth - depth));
	return 2 ** (chunkBits + 2 * depth) + cell.chunkIndex * 4 ** depth + localCode;
}

/** Inverse of `encodeLocateEntry`: null for `0`, and an error for a value
 * whose marker bit doesn't sit at a valid depth. */
export function decodeLocateEntry(value: number, grid: Grid): LocateCell | null {
	if (value === 0) return null;
	const chunkBits = grid.widthExp + grid.heightExp;
	let top = 0;
	while (2 ** (top + 1) <= value) top++;
	const twiceDepth = top - chunkBits;
	if (twiceDepth < 0 || twiceDepth % 2 !== 0 || twiceDepth > 2 * grid.maxDepth) {
		throw new Error(`locate index entry ${value} does not name a cell of this file`);
	}
	const depth = twiceDepth / 2;
	const rest = value - 2 ** top;
	const chunkIndex = Math.floor(rest / 4 ** depth);
	const localCode = rest - chunkIndex * 4 ** depth;
	return { chunkIndex, depth, code: localCode * 4 ** (grid.maxDepth - depth) };
}

// ── Representative cell (Section C.3) ─────────────────────────────────────────

/**
 * Record cells in global full-precision cell coordinates -- Section 9's
 * `gx`/`gy` grid, `W × 2^D` columns by `H × 2^D` rows. Cell `i` covers
 * columns `gx[i] .. gx[i] + 2^(D - depth[i]) - 1` and the same run of
 * rows from `gy[i]`.
 */
export interface CellList {
	gx: Uint32Array;
	gy: Uint32Array;
	depth: Uint8Array;
}

/** Adds chunk `chunkIndex`'s record `(code, depth)` to `cells` at `pos`. */
function putRecordCell(
	cells: CellList,
	pos: number,
	chunkIndex: number,
	code: number,
	depth: number,
	header: CGeoDataHeader,
): void {
	const D = header.maxDepth;
	const { x, y } = mortonDecode(code, D);
	cells.gx[pos] = (chunkIndex % header.width) * 2 ** D + x;
	cells.gy[pos] = Math.floor(chunkIndex / header.width) * 2 ** D + y;
	cells.depth[pos] = depth;
}

/**
 * Throws unless every intermediate value of Section C.3 is an exact
 * JavaScript integer for this grid: entries of at most 48 bits and squared
 * distances below 2^53. Holds for every grid a worldwide build would use.
 */
function checkGrid(header: CGeoDataHeader): void {
	const width = locateEntryWidth(header);
	if (width > MAX_ENTRY_WIDTH) {
		throw new Error(
			`a locate index needs ${width}-byte entries for this grid; at most ${MAX_ENTRY_WIDTH} are supported`,
		);
	}
	const { ax, ay } = distanceScale(header);
	const nx = header.width * 2 ** header.maxDepth;
	const ny = header.height * 2 ** header.maxDepth;
	if ((ax * nx) ** 2 + (ay * ny) ** 2 > Number.MAX_SAFE_INTEGER) {
		throw new Error("this file's grid is too fine for a locate index");
	}
}

/** Per-axis factors that make squared distances proportional to squared
 * distances in degrees: a cell is `360 / NX` wide and `180 / NY` high, a
 * `2H : W` ratio, reduced so that the smaller factor is 1. */
function distanceScale(header: CGeoDataHeader): { ax: number; ay: number } {
	const g = Math.min(2 * header.height, header.width);
	return { ax: (2 * header.height) / g, ay: header.width / g };
}

/**
 * Step 2 of Section C.3 for one axis, in half-cell units: the sum
 * `lo + hi` of the weighted median's two bounds. `keys` holds
 * `centre × 64 + depth` per cell -- centre in half-cells (`2 × g + size`),
 * packed with the depth so a plain numeric sort orders by centre -- and is
 * sorted in place.
 */
function medianSum(keys: Float64Array, total: number, maxDepth: number): number {
	keys.sort();
	let cumulative = 0;
	let i = 0;
	while (i < keys.length) {
		const centre = Math.floor(keys[i]! / 64);
		for (; i < keys.length && Math.floor(keys[i]! / 64) === centre; i++) {
			cumulative += 4 ** (maxDepth - (keys[i]! % 64));
		}
		if (2 * cumulative > total) return 2 * centre;
		// Exactly half the weight is at or below `centre`, so the rest is
		// above it and the median is midway to the next centre.
		if (2 * cumulative === total) return centre + Math.floor(keys[i]! / 64);
	}
	throw new Error("unreachable: weights did not add up to their total");
}

/**
 * The representative cell of Section C.3 for the cells `start .. end - 1`
 * of `cells`: the full-precision cell nearest to the per-axis weighted
 * median of the cells' centres, among the cells themselves. Returned in
 * global full-precision coordinates; undefined for an empty range.
 */
export function representativeCell(
	cells: CellList,
	start: number,
	end: number,
	header: CGeoDataHeader,
): { gx: number; gy: number } | undefined {
	if (end <= start) return undefined;
	const D = header.maxDepth;
	const xKeys = new Float64Array(end - start);
	const yKeys = new Float64Array(end - start);
	let total = 0;
	for (let i = start; i < end; i++) {
		const depth = cells.depth[i]!;
		const size = 2 ** (D - depth);
		xKeys[i - start] = (2 * cells.gx[i]! + size) * 64 + depth;
		yKeys[i - start] = (2 * cells.gy[i]! + size) * 64 + depth;
		total += size * size;
	}
	// The median point, as the full-precision cell containing it.
	const fx = Math.floor(medianSum(xKeys, total, D) / 4);
	const fy = Math.floor(medianSum(yKeys, total, D) / 4);

	// Nearest full-precision cell inside one of the cells; the median cell
	// itself when it is inside one (distance 0, and cells don't overlap).
	const { ax, ay } = distanceScale(header);
	let bestDistance = Infinity;
	let bx = 0;
	let by = 0;
	for (let i = start; i < end; i++) {
		const size = 2 ** (D - cells.depth[i]!);
		const x0 = cells.gx[i]!;
		const y0 = cells.gy[i]!;
		const cx = Math.min(Math.max(fx, x0), x0 + size - 1);
		const cy = Math.min(Math.max(fy, y0), y0 + size - 1);
		const dx = (cx - fx) * ax;
		const dy = (cy - fy) * ay;
		const distance = dx * dx + dy * dy;
		if (
			distance < bestDistance ||
			(distance === bestDistance && (cy < by || (cy === by && cx < bx)))
		) {
			bestDistance = distance;
			bx = cx;
			by = cy;
			if (distance === 0) break;
		}
	}
	return { gx: bx, gy: by };
}

/** A full-precision cell in global coordinates, as the chunk cell an
 * entry names. */
function toLocateCell(gx: number, gy: number, header: CGeoDataHeader): LocateCell {
	const D = header.maxDepth;
	const side = 2 ** D;
	const c = Math.floor(gx / side);
	const r = Math.floor(gy / side);
	return {
		chunkIndex: r * header.width + c,
		code: mortonEncode(gx - c * side, gy - r * side, D),
		depth: D,
	};
}

function inRanges(id: number, ranges: readonly (readonly [number, number])[]): boolean {
	for (const [lo, hi] of ranges) if (id >= lo && id < hi) return true;
	return false;
}

/**
 * Section C.3 for one place, straight from the chunks: collects the cells
 * of every record attributed to `id` or a place under it, then picks the
 * representative cell. This is what `locate()` does without an index,
 * and it reads every non-empty chunk.
 */
export function computeLocateCell(reader: CGeoDataReader, id: number): LocateCell | null {
	const { header } = reader;
	checkGrid(header);
	const ranges = reader.subtreeIdRanges(id);
	const found: Array<[chunkIndex: number, code: number, depth: number]> = [];
	const chunkCount = reader.directory.chunkLengths.length;
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const chunk = reader.chunk(chunkIndex);
		if (!chunk) continue;
		// wanted[k]: whether palette index k is one of the place's.
		const wanted = new Uint8Array(chunk.palette.length + 1);
		let any = false;
		for (let k = 1; k <= chunk.palette.length; k++) {
			if (!inRanges(chunk.palette[k - 1]!, ranges)) continue;
			wanted[k] = 1;
			any = true;
		}
		if (!any) continue;
		for (let j = 0; j < chunk.codes.length; j++) {
			if (wanted[chunk.paletteIndices[j]!]) {
				found.push([chunkIndex, chunk.codes[j]!, chunk.depths[j]!]);
			}
		}
	}
	const cells: CellList = {
		gx: new Uint32Array(found.length),
		gy: new Uint32Array(found.length),
		depth: new Uint8Array(found.length),
	};
	found.forEach(([chunkIndex, code, depth], i) => {
		putRecordCell(cells, i, chunkIndex, code, depth, header);
	});
	const best = representativeCell(cells, 0, found.length, header);
	return best ? toLocateCell(best.gx, best.gy, header) : null;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export interface BuildLocateIndexOptions {
	/**
	 * Roughly how many records to hold in memory at once. Countries are
	 * processed in batches whose records add up to about this many (a single
	 * country bigger than this is its own batch), and every chunk a batch
	 * touches is decoded once per batch. At ~9 bytes a record plus sort
	 * buffers, the default keeps the builder under a few hundred MB.
	 */
	batchRecords?: number;
}

const DEFAULT_BATCH_RECORDS = 8_000_000;

/**
 * Builds a locate index (Section C.4) for every place in `reader` and
 * returns the file's bytes.
 *
 * Every place's cells are gathered from the chunks country by country.
 * Within a batch the places are laid out in depth-first order -- a
 * country, then each of its regions followed by that region's cities --
 * so the records of any place and everything under it are one contiguous
 * run, and each place is one call to `representativeCell`.
 */
export function buildLocateIndex(
	reader: CGeoDataReader,
	options: BuildLocateIndexOptions = {},
): Uint8Array {
	const { header } = reader;
	checkGrid(header);
	const budget = options.batchRecords ?? DEFAULT_BATCH_RECORDS;
	const { countries: C, regions: R, cities } = reader.placeCounts;
	const N = C + R + cities;
	const chunkCount = reader.directory.chunkLengths.length;

	// Depth-first place order, and where each country's run starts in it.
	const dfsOrder = new Uint32Array(N);
	const countryDfsStart = new Uint32Array(C + 1);
	const countryOf = new Uint32Array(N);
	let n = 0;
	for (let c = 0; c < C; c++) {
		countryDfsStart[c] = n;
		countryOf[c] = c;
		dfsOrder[n++] = c;
		const [lo, hi] = childRange(reader, c);
		for (let region = lo; region < hi; region++) {
			countryOf[region] = c;
			dfsOrder[n++] = region;
			const [cityLo, cityHi] = childRange(reader, region);
			for (let city = cityLo; city < cityHi; city++) {
				countryOf[city] = c;
				dfsOrder[n++] = city;
			}
		}
	}
	countryDfsStart[C] = n;

	// Pass 1: records per place, and which chunks each country appears in.
	const recordCount = new Uint32Array(N);
	const countryChunks: number[][] = Array.from({ length: C }, () => []);
	for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
		const chunk = reader.chunk(chunkIndex, { cache: false });
		if (!chunk) continue;
		for (const k of chunk.paletteIndices) {
			if (k === 0) continue;
			const placeId = chunk.palette[k - 1]!;
			recordCount[placeId] = recordCount[placeId]! + 1;
		}
		for (const placeId of chunk.palette) {
			const list = countryChunks[countryOf[placeId]!]!;
			if (list.at(-1) !== chunkIndex) list.push(chunkIndex);
		}
	}

	const entries = new Float64Array(N);
	const start = new Uint32Array(N); // a place's first slot in its batch
	const cursor = new Uint32Array(N);
	const subtreeEnd = new Uint32Array(N);

	let firstCountry = 0;
	while (firstCountry < C) {
		// Countries firstCountry .. lastCountry - 1 make up this batch.
		let lastCountry = firstCountry;
		let batchSize = 0;
		while (lastCountry < C) {
			let size = 0;
			for (let p = countryDfsStart[lastCountry]!; p < countryDfsStart[lastCountry + 1]!; p++) {
				size += recordCount[dfsOrder[p]!]!;
			}
			if (lastCountry > firstCountry && batchSize + size > budget) break;
			batchSize += size;
			lastCountry++;
		}

		// Slots in depth-first order; subtree ends follow from the layout.
		let slot = 0;
		for (let p = countryDfsStart[firstCountry]!; p < countryDfsStart[lastCountry]!; p++) {
			const placeId = dfsOrder[p]!;
			start[placeId] = cursor[placeId] = slot;
			slot += recordCount[placeId]!;
		}
		for (let c = firstCountry; c < lastCountry; c++) {
			const countryEnd = c + 1 < lastCountry ? start[c + 1]! : slot;
			subtreeEnd[c] = countryEnd;
			const [lo, hi] = childRange(reader, c);
			for (let region = lo; region < hi; region++) {
				subtreeEnd[region] = region + 1 < hi ? start[region + 1]! : countryEnd;
				const [cityLo, cityHi] = childRange(reader, region);
				for (let city = cityLo; city < cityHi; city++) {
					subtreeEnd[city] = start[city]! + recordCount[city]!;
				}
			}
		}

		// Pass 2: this batch's records, straight into their slots.
		const cells: CellList = {
			gx: new Uint32Array(slot),
			gy: new Uint32Array(slot),
			depth: new Uint8Array(slot),
		};
		const batchChunks = new Set<number>();
		for (let c = firstCountry; c < lastCountry; c++) {
			for (const chunkIndex of countryChunks[c]!) batchChunks.add(chunkIndex);
		}
		for (const chunkIndex of [...batchChunks].sort((a, b) => a - b)) {
			const chunk = reader.chunk(chunkIndex, { cache: false })!;
			const inBatch = chunk.palette.map((placeId) => {
				const c = countryOf[placeId]!;
				return c >= firstCountry && c < lastCountry;
			});
			for (let j = 0; j < chunk.codes.length; j++) {
				const k = chunk.paletteIndices[j]!;
				if (k === 0 || !inBatch[k - 1]) continue;
				const placeId = chunk.palette[k - 1]!;
				const pos = cursor[placeId]!;
				cursor[placeId] = pos + 1;
				putRecordCell(cells, pos, chunkIndex, chunk.codes[j]!, chunk.depths[j]!, header);
			}
		}

		for (let p = countryDfsStart[firstCountry]!; p < countryDfsStart[lastCountry]!; p++) {
			const placeId = dfsOrder[p]!;
			const best = representativeCell(cells, start[placeId]!, subtreeEnd[placeId]!, header);
			entries[placeId] = best
				? encodeLocateEntry(toLocateCell(best.gx, best.gy, header), header)
				: 0;
		}
		firstCountry = lastCountry;
	}

	return writeLocateIndex(reader.prefixChecksum(), locateEntryWidth(header), entries);
}

/** The ids of a country's regions or a region's cities: the second of
 * `subtreeIdRanges`, which lists the place itself first. */
function childRange(reader: CGeoDataReader, id: number): readonly [number, number] {
	return reader.subtreeIdRanges(id)[1] ?? [0, 0];
}

/** Section C.4's layout around already-computed entries. */
function writeLocateIndex(checksum: bigint, entryWidth: number, entries: ArrayLike<number>): Uint8Array {
	const versionBytes = writeVarint(STORED_VERSION);
	const countBytes = writeVarint(entries.length);
	const headerSize = SIGNATURE.length + versionBytes.length + 8 + 1 + countBytes.length;
	const out = new Uint8Array(headerSize + entries.length * entryWidth);
	const dv = new DataView(out.buffer);
	let off = 0;
	out.set(SIGNATURE, off); off += SIGNATURE.length;
	out.set(versionBytes, off); off += versionBytes.length;
	dv.setUint32(off, Number(checksum & 0xffffffffn), true); off += 4;
	dv.setUint32(off, Number(checksum >> 32n), true); off += 4;
	out[off++] = entryWidth;
	out.set(countBytes, off); off += countBytes.length;
	for (let i = 0; i < entries.length; i++) {
		let value = entries[i]!;
		for (let b = 0; b < entryWidth; b++) {
			out[off++] = value % 256;
			value = Math.floor(value / 256);
		}
	}
	return out;
}

// ── Reader (Sections C.4, C.5) ────────────────────────────────────────────────

/** Longest possible header: signature, a version varint, the u64
 * checksum, the entry width byte and a place count varint. */
const MAX_HEADER_LENGTH = SIGNATURE.length + 8 + 8 + 1 + 8;

/**
 * An open locate index file (Section C.4). Opening reads only the header,
 * and each `entry()` reads just that entry's bytes; nothing is cached, so
 * an idle index costs an open file handle and no memory.
 *
 * Opening does NOT verify the source checksum -- `CGeoDataReader`'s
 * `useLocateIndex()` does that against the file it's attached to.
 */
export class LocateIndex {
	private constructor(
		private readonly source: RandomAccessSource,
		private readonly entriesStart: number,
		readonly sourceChecksum: bigint,
		readonly entryWidth: number,
		readonly placeCount: number,
	) {}

	/** Opens a locate index from a file path (read on demand) or bytes.
	 * Validates signature, kind, version, entry width and length. */
	static open(input: string | Uint8Array): LocateIndex {
		const source = openSource(input);
		try {
			return LocateIndex.parseHeader(source);
		} catch (error) {
			source.close?.();
			throw error;
		}
	}

	private static parseHeader(source: RandomAccessSource): LocateIndex {
		const data = source.readSync(0, Math.min(MAX_HEADER_LENGTH, source.size));
		if (data.length < SIGNATURE.length + 1) {
			throw new Error("locate index file is too short to be valid");
		}
		for (let i = 0; i < SIGNATURE.length; i++) {
			if (data[i] !== SIGNATURE[i]) {
				throw new Error("not a CGEODATA locate index file (wrong magic bytes)");
			}
		}
		let off = SIGNATURE.length;

		const { value: storedVersion, bytesRead: vb } = readVarint(data, off);
		off += vb;
		const kind = storedVersion >> 4;
		const ver = storedVersion & 0xf;
		if (kind !== KIND_LOCATE_INDEX) {
			throw new Error(`not a locate index file (kind ${kind}, expected ${KIND_LOCATE_INDEX})`);
		}
		if (ver !== FORMAT_VERSION) {
			throw new Error(`unsupported locate index version ${ver} (expected ${FORMAT_VERSION})`);
		}

		if (data.length < off + 9) throw new Error("locate index file is too short for its header");
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const sourceChecksum = BigInt(dv.getUint32(off, true)) | (BigInt(dv.getUint32(off + 4, true)) << 32n);
		off += 8;

		const entryWidth = data[off++]!;
		if (entryWidth < 1 || entryWidth > MAX_ENTRY_WIDTH) {
			throw new Error(`unsupported locate index entry width ${entryWidth} (must be 1 to ${MAX_ENTRY_WIDTH})`);
		}

		const { value: placeCount, bytesRead: pb } = readVarint(data, off);
		off += pb;

		const expectedTotal = off + placeCount * entryWidth;
		if (source.size !== expectedTotal) {
			throw new Error(`locate index has ${source.size} bytes but header implies ${expectedTotal}`);
		}
		return new LocateIndex(source, off, sourceChecksum, entryWidth, placeCount);
	}

	close(): void {
		this.source.close?.();
	}

	/** Place `id`'s raw entry (Section C.2); `0` means no geometry. */
	entry(id: number): number {
		if (!Number.isInteger(id) || id < 0 || id >= this.placeCount) {
			throw new RangeError(`${id} is not a place id in this locate index (0 <= id < ${this.placeCount})`);
		}
		const bytes = this.source.readSync(this.entriesStart + id * this.entryWidth, this.entryWidth);
		let value = 0;
		for (let b = this.entryWidth - 1; b >= 0; b--) value = value * 256 + bytes[b]!;
		return value;
	}
}

/** Where a locate index for `binPath` conventionally lives, and where
 * `CGeoDataReader.open()` looks for one: `data/world.bin` →
 * `data/world.locate-index.bin`. */
export function locateIndexPathFor(binPath: string): string {
	return `${binPath.replace(/\.bin$/, "")}.locate-index.bin`;
}
