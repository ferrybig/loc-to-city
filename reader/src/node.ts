/**
 * The Node.js side of the reader: files on disk, and zlib. Everything
 * else (`CGeoDataReader` and friends) is platform-neutral and lives in the
 * package's main entry.
 *
 * @module @ferrybig/cgeodata-reader/node
 */
import { close, fstat, open, read } from "node:fs";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { CGeoDataError } from "./errors.ts";
import type { Inflater } from "./inflate.ts";
import { CGeoDataReader, type OpenOptions } from "./reader.ts";
import type { ByteSource } from "./source.ts";

const openAsync = promisify(open);
const fstatAsync = promisify(fstat);
const closeAsync = promisify(close);

/** Closes the descriptor of a `FileSource` that was garbage collected
 * without `close()`, instead of leaking it. */
const unclosed = new FinalizationRegistry<number>((fd) => close(fd, () => {}));

/**
 * A file on disk as a `ByteSource`: each read reads just that range, on
 * libuv's thread pool.
 *
 * Holds a plain file descriptor rather than a `fs.promises` `FileHandle`:
 * Node.js treats a `FileHandle` that is garbage collected without being
 * closed as an uncaught error, which would take a whole server down over
 * a forgotten `close()`. A forgotten `FileSource` is closed when it's
 * collected instead.
 */
export class FileSource implements ByteSource {
	private fd: number;
	readonly size: number;
	readonly name: string;

	private constructor(fd: number, size: number, path: string) {
		this.fd = fd;
		this.size = size;
		this.name = path;
		unclosed.register(this, fd, this);
	}

	/** Opens the file at `path` for reading. */
	static async open(path: string): Promise<FileSource> {
		const fd = await openAsync(path, "r");
		try {
			return new FileSource(fd, (await fstatAsync(fd)).size, path);
		} catch (error) {
			await closeAsync(fd);
			throw error;
		}
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		const wanted = Math.max(0, Math.min(length, this.size - offset));
		const buffer = new Uint8Array(wanted);
		if (wanted > 0) {
			// The byte count has to be checked: a short read (the file being
			// truncated after it was opened) would otherwise leave the tail of
			// `buffer` zeroed, and zeros parse as perfectly good varints -- a
			// silently wrong answer instead of an error.
			const bytesRead = await new Promise<number>((resolve, reject) =>
				read(this.fd, buffer, 0, wanted, offset, (error, bytesRead) =>
					error ? reject(error) : resolve(bytesRead),
				),
			);
			if (bytesRead !== wanted) {
				throw new CGeoDataError(
					`short read: wanted ${wanted} bytes at offset ${offset} of ${this.name}, got ${bytesRead}`,
				);
			}
		}
		return buffer;
	}

	async close(): Promise<void> {
		if (this.fd < 0) return;
		const fd = this.fd;
		this.fd = -1;
		unclosed.unregister(this);
		await closeAsync(fd);
	}
}

/**
 * Node's zlib, on the calling thread. Deliberately not zlib's async API:
 * measured on a worldwide file, handing blocks to libuv's thread pool made
 * a burst of zoomed-out map tiles 15-40% slower and cold lookups ~30%
 * slower, while barely shortening the longest event-loop stall -- parsing
 * a decoded chunk costs more than inflating it, and that stays on this
 * thread either way. What keeps the event loop responsive is that every
 * chunk read (`FileSource.read`) is asynchronous, so the loop gets a turn
 * between chunks: a stall is one chunk's decode (~25 ms for the largest
 * chunk of a worldwide file, most far less), not a whole tile's or batch's.
 */
export const nodeInflater: Inflater = (compressed, maxOutputLength) =>
	inflateSync(compressed, { maxOutputLength });

/** Where a search index for `binPath` conventionally lives, and where
 * `openFile()` looks for one: `data/03-final/world.bin` →
 * `data/03-final/world.search-index.bin`. */
export function searchIndexPathFor(binPath: string): string {
	return `${binPath.replace(/\.bin$/, "")}.search-index.bin`;
}

/** Where a locate index for `binPath` conventionally lives, and where
 * `openFile()` looks for one: `data/03-final/world.bin` →
 * `data/03-final/world.locate-index.bin`. */
export function locateIndexPathFor(binPath: string): string {
	return `${binPath.replace(/\.bin$/, "")}.locate-index.bin`;
}

/**
 * Opens a `.bin` file from disk, reading only what each lookup needs, with
 * Node's zlib as its inflater.
 *
 * The search and locate indexes next to it (`searchIndexPathFor`,
 * `locateIndexPathFor`) are used automatically when they exist: each is
 * opened on the first `search()` / `locate()` that can use it. One that
 * exists but doesn't belong to this file (built from an older build of
 * it, say) makes those calls reject with a `CGeoDataIndexMismatchError`
 * naming it, rather than silently falling back to a slow scan; rebuild or
 * delete it. `options.searchIndex` / `options.locateIndex` override the
 * lookup next to the file.
 *
 * @example
 * ```ts
 * const reader = await openFile("data/world.bin");
 * const { city } = await reader.query(52.37, 4.9);
 * city?.internationalName; // "Amsterdam"
 * await reader.close();
 * ```
 */
export async function openFile(
	path: string,
	options: OpenOptions = {},
): Promise<CGeoDataReader> {
	return CGeoDataReader.open(await FileSource.open(path), {
		inflater: nodeInflater,
		searchIndex: () => openIfExists(searchIndexPathFor(path)),
		locateIndex: () => openIfExists(locateIndexPathFor(path)),
		...options,
	});
}

async function openIfExists(path: string): Promise<FileSource | undefined> {
	try {
		return await FileSource.open(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
