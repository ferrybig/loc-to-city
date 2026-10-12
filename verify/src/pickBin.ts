import { existsSync, statSync } from "node:fs";
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
 * The worldwide .bin to check: CGEODATA_WORLD_BIN if set, else the most
 * recently built of data/03-final/world.bin and world-high-res.bin (they
 * are built at different times, and a stale one would report fixes as
 * broken). Undefined when there is none.
 */
export function pickWorldBin(): string | undefined {
	const fromEnv = process.env.CGEODATA_WORLD_BIN;
	if (fromEnv !== undefined) return existsSync(fromEnv) ? fromEnv : undefined;
	return [path.join(FINAL, "world.bin"), path.join(FINAL, "world-high-res.bin")]
		.filter((candidate) => existsSync(candidate))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
