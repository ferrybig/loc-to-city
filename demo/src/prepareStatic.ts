#!/usr/bin/env node
/**
 * The build step for the demo's served files (the Docker build runs it):
 * writes a brotli-compressed `<file>.br` next to each text file, which
 * staticAssets.ts serves instead to a client that accepts it, so nothing
 * is compressed per request; then hashes every file into the directory's
 * `.etags.json` (see etags.ts).
 *
 *   node src/prepareStatic.ts [dir...]
 *
 * Covers the static directories (staticAssets.ts's STATIC_DIRS), plus any
 * `dir` given: the dataset's, for its downloads' ETags. Its output goes
 * stale as soon as a file changes, so the dev server runs without it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { ETAGS_FILE, hashEtag, listFiles } from "./etags.ts";
import { STATIC_DIRS } from "./staticAssets.ts";

const TEXT_EXTENSIONS = new Set([
	".html",
	".js",
	".mjs",
	".css",
	".svg",
	".json",
	".map",
	".md",
	".txt",
]);

/** Writes `file.br` if that's smaller than `file` (removing an older one
 * if not); returns whether it did. */
function compress(file: string): boolean {
	const body = readFileSync(file);
	const compressed = brotliCompressSync(body, {
		params: {
			[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
			[zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
			[zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
		},
	});
	if (compressed.length >= body.length) {
		rmSync(`${file}.br`, { force: true });
		return false;
	}
	writeFileSync(`${file}.br`, compressed);
	return true;
}

export async function prepareDir(dir: string): Promise<void> {
	let compressed = 0;
	for (const file of listFiles(dir)) {
		if (
			TEXT_EXTENSIONS.has(path.extname(file)) &&
			compress(path.join(dir, file))
		) {
			compressed++;
		}
	}
	// Listed again, to hash the .br files too.
	const etags: Record<string, string> = {};
	for (const file of listFiles(dir)) {
		etags[file] = await hashEtag(path.join(dir, file));
	}
	writeFileSync(
		path.join(dir, ETAGS_FILE),
		`${JSON.stringify(etags, null, "\t")}\n`,
	);
	console.error(
		`${dir}: ${compressed} files compressed, ${Object.keys(etags).length} hashed`,
	);
}

if (import.meta.main) {
	const dirs = [
		...STATIC_DIRS.map((d) => d.dir).filter((dir) => existsSync(dir)),
		...process.argv.slice(2).map((dir) => path.resolve(dir)),
	];
	for (const dir of dirs) await prepareDir(dir);
}
