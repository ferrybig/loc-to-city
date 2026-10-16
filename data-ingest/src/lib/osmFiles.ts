import { readdirSync } from "node:fs";
import path from "node:path";

/** Lists every `*-admin.geojson` and `*-census.geojson` produced by
 * `scripts/extract-boundaries.sh` in `workDir`, sorted for deterministic pass
 * ordering (each admin file before its census one). `prepare-world.ts`
 * never names a continent itself -- it just consumes whatever extraction
 * has produced, so dropping in a new/replacement `.osm.pbf` and re-running
 * extraction is the entire "swap files, rerun" contract on this side. */
export function discoverAdminGeoJsonFiles(workDir: string): string[] {
  return readdirSync(workDir)
    .filter((name) => name.endsWith("-admin.geojson") || name.endsWith("-census.geojson"))
    .sort()
    .map((name) => path.join(workDir, name));
}
