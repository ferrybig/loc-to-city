import { readVarint, readVarintList } from "./varint.ts";

export interface CGeoDataDirectory {
	placeTableStart: number;
	placeTableLength: number;
	/** Entry i is the compressed byte length of chunk i (0 = empty). */
	chunkLengths: number[];
	/** Entry i is the absolute file offset of chunk i (meaningless when
	 * chunkLengths[i] === 0). Precomputed per Section 6.3. */
	chunkOffsets: number[];
	directoryLength: number;
}

/**
 * Parses Section 6. `buf` MUST start at the file's absolute byte 0 (not a
 * sub-slice), since offsets computed here -- and returned in
 * `placeTableStart`/`chunkOffsets` -- are absolute file offsets. `offset` is
 * the header length, i.e. where the directory begins.
 */
export function parseDirectory(
	buf: Uint8Array,
	offset: number,
	width: number,
	height: number,
): CGeoDataDirectory {
	const start = offset;
	const { value: placeTableLength, bytesRead: b1 } = readVarint(buf, offset);
	offset += b1;

	const count = width * height;
	const { values: chunkLengths, bytesRead: b2 } = readVarintList(
		buf,
		offset,
		count,
	);
	offset += b2;

	const placeTableStart = offset;
	const chunksStart = placeTableStart + placeTableLength;
	const chunkOffsets: number[] = new Array(count);
	let running = chunksStart;
	for (let i = 0; i < count; i++) {
		chunkOffsets[i] = running;
		running += chunkLengths[i]!;
	}

	return {
		placeTableStart,
		placeTableLength,
		chunkLengths,
		chunkOffsets,
		directoryLength: offset - start,
	};
}
