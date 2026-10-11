import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { LonLat } from "./geo.ts";

/** One row of GeoNames' `cities500.txt` (tab-separated, no header --
 * https://download.geonames.org/export/dump/, the `cities500` export:
 * every populated place with population >= 500 or that is a national/
 * admin1/admin2 seat, whichever is coarser). Only the columns this
 * project's Voronoi fallback (countries.md's Libya and Slovenia
 * sections) actually needs are parsed out; the rest of GeoNames' 19 columns
 * are ignored. */
export interface Cities500Row {
  geonameId: string;
  name: string;
  point: LonLat;
  /** ISO 3166-1 alpha-2, same alphabet as `resolvePolygonCountry`'s
   * output and `ne_10m_admin_0_countries.geojson`'s `ISO_A2_EH` --
   * confirmed to line up directly for the fallback countries this was
   * built for (no known exceptions hit yet; a country needing its own
   * remap would show up as 0 points parsed for it). */
  countryCode: string;
  /** GeoNames' admin1 code, `<countryCode>.<code>` when joined with a dot
   * -- the join key `admin1CodesASCII.txt` itself uses. Empty string when
   * GeoNames has no admin1 for this row (rare; excluded from the region
   * fallback, since it can't be grouped into a named admin1 cell). */
  admin1Code: string;
}

/** Streams every row of `cities500.txt`, tab-split and filtered to just
 * the fields the Voronoi fallback needs. The full file is ~236k lines /
 * ~41MB -- small enough that a caller can also just collect this into an
 * array, unlike the multi-gigabyte OSM extracts elsewhere in this
 * pipeline. */
export async function* streamCities500(filePath: string): AsyncGenerator<Cities500Row> {
  const rl = readline.createInterface({ input: createReadStream(filePath) });
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    const geonameId = cols[0];
    const name = cols[1];
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const countryCode = cols[8];
    const admin1Code = cols[10];
    if (!geonameId || !name || !countryCode || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    yield { geonameId, name, point: [lon, lat], countryCode, admin1Code: admin1Code ?? "" };
  }
}
