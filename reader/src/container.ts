import type { RandomAccessSource } from "./source.ts";
import { parseHeader, type CGeoDataHeader } from "./header.ts";
import { parseDirectory, type CGeoDataDirectory } from "./directory.ts";
import { IncompleteBufferError } from "./varint.ts";

/**
 * Reads the header and directory (Sections 5-6), which per the spec are
 * "small and expected to be read once and kept in memory". Since the
 * directory's size depends on the header (W x H entries) and the header's
 * size depends on the attribution string length, this starts with a small
 * probe read and grows it until both parse cleanly -- never reading more of
 * the file than these two small, fixed-at-load-time sections actually need.
 */
export function readHeaderAndDirectory(source: RandomAccessSource): {
	header: CGeoDataHeader;
	directory: CGeoDataDirectory;
} {
	let size = Math.min(1024, source.size);
	for (;;) {
		const buf = source.readSync(0, size);
		try {
			const header = parseHeader(buf);
			checkDirectoryFits(header, source.size);
			const directory = parseDirectory(
				buf,
				header.headerLength,
				header.width,
				header.height,
			);
			checkSectionsWithinFile(directory, source.size);
			return { header, directory };
		} catch (err) {
			if (err instanceof IncompleteBufferError && size < source.size) {
				size = Math.min(size * 4, source.size);
				continue;
			}
			throw err;
		}
	}
}

/**
 * The cheap half of Section 11's "chunk offsets and lengths MUST lie
 * within the file", checkable from the header alone: the directory is
 * `place_table_length` plus one varint per chunk, every varint at least
 * one byte, so a header claiming more chunks than the file has bytes
 * left cannot be well formed.
 *
 * Checking this *before* parsing matters: `width_exp` and `height_exp` of
 * 15 are both legal (Section 5) and claim 2^30 chunks, so without this a
 * ~1 MiB crafted file sends the growing read above through a dozen passes
 * that each allocate a 2^30-entry array -- ~1 s of CPU and a few hundred
 * MB of RSS -- before finally failing on a short varint.
 */
function checkDirectoryFits(header: CGeoDataHeader, fileSize: number): void {
	const chunkCount = header.width * header.height;
	const afterHeader = fileSize - header.headerLength;
	if (chunkCount + 1 > afterHeader) {
		throw new Error(
			`header's ${header.width}x${header.height} grid needs a directory of at least ${chunkCount + 1} bytes, but only ${afterHeader} follow the header in this ${fileSize}-byte file`,
		);
	}
}

/** The rest of Section 11's bounds check. Chunk offsets are the running
 * sum of the lengths from the place table's end, so the last chunk's end
 * bounds every chunk's. */
function checkSectionsWithinFile(
	directory: CGeoDataDirectory,
	fileSize: number,
): void {
	const { placeTableStart, placeTableLength, chunkOffsets, chunkLengths } =
		directory;
	const placeTableEnd = placeTableStart + placeTableLength;
	if (placeTableEnd > fileSize) {
		throw new Error(
			`place table runs to byte ${placeTableEnd}, past the end of the ${fileSize}-byte file`,
		);
	}
	const last = chunkLengths.length - 1;
	const chunksEnd =
		last < 0 ? placeTableEnd : chunkOffsets[last]! + chunkLengths[last]!;
	if (chunksEnd > fileSize) {
		throw new Error(
			`chunks run to byte ${chunksEnd}, past the end of the ${fileSize}-byte file`,
		);
	}
}
