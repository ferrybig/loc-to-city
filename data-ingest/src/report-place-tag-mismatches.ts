// README.md's "Known issues" place=city/town/village tie-break item: scans
// the merged admin-boundary corpus (same source prepare-world.ts reads) and
// reports every settlement where OSM's `place` tag names a real
// city/town/village at an admin_level the country's current
// COUNTRY_ADMIN_LEVELS entry doesn't already treat as a city level -- the
// exact pattern that found Bremen's fix (its city relation is
// admin_level=6 place=city, not the admin_level=4 Land the plain area vote
// alone would have picked). Deliberately its own collection pass
// (collectPlaceTagCandidates), not buildAdminBoundaryIndex's
// cityCandidates -- that list only contains relations whose level already
// survived the *current* COUNTRY_ADMIN_LEVELS filter, which would hide
// exactly the missing levels this report exists to surface.
//
// Read-only: never writes to COUNTRY_ADMIN_LEVELS or any build output.
// Review its `MISMATCH` lines and hand-edit
// data-ingest/src/lib/countryAdminLevels.ts, the same workflow that
// already produced every existing override in that file.
//
// Usage: npx tsx data-ingest/src/report-place-tag-mismatches.ts [--all]
//   --all   also print non-mismatching groups (place tag agrees with the
//           current config already) -- useful for sanity-checking the
//           detector itself against known-good entries, not for triage.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAdminGeoJsonFiles } from "./lib/osmFiles.js";
import { loadCountryIndex } from "./lib/countryIndex.js";
import { collectPlaceTagCandidates, findPlaceTagMismatches } from "./lib/placeTagSignal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORK_DIR = path.join(REPO_ROOT, "data/01-extracted/world");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");

async function main(): Promise<void> {
  const showAll = process.argv.includes("--all");

  const files = discoverAdminGeoJsonFiles(WORK_DIR);
  if (files.length === 0) {
    throw new Error(`no *-admin.geojson files found in ${WORK_DIR} -- run scripts/extract-boundaries.sh first`);
  }
  console.error(`found ${files.length} admin files: ${files.map((f) => path.basename(f)).join(", ")}`);

  const countries = loadCountryIndex(COUNTRIES_SOURCE);
  console.error("scanning merged corpus for place-tagged admin relations...");
  const candidates = await collectPlaceTagCandidates(files, countries);
  console.error(`collected ${candidates.length.toLocaleString()} candidates`);

  const results = findPlaceTagMismatches(candidates);
  const mismatches = results.filter((r) => r.isMismatch);
  const regionScoped = results.filter((r) => r.configuredCityLevel === undefined);
  const agreeing = results.filter((r) => r.configuredCityLevel !== undefined && !r.isMismatch);

  for (const r of showAll ? results : mismatches) {
    const tag = r.isMismatch ? "MISMATCH" : "ok";
    const configured = r.configuredCityLevel === undefined ? "region-scoped, skipped" : `configured=[${r.configuredCityLevel}]`;
    console.log(
      `${tag}\t${r.country}\t${r.name}\tplace=${r.place} at level ${r.placeLevel}\tother levels: ${r.otherLevels.join(",")}\t${configured}`,
    );
  }

  console.error(
    `\n${mismatches.length} mismatches, ${agreeing.length} already agree with current config, ` +
      `${regionScoped.length} skipped (region-scoped overrides -- needs region geometry this report doesn't ` +
      `have, review by hand)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
