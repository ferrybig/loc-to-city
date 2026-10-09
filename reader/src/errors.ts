/**
 * Errors the reader throws because of the data it was given, as opposed to
 * how it was called: a caller's invalid argument (a latitude out of range,
 * a place id this file doesn't have) is a plain `RangeError`, and anything
 * else is a bug.
 *
 * ```ts
 * try {
 * 	reader = CGeoDataReader.open(path);
 * } catch (error) {
 * 	if (error instanceof CGeoDataVersionError) {
 * 		// written by a newer compressor: upgrade the reader
 * 	} else if (error instanceof CGeoDataFormatError) {
 * 		// truncated or corrupt download: fetch the file again
 * 	} else throw error;
 * }
 * ```
 */
export class CGeoDataError extends Error {
	override name = "CGeoDataError";
}

/** A `.bin` file, or a search or locate index, is malformed or truncated:
 * it breaks a rule of binary-format.md, so nothing read from it can be
 * trusted. */
export class CGeoDataFormatError extends CGeoDataError {
	override name = "CGeoDataFormatError";
}

/** The file is a CGEODATA file (or index) of a format version this reader
 * doesn't know -- most likely written by a newer compressor. */
export class CGeoDataVersionError extends CGeoDataFormatError {
	override name = "CGeoDataVersionError";
	/** The version number the file declares. */
	readonly version: number;

	constructor(message: string, version: number) {
		super(message);
		this.version = version;
	}
}

/** A search or locate index is well formed, but was built from a different
 * `.bin` file than the one it's being used with (or an older build of the
 * same one). Rebuild the index, or delete it to work without one. */
export class CGeoDataIndexMismatchError extends CGeoDataError {
	override name = "CGeoDataIndexMismatchError";
}
