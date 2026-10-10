/**
 * Content-hash ETags, computed at build time (src/prepareStatic.ts) into
 * a `.etags.json` per served directory. The default ETag is the file's
 * size and mtime, and a Docker build gives every file it generates a new
 * mtime, so each deploy would make clients fetch everything again.
 */
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/** A dotfile, so express.static doesn't serve it. */
export const ETAGS_FILE = ".etags.json";

/** A file's ETag: the hash of its contents. Streamed, for a dataset of
 * tens of MB. */
export async function hashEtag(file: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	return `"${hash.digest("base64url").slice(0, 27)}"`;
}

/** Every file under `dir` (but dotfiles), as `/`-separated relative paths. */
export function listFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.startsWith("."))
		.map((entry) =>
			path
				.relative(dir, path.join(entry.parentPath, entry.name))
				.split(path.sep)
				.join("/"),
		)
		.sort();
}

/** `dir`'s ETags, by `/`-separated path relative to it; empty when the
 * build step hasn't run there. */
export function readEtags(dir: string): Map<string, string> {
	let json: string;
	try {
		json = readFileSync(path.join(dir, ETAGS_FILE), "utf8");
	} catch {
		return new Map();
	}
	return new Map(Object.entries(JSON.parse(json) as Record<string, string>));
}
