import { openSync, readSync, closeSync, fstatSync } from "node:fs";

/**
 * A random-access byte source. This is what lets the reader honour Section
 * 1.2's goal 2 ("a reader MUST be able to answer a lookup by reading and
 * decompressing only a small, bounded part of the file"): a FileSource only
 * ever reads the bytes actually asked for, at the offset asked for.
 */
export interface RandomAccessSource {
  readonly size: number;
  readSync(offset: number, length: number): Uint8Array;
  close?(): void;
}

class BufferSource implements RandomAccessSource {
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get size(): number {
    return this.buf.length;
  }

  readSync(offset: number, length: number): Uint8Array {
    const end = Math.min(offset + length, this.buf.length);
    return this.buf.subarray(offset, Math.max(offset, end));
  }
}

class FileSource implements RandomAccessSource {
  private readonly fd: number;
  readonly size: number;

  constructor(path: string) {
    this.fd = openSync(path, "r");
    this.size = fstatSync(this.fd).size;
  }

  readSync(offset: number, length: number): Uint8Array {
    const clampedLength = Math.max(0, Math.min(length, this.size - offset));
    const buf = Buffer.alloc(clampedLength);
    if (clampedLength > 0) {
      readSync(this.fd, buf, 0, clampedLength, offset);
    }
    return buf;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Opens a CGEODATA source: a file path for lazy on-demand reads, or an
 * in-memory buffer (e.g. from `fetch()` in a browser, or a test fixture). */
export function openSource(input: string | Uint8Array): RandomAccessSource {
  return typeof input === "string" ? new FileSource(input) : new BufferSource(input);
}
