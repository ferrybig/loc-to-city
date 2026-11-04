// usage: node .claude/skills/check-admin-level/levels.mjs LA [UZ ...]   (~5.5 min, two passes over the planet extract)
// Prints, per (country, admin_level 3-11): relation count, area as % of the country's Natural Earth area, sample names.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const R = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(`${R}/package.json`);
const area = require("@turf/area").default ?? require("@turf/area");
const { discoverAdminGeoJsonFiles } = await import(`${R}/data-ingest/src/lib/osmFiles.ts`);
const { loadCountryIndex } = await import(`${R}/data-ingest/src/lib/countryIndex.ts`);
const { loadOsmCountryRelations, withOsmCountryBorders } = await import(`${R}/data-ingest/src/lib/osmCountryBorders.ts`);
const { streamMergedAdminBoundaries } = await import(`${R}/data-ingest/src/lib/mergeAdminBoundaries.ts`);
const { resolvePolygonCountry } = await import(`${R}/data-ingest/src/lib/polygonCountry.ts`);
const { bboxAndPointOnFeature } = await import(`${R}/data-ingest/src/lib/pointOnFeature.ts`);

const targets = new Set(process.argv.slice(2));
const NE = `${R}/data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson`;
const files = discoverAdminGeoJsonFiles(`${R}/data/01-extracted/world`);
const ne = loadCountryIndex(NE);
const osm = await loadOsmCountryRelations(files, new Set(ne.nameByCode.keys()));
const countries = withOsmCountryBorders(ne, osm.borders);

const neArea = {};
for (const f of JSON.parse(readFileSync(NE, "utf8")).features) {
	for (const c of [f.properties.ISO_A2, f.properties.ISO_A2_EH]) if (targets.has(c)) neArea[c] = area(f) / 1e6;
}
const sums = new Map(); // "CC/level" -> {km2, n, names}
for await (const { feature } of streamMergedAdminBoundaries(files)) {
	const p = feature.properties;
	const level = Number(p?.admin_level);
	if (!(level >= 3 && level <= 11) || p.boundary === "census" || p.natural === "coastline") continue;
	if (feature.geometry?.type !== "Polygon" && feature.geometry?.type !== "MultiPolygon") continue;
	const { bbox, repPoint } = bboxAndPointOnFeature(feature.geometry);
	const cc = resolvePolygonCountry(feature, bbox, repPoint, countries, {});
	if (!cc || !targets.has(cc)) continue;
	const e = sums.get(`${cc}/${level}`) ?? { km2: 0, n: 0, names: [] };
	e.km2 += area(feature) / 1e6; e.n++;
	if (e.names.length < 4 && p.name) e.names.push(p.name);
	sums.set(`${cc}/${level}`, e);
}
for (const [k, e] of [...sums].sort()) {
	const cc = k.split("/")[0];
	console.log(k.padEnd(7), String(e.n).padStart(6), "rel", (100 * e.km2 / neArea[cc]).toFixed(1).padStart(6) + "% of NE", e.names.join(", "));
}
