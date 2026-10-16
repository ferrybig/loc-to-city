// Prepares worldwide compressor inputs from the outputs of
// scripts/extract-boundaries.sh (data/01-extracted/world/*-admin.geojson,
// one per data/00-raw/osm/*.osm.pbf continent extract).
//
// Unlike prepare-europe.ts, there is no pre-computed cities.geojson to
// reuse -- that file was produced by a deleted Python pipeline that only
// ever ran for Europe. This script does the full job itself: merges and
// deduplicates administrative relations across however many continent
// files are present (dedup is by OSM relation id, not by any per-country
// priority -- see mergeAdminBoundaries.ts for why that's both correct and
// general, verified empirically against Russia/Turkey's real cross-file
// split), then ports README.md's 3-pass per-country admin_level
// auto-detection (area-accumulate by (country,level) -> pick the finest
// level covering >=60% of the country as primary -> gap-fill by
// representative-point containment) to assemble the city layer, plus a
// region layer and a country layer (OSM's own country relations, with
// overlaps between them resolved -- see countryOutlines.ts).
// The region layer's own admin_level is auto-detected per country too
// (selectRegionLevels), not assumed to always be 4 -- see
// adminLevelDetection.ts's doc comment for why that matters.
//
// See data-ingest/src/lib/{osmFiles,countryIndex,mergeAdminBoundaries,
// adminBoundaryIndex,adminLevelDetection,regionPolygons}.ts for the
// pieces; this file just orchestrates them and writes the same output
// shapes prepare-europe.ts already produces, so the compressor CLI needs
// no changes at all.
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import bbox from "@turf/bbox";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { CityProperties, HierarchyCountry } from "@loc-to-city/compressor";
import { discoverAdminGeoJsonFiles } from "./lib/osmFiles.ts";
import { loadCountryIndex } from "./lib/countryIndex.ts";
import { loadOsmCountryRelations, withOsmCountryBorders } from "./lib/osmCountryBorders.ts";
import {
  cutCountriesOutOfForeignRegions,
  type Outline,
  indexOutlines,
  outlineLookup,
  resolveCountryOverlaps,
} from "./lib/countryOutlines.ts";
import { bboxAndPointOnFeature } from "./lib/pointOnFeature.ts";
import { buildAdminBoundaryIndex } from "./lib/adminBoundaryIndex.ts";
import { type AdminBoundaryWorkerData, type CityCandidateMeta, PASS1_MAX_BYTES } from "./lib/adminBoundaryIndex.ts";
import {
  selectRegionLevels,
  selectPrimaryLevels,
  createGapFillTracker,
  streamPrimaries,
  findSuppressedByWholeUnits,
  streamGeometries,
} from "./lib/adminLevelDetection.ts";
import { buildRegionIndex, assignCityRegion, shareInOtherRegions } from "./lib/regionPolygons.ts";
import { streamCities500 } from "./lib/cities500.ts";
import type { Cities500Row } from "./lib/cities500.ts";
import type { VoronoiCityCandidate } from "./lib/voronoiFallback.ts";
import { loadAdmin1Names } from "./lib/admin1Codes.ts";
import { buildCityFallback, buildContainerFallback, buildRegionFallback } from "./lib/voronoiFallback.ts";
import { buildHoleFill, type RealCity } from "./lib/holeFill.ts";
import { buildRegionHoles } from "./lib/regionHoles.ts";
import {
  CITY_STATES,
  COUNTRY_ADMIN_LEVELS,
  GEONAMES_COUNTRY_OF,
  REGION_CITIES,
  VORONOI_CITY_FALLBACK,
  VORONOI_CITY_FALLBACK_HOLES,
  VORONOI_CITY_FALLBACK_HOLES_IN,
  VORONOI_CITY_FALLBACK_WITHIN_REGIONS,
  VORONOI_REGION_FALLBACK,
  VORONOI_REGION_HOLES,
} from "./lib/countryAdminLevels.ts";
import type { LonLat } from "./lib/geo.ts";
import type { RegionCandidate } from "./lib/adminBoundaryIndex.ts";
import { CLIP_MAX_VERTICES, clipHandlers, clipper } from "./lib/clip.ts";
import { DuplicateGeometries, osmUrlFor } from "./lib/duplicateGeometries.ts";
import { defaultWorkerCount, WorkerPool } from "./lib/workerPool.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const WORK_DIR = path.join(REPO_ROOT, "data/01-extracted/world");
const COUNTRIES_SOURCE = path.join(REPO_ROOT, "data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson");
const CITIES500_SOURCE = path.join(REPO_ROOT, "data/00-raw/geonames/cities500.txt");
const ADMIN1_CODES_SOURCE = path.join(REPO_ROOT, "data/00-raw/geonames/admin1CodesASCII.txt");

/** cities500.txt, with a GeoNames country code this dataset files under
 * another country read as that one (GEONAMES_COUNTRY_OF: BQ is NL). */
async function* readCities500(): AsyncGenerator<Cities500Row> {
  for await (const row of streamCities500(CITIES500_SOURCE)) {
    const country = GEONAMES_COUNTRY_OF.get(row.countryCode);
    yield country ? { ...row, countryCode: country } : row;
  }
}

