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
      const directory = parseDirectory(buf, header.headerLength, header.width, header.height);
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
