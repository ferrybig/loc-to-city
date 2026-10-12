import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const FINAL = path.join(REPO_ROOT, "data/03-final");
/** What the worldwide .bin is built from; a newer one means the .bin is stale. */
export const RESOLVED_INPUT = path.join(
	REPO_ROOT,
	"data/02-resolved/world/hierarchy.json",
);

/**
 * The worldwide .bin to check: CGEODATA_WORLD_BIN if set, else
 * data/03-final/world-high-res.bin, else world.bin. Undefined when there is
 * none.
 *
 * High-res first, not the newest: its cells are about 300 m instead of
 * 2.4 km, and the cases (and countries.md) were measured on it. world.bin is
 * the faster build for iterating on a whole country's regions, where fine
 * detail does not matter; check it with
 * `CGEODATA_WORLD_BIN=data/03-final/world.bin`, and expect the cases that
 * need the finer cells (small places, borders, microstates) to differ.
 */
export function pickWorldBin(dir = FINAL): string | undefined {
	const fromEnv = process.env.CGEODATA_WORLD_BIN;
	if (fromEnv !== undefined) return existsSync(fromEnv) ? fromEnv : undefined;
	return [
		path.join(dir, "world-high-res.bin"),
		path.join(dir, "world.bin"),
	].find((candidate) => existsSync(candidate));
}