const HIERARCHY_OUT = path.join(REPO_ROOT, "data/02-resolved/world/hierarchy.json");
const CITIES_OUT = path.join(REPO_ROOT, "data/02-resolved/world/cities-filtered.geojsonseq");
const REGIONS_OUT = path.join(REPO_ROOT, "data/02-resolved/world/regions.geojsonseq");
const COUNTRIES_OUT = path.join(REPO_ROOT, "data/02-resolved/world/country-polygons.geojson");
const DUPLICATES_OUT = path.join(REPO_ROOT, "data/02-resolved/world/duplicate-cities.tsv");

async function main(): Promise<void> {
  mkdirSync(path.dirname(HIERARCHY_OUT), { recursive: true });

  const files = discoverAdminGeoJsonFiles(WORK_DIR);
  if (files.length === 0) {
    throw new Error(`no *-admin.geojson files found in ${WORK_DIR} -- run scripts/extract-boundaries.sh first`);
  }
  console.error(`found ${files.length} admin files: ${files.map((f) => path.basename(f)).join(", ")}`);

  // Worker threads for the polygon clipping (clip.ts) -- PREPARE_WORKERS=0
  // clips on the main thread instead, with the same result.
  const workerUrl = new URL("./lib/ingestWorker.ts", import.meta.url);
  const pool = new WorkerPool(workerUrl, defaultWorkerCount(), clipHandlers, { maxWeight: CLIP_MAX_VERTICES });
  const clip = clipper(pool);
  console.error(`${pool.size} worker threads`);

  console.error("Loading country index (Natural Earth, worldwide)...");
  const naturalEarth = loadCountryIndex(COUNTRIES_SOURCE);
  // Natural Earth has no room for enclaves (Baarle-Hertog) and only
  // approximates land borders; OSM's own country borders, already in the
  // corpus, correct it where the two disagree (see withOsmCountryBorders).
  console.error("Loading OSM country relations...");
  const osmCountries = await loadOsmCountryRelations(files, new Set(naturalEarth.nameByCode.keys()));
  const countries = withOsmCountryBorders(naturalEarth, osmCountries.borders);

  // The country layer the compressor draws is OSM's own outlines, not
  // Natural Earth's: Natural Earth's 10m outlines miss most of the Vatican
  // and put Monaco's over France, and overshoot land borders by hundreds of
  // metres (countries.md, "Natural Earth's outlines are too coarse" and
  // "Border artifacts"). They include territorial waters, so a photo taken
  // from a boat near a coast answers that country. Natural Earth still
  // decides which country each city and region belongs to (above), and
  // gives the outline of a country OSM has no relation for.
  console.error("Country outlines: OSM, with overlaps resolved...");
  const outlines = new Map<string, Outline>();
  const naturalEarthOutlines: string[] = [];
  for (const [code, feature] of countries.simplifiedFeatureByCode) {
    const osm = osmCountries.outlineJsonByCode.get(code);
    if (!osm) naturalEarthOutlines.push(code);
    const geometries = osm ? osm.map((json) => JSON.parse(json) as Polygon | MultiPolygon) : [feature.geometry];
    outlines.set(
      code,
      geometries.flatMap((g) => (g.type === "Polygon" ? [g.coordinates] : g.coordinates)),
    );
  }
  osmCountries.outlineJsonByCode.clear();
  const resolved = await resolveCountryOverlaps(outlines, countries.lookup, new Set(naturalEarthOutlines), clip);
  for (const cut of resolved.cuts) {
    console.error(`  ${cut.owner} cut out of ${cut.from} (sampled: ${JSON.stringify(cut.votes)})`);
  }
  console.error(
    `  ${resolved.cuts.length} overlaps cut; Natural Earth outline (no OSM relation): ${naturalEarthOutlines.join(", ")}`,
  );
  // Held as text for the output; the geometry itself is only kept until
  // the regions are cut (below), and for the city-states.
  const countryFeatureJson: string[] = [];
  const cityStateGeometry = new Map<string, MultiPolygon>();
  for (const [code, coordinates] of resolved.outlines) {
    const geometry: MultiPolygon = { type: "MultiPolygon", coordinates };
    countryFeatureJson.push(JSON.stringify({ type: "Feature", properties: { code }, geometry }));
    if (CITY_STATES.has(code)) cityStateGeometry.set(code, geometry);
  }
  outlines.clear();

  console.error("Pass 1/4: scanning merged corpus for city/region candidates...");
  // A polygon Natural Earth puts entirely at sea (a coastal village inland
  // of its coastline, an atoll it doesn't have) gets the country whose
  // outline is drawn there -- see resolvePolygonCountry.
  // Its own pool: these workers hold the country lookups, which the
  // clipping ones don't need.
  const pass1Pool = new WorkerPool(workerUrl, pool.size, {}, {
    workerData: {
      naturalEarthPath: COUNTRIES_SOURCE,
      osmBorders: osmCountries.borders.pack(),
      outlines: indexOutlines(resolved.outlines).pack(),
    } satisfies AdminBoundaryWorkerData,
    maxWeight: PASS1_MAX_BYTES,
  });
  const index = await buildAdminBoundaryIndex(files, countries, outlineLookup(resolved.outlines), pass1Pool);
  await pass1Pool.close();

  console.error("Pass 1.5/4: selecting each country's region level...");
  const region = selectRegionLevels(index, countries);
  // Only the level that won each country's vote becomes its actual region
  // layer -- a country's own COUNTRY_ADMIN_LEVELS.region entry can list
  // more than one candidate level for selectRegionLevels to compare, so a
  // losing level's candidates must not leak into region assignment or
  // output. (In practice almost every entry lists exactly one level, so
  // this filter is close to a no-op for most countries.)
  const finalRegions = new Map(
    [...index.regionsByCountryName].filter(
      ([, r]) =>
        region.regionLevelByCountry.get(r.country) === r.level ||
        COUNTRY_ADMIN_LEVELS[r.country]?.regionGapFill?.includes(r.level),
    ),
  );
  // A `regionOutside` relation is a region only where no region of the chosen
  // level holds its point (NL: the Caribbean islands, not the gemeenten).
  const outside = [...index.regionsByCountryName].filter(([, r]) =>
    COUNTRY_ADMIN_LEVELS[r.country]?.regionOutside?.includes(r.level),
  );
  if (outside.length > 0) {
    const chosen = buildRegionIndex(finalRegions);
    for (const [key, r] of outside) {
      if (!r.point || assignCityRegion(r.point, r.country, chosen) !== null) continue;
      console.error(`  region outside ${r.country}'s regions: ${r.name} (level ${r.level}, ${r.id})`);
      finalRegions.set(key, r);
    }
  }

  // The Voronoi-from-cities500 fallback (countries.md, Slovenia), region half
  // (VORONOI_REGION_FALLBACK's doc comment has the full rationale): for a
  // country with no usable OSM region tier at all, synthesize one from
  // cities500.txt grouped by admin1 code. Must run before regionIndex is
  // built below -- every downstream region assignment (real OSM
  // candidates, the region-override routing, and the city Voronoi
  // fallback later) depends on finalRegions already being complete.
  if (VORONOI_REGION_FALLBACK.size > 0) {
    console.error(`Voronoi fallback: synthesizing regions for ${[...VORONOI_REGION_FALLBACK].join(", ")}...`);
    const admin1Names = await loadAdmin1Names(ADMIN1_CODES_SOURCE);
    const regionPointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of readCities500()) {
      if (!VORONOI_REGION_FALLBACK.has(row.countryCode)) continue;
      let points = regionPointsByCountry.get(row.countryCode);
      if (!points) {
        points = [];
        regionPointsByCountry.set(row.countryCode, points);
      }
      points.push(row);
    }
    let voronoiRegionCount = 0;
    for (const [countryCode, points] of regionPointsByCountry) {
      const countryPolygon = countries.simplifiedFeatureByCode.get(countryCode);
      if (!countryPolygon) continue;
      const candidates = await buildRegionFallback(countryPolygon, points, admin1Names, clip);
      for (const candidate of candidates) {
        const key = `${candidate.country} voronoi ${candidate.name}`;
        const feature: Feature<Polygon | MultiPolygon, { name: string }> = {
          type: "Feature",
          properties: { name: candidate.name },
          geometry: candidate.geometry,
        };
        const regionCandidate: RegionCandidate = {
          id: `voronoi:${candidate.country}.${candidate.name}`,
          name: candidate.name,
          nameEn: undefined,
          country: candidate.country,
          level: -1, // not a real OSM admin_level -- never matched against COUNTRY_ADMIN_LEVELS
          bbox: bbox(feature),
          feature,
        };
        finalRegions.set(key, regionCandidate);
        voronoiRegionCount++;
      }
    }
    console.error(`Voronoi fallback: ${voronoiRegionCount.toLocaleString()} synthesized regions added`);
  }

  // A country inside a neighbour's region polygon (Western Sahara in
  // Morocco's regions) is cut out of it -- see
  // cutCountriesOutOfForeignRegions. Each region keeps its original bbox:
  // it is only a prefilter, and changing it would reorder regionIndex,
  // which assignCityRegion is sensitive to (see the city-states below).
  const regionCut = await cutCountriesOutOfForeignRegions(
    new Map([...finalRegions].map(([key, r]) => [key, { country: r.country, geometry: r.feature.geometry }])),
    resolved.outlines,
    countries.lookup,
    clip,
  );
  for (const cut of regionCut.cuts) {
    console.error(`  ${cut.country} cut out of region ${cut.region} (sampled: ${JSON.stringify(cut.votes)})`);
  }
  for (const [key, coordinates] of regionCut.geometryByRegion) {
    const region = finalRegions.get(key)!;
    finalRegions.set(key, { ...region, feature: { ...region.feature, geometry: { type: "MultiPolygon", coordinates } } });
  }

  // The region hole fill (VORONOI_REGION_HOLES' doc comment): land of a
  // country no region covers joins a region, or becomes one, by the admin1
  // codes of the cities500 places on it. Before regionIndex, like the region
  // fallback above, and on the OSM outlines, which are cleared below.
  if (VORONOI_REGION_HOLES.size > 0) {
    console.error(`Region hole fill: ${[...VORONOI_REGION_HOLES.keys()].join(", ")}...`);
    const admin1Names = await loadAdmin1Names(ADMIN1_CODES_SOURCE);
    const pointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of readCities500()) {
      if (!VORONOI_REGION_HOLES.has(row.countryCode)) continue;
      let points = pointsByCountry.get(row.countryCode);
      if (!points) pointsByCountry.set(row.countryCode, (points = []));
      points.push(row);
    }
    const holes = await Promise.all(
      [...VORONOI_REGION_HOLES].map(async ([code, fallbackName]) => {
        const coordinates = resolved.outlines.get(code);
        if (!coordinates) return { code, result: null };
        const own = [...finalRegions.values()]
          .filter((r) => r.country === code)
          .map((r) => ({ name: r.name, bbox: r.bbox, geometry: r.feature.geometry }));
        const result = await buildRegionHoles(
          code,
          { type: "MultiPolygon", coordinates },
          own,
          pointsByCountry.get(code) ?? [],
          admin1Names,
          fallbackName,
          clip,
        );
        return { code, result };
      }),
    );
    for (const { code, result } of holes) {
      if (!result) continue;
      for (const [name, pieces] of result.extend) {
        const [key, region] = [...finalRegions].find(([, r]) => r.country === code && r.name === name)!;
        const own = region.feature.geometry;
        const geometry: MultiPolygon = {
          type: "MultiPolygon",
          coordinates: [...(own.type === "Polygon" ? [own.coordinates] : own.coordinates), ...pieces],
        };
        const feature = { ...region.feature, geometry };
        finalRegions.set(key, { ...region, bbox: bbox(feature), feature });
        console.error(`  ${code} ${name}: ${pieces.length} pieces added`);
      }
      for (const [name, pieces] of result.created) {
        const feature: Feature<MultiPolygon, { name: string }> = {
          type: "Feature",
          properties: { name },
          geometry: { type: "MultiPolygon", coordinates: pieces },
        };
        finalRegions.set(`${code} region-hole ${name}`, {
          id: `region-hole:${code}.${name}`,
          name,
          nameEn: undefined,
          country: code,
          level: -1, // not a real OSM admin_level -- never matched against COUNTRY_ADMIN_LEVELS
          bbox: bbox(feature),
          feature,
        });
        console.error(`  ${code} ${name}: new region, ${pieces.length} pieces`);
      }
    }
  }
  resolved.outlines.clear();

  console.error("Pass 2/4: selecting primary admin levels...");
  const regionIndex = buildRegionIndex(finalRegions);
  // City-states (CITY_STATES' doc comment): one region covering the whole
  // country, which every city of it belongs to. Kept out of regionIndex on
  // purpose: assignCityRegion answers with the first containing region in
  // R-tree order, so adding two regions to the tree moved 593 cities500
  // points elsewhere in the world to a neighbouring, overlapping region
  // (Ninghe District from Tianjin to Hebei).
  const cityStateRegion = new Map<string, string>();
  for (const [code, { region }] of CITY_STATES) {
    const geometry = cityStateGeometry.get(code);
    if (!geometry) continue;
    const feature: Feature<MultiPolygon, { name: string }> = { type: "Feature", properties: { name: region }, geometry };
    finalRegions.set(`${code} city-state ${region}`, {
      id: `city-state:${code}`,
      name: region,
      nameEn: undefined,
      country: code,
      level: -1, // not a real OSM admin_level -- never matched against COUNTRY_ADMIN_LEVELS
      bbox: bbox(feature),
      feature,
    });
    cityStateRegion.set(code, region);
  }
  const regionAt = (point: LonLat, country: string): string | null =>
    cityStateRegion.get(country) ?? assignCityRegion(point, country, regionIndex);
  // A city whose repPoint is a boundary vertex is placed by a point strictly
  // inside it (see interiorPoint), so a town on a region border no longer
  // goes to the neighbour. That point can fall where no region of the
  // country is (Zmajevac's lands in the Danube strip cut out of its county
  // for Serbia; Iligan is a hole in Lanao del Norte), and then the vertex
  // still decides, as before, rather than the city being dropped.
  const regionOf = (candidate: { repPoint: LonLat; regionPoint?: LonLat | undefined; country: string }): string | null =>
    (candidate.regionPoint && regionAt(candidate.regionPoint, candidate.country)) ??
    regionAt(candidate.repPoint, candidate.country);
  // Only needed to route a region-override candidate (see
  // COUNTRY_ADMIN_LEVELS.overrides) to its region's own level instead of
  // the country-wide one -- resolves the same way emitCity's own region
  // assignment does later, just early enough for selectPrimaryLevels to
  // use it.
  const resolveCandidateRegion = (candidate: CityCandidateMeta): string | null => regionOf(candidate);
  const primary = selectPrimaryLevels(index, countries, undefined, resolveCandidateRegion);

  // Cities stream straight to disk as a GeoJSON Text Sequence (one
  // RS-delimited feature per record, the same shape osmium emits and
  // streamGeoJSONSeq reads). A single FeatureCollection is not an option
  // at this scale: the file runs to gigabytes, and Node cannot hold a
  // string past 512MB, so nothing downstream could ever JSON.parse it.
  const cityOut = createWriteStream(CITIES_OUT);
  const write = (chunk: string): Promise<void> =>
    cityOut.write(chunk) ? Promise.resolve() : new Promise((resolve) => cityOut.once("drain", () => resolve()));

  // Every region polygon enters the hierarchy, not just those that end up
  // holding a city: the compressor only builds regions the hierarchy
  // lists, so a region with no cities (all of Libya/Egypt, whose OSM data
  // has no city tier, or Khartoum State) would otherwise vanish and its
  // points resolve at country level only.
  const regionsByCountry = new Map<string, Set<string>>();
  // Local region name -> international name (README.md's "International/
  // local name pairs" item), keyed by the exact same local name used as
  // the join key everywhere else -- see HierarchyCountry.regionNames.
  const regionNamesByCountry = new Map<string, Map<string, string>>();
  // Region key -> OSM's name, for namesakes (HierarchyCountry.regionLocalNames).
  const regionLocalNamesByCountry = new Map<string, Map<string, string>>();
  for (const r of finalRegions.values()) {
    let names = regionsByCountry.get(r.country);
    if (!names) {
      names = new Set();
      regionsByCountry.set(r.country, names);
    }
    names.add(r.name);
    if (r.nameEn) {
      let intlNames = regionNamesByCountry.get(r.country);
      if (!intlNames) {
        intlNames = new Map();
        regionNamesByCountry.set(r.country, intlNames);
      }
      intlNames.set(r.name, r.nameEn);
    }
    if (r.localName) {
      let localNames = regionLocalNamesByCountry.get(r.country);
      if (!localNames) regionLocalNamesByCountry.set(r.country, (localNames = new Map()));
      localNames.set(r.name, r.localName);
    }
  }
  const skippedNoRegionByCountry = new Map<string, number>();
  // Cities emitted per `${country}\t${region}`, for REGION_CITIES.
  const citiesByRegion = new Map<string, number>();
  const duplicates = new DuplicateGeometries<CityProperties>();
  let cityCount = 0;
  let skippedNoName = 0;
  let skippedNoGeometry = 0;

  // Region-scoped Voronoi city fallback (VORONOI_CITY_FALLBACK_WITHIN_REGIONS'
  // doc comment): only the opted-in countries' points are kept, and the
  // cells are built per container polygon as the primaries stream past.
  const withinRegionPoints = new Map<string, Cities500Row[]>();
  if (VORONOI_CITY_FALLBACK_WITHIN_REGIONS.size > 0) {
    for await (const row of readCities500()) {
      if (!VORONOI_CITY_FALLBACK_WITHIN_REGIONS.has(row.countryCode)) continue;
      let points = withinRegionPoints.get(row.countryCode);
      if (!points) {
        points = [];
        withinRegionPoints.set(row.countryCode, points);
      }
      points.push(row);
    }
  }
  let withinRegionCount = 0;

  // A container in a within-region fallback region is replaced by its
  // cells. Emitting it as well, as a backstop, would be worse than no
  // backstop: at the compressor's max depth a leaf cell on a border
  // between two cells is won by the candidate covering the largest share
  // of it, which is always the container (100%) over either neighbouring
  // cell -- measured as ~5% of random Highland lookups returning
  // "Highland". The cells tile the container, so nothing is lost; a
  // container with no point at all is still emitted as itself.
  //
  // A container's cells can take minutes to clip (Highland's polygon has
  // 355k vertices, and every cell is clipped against all of it), so the
  // containers are fetched by the read below, which happens anyway, and
  // their cells clipped on the pool while the primaries stream past.
  const containerPoints = new Map<string, Cities500Row[]>(); // container id -> its country's points
  for (const candidate of index.cityCandidates) {
    const withinRegions = VORONOI_CITY_FALLBACK_WITHIN_REGIONS.get(candidate.country);
    const points = withinRegionPoints.get(candidate.country);
    if (!withinRegions || !points || !primary.primaryIds.has(candidate.id)) continue;
    const region = resolveCandidateRegion(candidate);
    if (region && withinRegions.includes(region)) containerPoints.set(candidate.id, points);
  }
  const cellsByContainer = new Map<string, Promise<VoronoiCityCandidate[]>>();

  // A whole unit's sub-units (Wales' communities inside Cardiff) are dropped
  // from the stream below -- see CountryAdminLevels.wholeUnits.
  const suppressed = await findSuppressedByWholeUnits(
    files,
    index,
    primary,
    resolveCandidateRegion,
    new Set(containerPoints.keys()),
    (id, geometryJson) => {
      const container: Feature<Polygon | MultiPolygon> = {
        type: "Feature",
        properties: {},
        geometry: JSON.parse(geometryJson) as Polygon | MultiPolygon,
      };
      cellsByContainer.set(id, buildContainerFallback(container, containerPoints.get(id)!, clip));
    },
  );

  // Primaries are written as they stream past, straight from their source
  // text, while the same read marks which other candidates they cover --
  // no primary geometry is ever held (see createGapFillTracker).
  // The real cities of a hole-fill country (VORONOI_CITY_FALLBACK_HOLES),
  // kept to cut out of its synthesized cells.
  // A "city" lying mostly in other regions than its own is a grouping of
  // them (UG's Bugisa sub-region spans five districts, Mbale City among
  // them): it is dropped, and the fill names its land.
  const realCitiesByCountry = new Map<string, RealCity[]>();
  const emitReal = async (candidate: CityCandidateMeta, geometryJson: string): Promise<boolean> => {
    const only = VORONOI_CITY_FALLBACK_HOLES_IN.get(candidate.country);
    if (!VORONOI_CITY_FALLBACK_HOLES.has(candidate.country) && !only) return emitCity(candidate, geometryJson);
    const region = regionOf(candidate);
    if (only && !(region && only.includes(region))) return emitCity(candidate, geometryJson);
    const geometry = JSON.parse(geometryJson) as Polygon | MultiPolygon;
    if (region && shareInOtherRegions(geometry, candidate.bbox, candidate.country, region, regionIndex) > 0.5) {
      console.error(`  hole fill: ${candidate.country} ${candidate.name} (${candidate.id}) lies mostly in other regions, dropped`);
      return false;
    }
    if (!(await emitCity(candidate, geometryJson))) return false;
    let real = realCitiesByCountry.get(candidate.country);
    if (!real) realCitiesByCountry.set(candidate.country, (real = []));
    real.push({ bbox: candidate.bbox, geometry });
    return true;
  };
  const tracker = createGapFillTracker(index, primary, resolveCandidateRegion);
  const primariesFound = await streamPrimaries(files, tracker, async (candidate, geometryJson) => {
    if (suppressed.has(candidate.id)) return;
    const cells = (await cellsByContainer.get(candidate.id)) ?? [];
    if (cells.length === 0) {
      if (await emitReal(candidate, geometryJson)) cityCount++;
      return;
    }
    for (const cell of cells) {
      if (await emitCity(cell, JSON.stringify(cell.geometry))) {
        cityCount++;
        withinRegionCount++;
      }
    }
  });
  skippedNoGeometry += tracker.primaryById.size - primariesFound;
  if (withinRegionCount > 0) {
    console.error(`Voronoi within-region fallback: ${withinRegionCount.toLocaleString()} synthesized cities emitted`);
  }

  console.error("Pass 3/4: gap-fill geometry...");
  const gapFillById = new Map<string, CityCandidateMeta>();
  for (const candidate of tracker.gapFill()) gapFillById.set(candidate.id, candidate);
  console.error(`  ${gapFillById.size.toLocaleString()} gap-fill cities`);

  for await (const { id, geometryJson } of streamGeometries(files, gapFillById)) {
    if (await emitReal(gapFillById.get(id)!, geometryJson)) cityCount++;
  }

  // The Voronoi hole fill (VORONOI_CITY_FALLBACK_HOLES' doc comment).
  const holeCountries = new Set([...VORONOI_CITY_FALLBACK_HOLES, ...VORONOI_CITY_FALLBACK_HOLES_IN.keys()]);
  if (holeCountries.size > 0) {
    console.error(`Voronoi hole fill: ${[...holeCountries].join(", ")}...`);
    const pointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of readCities500()) {
      if (!holeCountries.has(row.countryCode)) continue;
      let points = pointsByCountry.get(row.countryCode);
      if (!points) pointsByCountry.set(row.countryCode, (points = []));
      points.push(row);
    }
    const holeCells = await Promise.all(
      [...pointsByCountry].map(async ([code, points]) => {
        const gapLevels = COUNTRY_ADMIN_LEVELS[code]?.regionGapFill ?? [];
        const wholeCity = new Set((REGION_CITIES.get(code) ?? []).map((r) => r.region));
        const only = VORONOI_CITY_FALLBACK_HOLES_IN.get(code);
        const own = [...finalRegions.values()].filter(
          (r) => r.country === code && !wholeCity.has(r.name) && (!only || only.includes(r.name)),
        );
        const primaryRegions = own.filter((r) => !gapLevels.includes(r.level));
        const regions = new Map<string, Feature<Polygon | MultiPolygon>>();
        for (const r of own) {
          if (!gapLevels.includes(r.level)) {
            regions.set(r.name, r.feature);
            continue;
          }
          // A region-gap-fill region overlaps the primary ones: its own land
          // is what they leave.
          const outline = (g: Polygon | MultiPolygon): Outline => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);
          const inner = primaryRegions
            .filter((p) => p.bbox[0] < r.bbox[2] && p.bbox[2] > r.bbox[0] && p.bbox[1] < r.bbox[3] && p.bbox[3] > r.bbox[1])
            .flatMap((p) => outline(p.feature.geometry));
          const rest = inner.length > 0 ? await clip.difference(outline(r.feature.geometry), inner) : outline(r.feature.geometry);
          if (rest.length === 0) continue;
          regions.set(r.name, { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: rest } });
        }
        return buildHoleFill(regions, realCitiesByCountry.get(code) ?? [], points, (point) => regionAt(point, code), clip);
      }),
    );
    let holeCount = 0;
    for (const cells of holeCells) {
      for (const cell of cells) {
        if (await emitCity(cell, JSON.stringify(cell.geometry))) {
          cityCount++;
          holeCount++;
        }
      }
    }
    console.error(`Voronoi hole fill: ${holeCount.toLocaleString()} synthesized cities emitted`);
  }

  // The Voronoi-from-cities500 fallback (countries.md, Libya; VORONOI_CITY_FALLBACK's
  // doc comment has the full rationale): a hand-reviewed list of
  // countries with a confirmed, genuine absence of OSM city-tier
  // administrative polygons, not fixable by any admin_level choice.
  // Reads cities500.txt once, groups it by country here (not inside
  // voronoiFallback.ts, which stays country-agnostic), and synthesizes a
  // Voronoi city polygon per point for just the opted-in countries --
  // every other country's real OSM data is completely unaffected. Goes
  // through the same emitCity path as everything else, so a fallback
  // city still resolves to its real region via assignCityRegion.
  if (VORONOI_CITY_FALLBACK.size > 0) {
    console.error(`Voronoi fallback: loading cities500.txt for ${[...VORONOI_CITY_FALLBACK].join(", ")}...`);
    const pointsByCountry = new Map<string, Cities500Row[]>();
    for await (const row of readCities500()) {
      if (!VORONOI_CITY_FALLBACK.has(row.countryCode)) continue;
      let points = pointsByCountry.get(row.countryCode);
      if (!points) {
        points = [];
        pointsByCountry.set(row.countryCode, points);
      }
      points.push(row);
    }
    let voronoiCount = 0;
    // Every country's cells are clipped at once, then emitted in order.
    const candidatesByCountry = await Promise.all(
      [...pointsByCountry].map(([countryCode, points]) => {
        const countryPolygon = countries.simplifiedFeatureByCode.get(countryCode);
        return countryPolygon ? buildCityFallback(countryPolygon, points, clip) : [];
      }),
    );
    for (const candidates of candidatesByCountry) {
      for (const candidate of candidates) {
        const emitted = await emitCity(candidate, JSON.stringify(candidate.geometry));
        if (emitted) {
          cityCount++;
          voronoiCount++;
        }
      }
    }
    console.error(`Voronoi fallback: ${voronoiCount.toLocaleString()} synthesized cities emitted`);
  }

  // A city-state with no city polygon of its own gets one covering it all.
  for (const [code, { city }] of CITY_STATES) {
    const geometry = cityStateGeometry.get(code);
    if (!city || !geometry) continue;
    const { repPoint } = bboxAndPointOnFeature(geometry);
    if (await emitCity({ id: `city-state:${code}`, name: city, country: code, repPoint }, JSON.stringify(geometry))) {
      cityCount++;
    }
  }

  // A region that is one city (REGION_CITIES' doc comment) is its own city
  // too, unless anything else already is a city inside it.
  for (const [code, regionCities] of REGION_CITIES) {
    for (const { region, city } of regionCities) {
      const candidate = [...finalRegions.values()].find((r) => r.country === code && r.name === region);
      const inside = citiesByRegion.get(`${code}\t${region}`) ?? 0;
      if (!candidate || inside > 0) {
        console.error(
          `  WARNING: REGION_CITIES ${code} ${region}: ${candidate ? `already holds ${inside} cities` : "no such region"}, skipped`,
        );
        continue;
      }
      const geometryJson = JSON.stringify(candidate.feature.geometry);
      const { repPoint } = bboxAndPointOnFeature(candidate.feature.geometry);
      const emitted = await emitCity(
        {
          id: `region-city:${candidate.id}`,
          name: city ?? candidate.name,
          nameEn: city ? undefined : candidate.nameEn,
          country: code,
          repPoint,
          region,
        },
        geometryJson,
      );
      if (emitted) cityCount++;
    }
  }

  await new Promise<void>((resolve, reject) => cityOut.end((err?: Error | null) => (err ? reject(err) : resolve())));
  await pool.close();

  // Structural, not CityCandidateMeta itself, so a synthesized Voronoi
  // fallback candidate (voronoiFallback.ts's VoronoiCityCandidate -- no
  // level/area/bbox, since it was never an OSM relation) can be emitted
  // through the exact same path as a real one, rather than needing a
  // second, parallel emit function.
  interface EmittableCity {
    id: string;
    name: string | undefined;
    nameEn?: string | undefined;
    country: string;
    repPoint: LonLat;
    regionPoint?: LonLat | undefined;
    /** Set when the city's region is known without looking it up (REGION_CITIES). */
    region?: string;
  }
  /** `geometryJson` is the geometry's JSON text, written out as is -- for
   * an OSM city, the exact text osmium wrote, never parsed. */
  async function emitCity(candidate: EmittableCity, geometryJson: string): Promise<boolean> {
    if (!candidate.name) {
      skippedNoName++;
      return false;
    }
    const region = candidate.region ?? regionOf(candidate);
    if (!region) {
      skippedNoRegionByCountry.set(candidate.country, (skippedNoRegionByCountry.get(candidate.country) ?? 0) + 1);
      return false;
    }

    const properties: CityProperties = {
      id: candidate.id,
      name: candidate.name,
      ...(candidate.nameEn ? { nameEn: candidate.nameEn } : {}),
      region,
      country: candidate.country,
    };
    const regionKey = `${candidate.country}\t${region}`;
    citiesByRegion.set(regionKey, (citiesByRegion.get(regionKey) ?? 0) + 1);
    duplicates.add(geometryJson, properties);
    // Same bytes JSON.stringify gives a {type, properties, geometry} feature,
    // and properties-first is what filter-by-scope.ts peeks at.
    await write(`\x1e{"type":"Feature","properties":${JSON.stringify(properties)},"geometry":${geometryJson}}\n`);
    return true;
  }

  console.error("Pass 4/4: hierarchy, regions and country polygons...");
  const skippedNoRegion = [...skippedNoRegionByCountry.values()].reduce((a, b) => a + b, 0);
  console.error(
    `cities: ${cityCount} kept, ${skippedNoName} skipped (no name), ${skippedNoGeometry} skipped ` +
      `(no geometry found), ${skippedNoRegion} skipped (no region -- city/region resolution unavailable there)`,
  );
  if (skippedNoRegionByCountry.size > 0) {
    const worst = [...skippedNoRegionByCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.error(`  no-region counts by country (top 10): ${worst.map(([c, n]) => `${c}=${n}`).join(", ")}`);
  }

  // Every Natural Earth country gets a hierarchy entry, even with 0
  // regions/cities (Section 7.2 explicitly allows this) -- unlike
  // prepare-europe.ts (which derives its hierarchy purely from observed
  // city regions, fine at Europe's scale since essentially every European
  // country has at least one successfully-matched city), worldwide is far
  // more likely to have a country with 0 matched cities/regions in OSM's
  // admin_level tagging. Including it anyway means such a country still
  // resolves at country level via the compressor's spatial fallback,
  // instead of silently vanishing from the output entirely.
  // Plain code-unit order, not localeCompare: hierarchy order *is* the
  // country and region ids (Section 7.1), and localeCompare collates by the
  // machine's default locale and ICU version, so the same input could get
  // different ids on a different machine.
  const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const hierarchy: HierarchyCountry[] = [...countries.nameByCode.entries()]
    .sort(([a], [b]) => byCodeUnits(a, b))
    .map(([code, name]) => {
      const regionNames = regionNamesByCountry.get(code);
      const regionLocalNames = regionLocalNamesByCountry.get(code);
      return {
        code,
        name,
        regions: [...(regionsByCountry.get(code) ?? [])].sort(byCodeUnits),
        ...(regionNames && regionNames.size > 0 ? { regionNames: Object.fromEntries(regionNames) } : {}),
        ...(regionLocalNames ? { regionLocalNames: Object.fromEntries(regionLocalNames) } : {}),
      };
    });
  writeFileSync(HIERARCHY_OUT, JSON.stringify(hierarchy));
  console.error(
    `wrote ${HIERARCHY_OUT} (${hierarchy.length} countries, ${hierarchy.reduce((n, c) => n + c.regions.length, 0)} regions) and ${CITIES_OUT} (${cityCount} cities)`,
  );

  // Cities drawn exactly alike (DuplicateGeometries' doc comment): only one
  // of each group resolves, so they are listed for reporting.
  const duplicateGroups = duplicates.groups();
  const duplicateRows = duplicateGroups.flatMap((group, i) =>
    group.map((city) =>
      [i + 1, city.country, city.region, city.name, city.id ?? "", (city.id && osmUrlFor(city.id)) ?? ""].join("\t"),
    ),
  );
  writeFileSync(DUPLICATES_OUT, ["group\tcountry\tregion\tname\tid\tosm", ...duplicateRows, ""].join("\n"));
  const duplicatesByCountry = new Map<string, number>();
  for (const group of duplicateGroups) {
    for (const country of new Set(group.map((city) => city.country))) {
      duplicatesByCountry.set(country, (duplicatesByCountry.get(country) ?? 0) + 1);
    }
  }
  console.error(
    `wrote ${DUPLICATES_OUT} (${duplicateGroups.length} geometries shared by ${duplicateRows.length} cities; ` +
      `${[...duplicatesByCountry].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}=${n}`).join(", ")})`,
  );

  writeFileSync(COUNTRIES_OUT, `{"type":"FeatureCollection","features":[${countryFeatureJson.join(",")}]}`);
  console.error(`wrote ${COUNTRIES_OUT} (${countryFeatureJson.length} countries)`);

  // A sequence, one feature per record, like the cities: the regions are
  // unsimplified, and all of them in one string would pass Node's ~512MB
  // limit.
  const regionOut = createWriteStream(REGIONS_OUT);
  for (const r of finalRegions.values()) {
    const properties = { name: r.name, ...(r.nameEn ? { nameEn: r.nameEn } : {}), country: r.country };
    const record = `\x1e${JSON.stringify({ type: "Feature", properties, geometry: r.feature.geometry })}\n`;
    if (!regionOut.write(record)) await new Promise<void>((resolve) => regionOut.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => regionOut.end((err?: Error | null) => (err ? reject(err) : resolve())));
  console.error(`wrote ${REGIONS_OUT} (${finalRegions.size} regions)`);

  console.error(`admin relations resolving to no country: ${index.diagnostics.noCountry}`);
}

main().catch((err: unknown) => {
  console.error(err);
  // Not just exitCode: the worker threads would keep the process alive.
  process.exit(1);
});
