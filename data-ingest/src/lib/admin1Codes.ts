import { createReadStream } from "node:fs";
import readline from "node:readline";

/** Streams GeoNames' `admin1CodesASCII.txt` (tab-separated, no header:
 * `<countryCode>.<admin1Code>`, name, asciiname, geonameid) into a plain
 * `code -> name` map, keyed by the exact same `${countryCode}.${admin1Code}`
 * string `cities500.txt` rows join against via their own `countryCode` +
 * `admin1Code` columns. Only used for display names -- unlike
 * `cities500.txt`, this file has no coordinates in this repo (the real
 * GeoNames export pairs it with `allCountries.txt`'s per-geonameid lat/lon,
 * which isn't vendored here), so the region Voronoi fallback derives its
 * *sites* from cities500's own points instead (see `voronoiFallback.ts`'s
 * `buildRegionFallback`) and uses this file purely to name the resulting
 * groups. */
export async function loadAdmin1Names(filePath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const rl = readline.createInterface({ input: createReadStream(filePath) });
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    const code = cols[0];
    const name = cols[1];
    if (!code || !name) continue;
    names.set(code, name);
  }
  return names;
}
