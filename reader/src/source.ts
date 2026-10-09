/**
 * Where a reader gets its bytes from. This is what lets a reader honour
 * Section 1.2's goal 2 ("a reader MUST be able to answer a lookup by
 * reading and decompressing only a small, bounded part of the file"): a
 * source is only ever asked for the bytes a lookup needs.
 *
 * Reads are asynchronous so that a source can be anything that hands out
 * byte ranges: a file (`FileSource` in `./node.ts`), a `Blob` or `File`
 * in a browser, or bytes already in memory. Nothing here depends on
 * Node.js.
 */
export interface ByteSource {
	/** Total size in bytes. */
	readonly size: number;
	/** Shown in error messages about this source, e.g. a file path. */
	readonly name?: string;
	/**
	 * `length` bytes from `offset`, fewer only where the source ends. The
	 * returned bytes may be a view of the source's own memory, so a caller
	 * must not modify them.
	 */
	read(offset: number, length: number): Promise<Uint8Array>;
	/** Releases whatever the source holds open, if anything. */
	close?(): Promise<void> | void;
}

/** A source over bytes already in memory: a file read up front, or the
 * body of a `fetch()`. */
export class BytesSource implements ByteSource {
	private readonly bytes: Uint8Array;
	readonly name?: string;

	constructor(bytes: Uint8Array | ArrayBuffer, name?: string) {
		this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		if (name !== undefined) this.name = name;
	}

	get size(): number {
		return this.bytes.length;
	}

	read(offset: number, length: number): Promise<Uint8Array> {
		return Promise.resolve(this.readNow(offset, length));
	}

	/** `read()` without the promise: bytes in memory need no waiting. */
	readNow(offset: number, length: number): Uint8Array {
		const start = Math.min(offset, this.bytes.length);
		return this.bytes.subarray(
			start,
			Math.min(start + length, this.bytes.length),
		);
	}
}

/** A source over a `Blob` -- in a browser, a `File` the user picked --
 * reading each range as it's asked for, without loading the whole file. */
export class BlobSource implements ByteSource {
	private readonly blob: Blob;
	readonly name?: string;

	constructor(blob: Blob, name?: string) {
		this.blob = blob;
		const fileName = (blob as { name?: unknown }).name;
		const resolved =
			name ?? (typeof fileName === "string" ? fileName : undefined);
		if (resolved !== undefined) this.name = resolved;
	}

	get size(): number {
		return this.blob.size;
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		return new Uint8Array(
			await this.blob.slice(offset, offset + length).arrayBuffer(),
		);
	}
}

/** What `CGeoDataReader.open()` and the index classes accept as a file. */
export type SourceInput = ByteSource | Uint8Array | ArrayBuffer | Blob;

/** `input` as a `ByteSource`. */
export function toSource(input: SourceInput): ByteSource {
	if (input instanceof Uint8Array || input instanceof ArrayBuffer)
		return new BytesSource(input);
	if (typeof Blob !== "undefined" && input instanceof Blob)
		return new BlobSource(input);
	return input as ByteSource;
}
