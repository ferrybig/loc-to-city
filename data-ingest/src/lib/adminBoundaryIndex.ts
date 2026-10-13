import area from "@turf/area";
import simplify from "@turf/simplify";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import { COUNTRY_ADMIN_LEVELS } from "./countryAdminLevels.ts";
import type { CountryIndex } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";
import { CountryPolygonIndex, loadCountryIndex, type PackedCountryPolygons } from "./countryIndex.ts";
import { streamMergedAdminBoundaries, streamMergedAdminRecords } from "./mergeAdminBoundaries.ts";
import { withOsmCountryBorders } from "./osmCountryBorders.ts";
import type { TaskHandler, WorkerPool } from "./workerPool.ts";
import { bboxAndPointOnFeature } from "./pointOnFeature.ts";
import { resolvePolygonCountry } from "./polygonCountry.ts";

// Regions are kept at full precision, like the country outlines. At 0.01
// (~1.1 km) a region part only a few times that across came out a sliver:
// Lombardy's Campione d'Italia exclave (~2 km) no longer held the comune's
// own representative point, so the comune was dropped, and so were ~480
// coastal and island cities (Cannes, Lipari, Valparaíso) whose point fell
// outside a simplified coastline. Neighbouring simplified regions also
// overlapped by up to the tolerance, and a city in the overlap went to
// whichever region the R-tree tried first. See countries.md, "Simplified
// region polygons".
const REGION_SIMPLIFY_TOLERANCE = 0; // 0 = keep every vertex

// A cheap, purely worldwide (not per-country) prefilter, applied before
// the country is even known: any admin_level outside this range is never
// used as a region or city candidate by *any* country's entry in
// COUNTRY_ADMIN_LEVELS, so there's no reason to pay for country
// resolution on it. This is not itself a source of per-country coupling
// -- it only decides whether a feature is worth resolving at all, never
// which role it plays once resolved (that's COUNTRY_ADMIN_LEVELS, purely
// per-country, see there for why that separation matters).
const PLAUSIBLE_ADMIN_LEVELS = new Set([4, 5, 6, 7, 8, 9, 10, 11]);
// Levels any country ever uses as a *region* candidate -- used only to
// decide `resolvePolygonCountry`'s sampling care (regions matter more to
// get right than an ordinary city), not to decide role or acceptance.
const REGION_SAMPLE_LEVELS = new Set([4, 5, 6]);

/** Every level any of this country's region `overrides` lists, flattened
 * -- a level here needs to survive Pass 1's `isCity` test even when it's
 * absent from the country-wide `city` list, since a candidate's region
 * (and therefore whether an override applies to it) isn't known until
 * later. */
function overrideLevels(levels: { overrides?: Record<string, number[]> } | undefined): number[] {
  if (!levels?.overrides) return [];
  return Object.values(levels.overrides).flat();
}

const overrideLevelsByCountry = new Map<string, number[]>();
function cachedOverrideLevels(country: string): number[] {
  let levels = overrideLevelsByCountry.get(country);
  if (!levels) {
    levels = overrideLevels(COUNTRY_ADMIN_LEVELS[country]);
    overrideLevelsByCountry.set(country, levels);
  }
  return levels;
}

export interface CityCandidateMeta {
  id: string;
  /** Undefined for unnamed relations -- kept (not dropped) here since Pass
   * 1's area accumulation shouldn't be skewed by name availability; final
   * assembly in prepare-world.ts drops nameless survivors, mirroring
   * prepare-europe.ts's own null-name filtering. */
  name: string | undefined;
  /** OSM's `name:en` tag, when present (README.md's "International/local
   * name pairs" item). Purely a display addition -- never part of any
   * join/dedup key, so it can be missing or inconsistent without affecting
   * matching. */
  nameEn: string | undefined;
  country: string;
  level: number;
  area: number;
  repPoint: LonLat;
  /** Set when `repPoint` is a boundary vertex: a point strictly inside,
   * which region assignment uses instead (see `interiorPoint`). */
  regionPoint?: LonLat;
  bbox: BBox;
}

export interface RegionCandidate {
  id: string;
  name: string;
  /** OSM's `name:en` tag, when present -- see CityCandidateMeta.nameEn. */
  nameEn: string | undefined;
  country: string;
  /** The admin_level this candidate was tagged at. A country's own
   * COUNTRY_ADMIN_LEVELS entry keeps its region and city level lists
   * disjoint, so unlike before this never needs cross-checking against
   * what a *different* country does with the same level number. */
  level: number;
  bbox: BBox;
  feature: Feature<Polygon | MultiPolygon, { name?: string }>;
}

export interface AdminBoundaryIndexDiagnostics {
  scanned: number;
  keptCity: number;
  keptRegion: number;
  noCountry: number;
}

export interface AdminBoundaryIndex {
  cityCandidates: CityCandidateMeta[];
  /** Pass 1's area accumulation: country -> admin_level -> total area (km^2),
   * for whichever levels that country's own COUNTRY_ADMIN_LEVELS.city
   * lists. `selectPrimaryLevels` picks the best of just those levels. */
  areaByCountryLevel: Map<string, Map<number, number>>;
  /** Same accumulation, for each country's own COUNTRY_ADMIN_LEVELS.region
   * list -- `selectRegionLevels` picks the best of just those levels. */
  regionAreaByCountryLevel: Map<string, Map<number, number>>;
  /** Final region polygons, deduped by (country, level, name) -- prefers
   * the larger bbox on a genuine duplicate/fragmentary match, same rule
   * `prepare-europe.ts`'s `extractRegionPolygons` already uses. Unlike
   * that function, country is resolved directly per relation (via
   * `resolvePolygonCountry`), not reverse-engineered from a pre-resolved
   * cities list -- there is no such list at world scale. Includes every
   * level in a country's own `region` list, not just the level that ends
   * up winning; callers filter by `selectRegionLevels`'s result before
   * using these as the final region layer. */
  regionsByCountryName: Map<string, RegionCandidate>;
  diagnostics: AdminBoundaryIndexDiagnostics;
}

interface AdminBoundaryProps {
  admin_level?: string;
  name?: string;
  "name:en"?: string;
  natural?: string;
}

/** What Pass 1 keeps of one relation (`classifyAdminFeature`): null when
 * it is no candidate at all. */
export type AdminFeatureClass = null | { noCountry: true } | AdminCandidate;

export interface AdminCandidate {
  noCountry?: undefined;
  country: string;
  level: number;
  name: string | undefined;
  nameEn: string | undefined;
  repPoint: LonLat;
  regionPoint?: LonLat;
  bbox: BBox;
  /** km^2. */
  area: number;
  isCity: boolean;
  /** Counts toward the country-wide `city` vote (not an override-only level). */
  cityVote: boolean;
  /** Set for a named region candidate: its polygon (see REGION_SIMPLIFY_TOLERANCE). */
  region?: Feature<Polygon | MultiPolygon, { name?: string }>;
}

/** Pass 1's per-relation work, which needs nothing from any other
 * relation -- so worker threads can run it (`adminBoundaryHandlers`),
 * leaving only `AdminBoundaryAccumulator` to see every relation in order.
 *
 * Which role a feature plays (region candidate, city candidate, neither,
 * or -- at a level a country lists for both roles independently -- both)
 * is decided per country from `COUNTRY_ADMIN_LEVELS`, looked up only
 * after the country itself is resolved; `PLAUSIBLE_ADMIN_LEVELS` is just
 * a cheap, country-agnostic prefilter so country resolution -- the
 * expensive part -- is never attempted on a level nothing anywhere
 * uses.
 *
 * `outlineAt` places what Natural Earth places nowhere (see
 * `resolvePolygonCountry`). */
export function classifyAdminFeature(
  feature: Feature,
  countries: Pick<CountryIndex, "lookup">,
  outlineAt?: (point: LonLat) => string | null,
): AdminFeatureClass {
  const props = feature.properties as AdminBoundaryProps | null;
  const levelRaw = props?.admin_level;
  if (!levelRaw) return null;
  const level = Number(levelRaw);
  if (!PLAUSIBLE_ADMIN_LEVELS.has(level)) return null;
  // An island's coastline multipolygon with admin tags added (Penghu's
  // islets at admin_level=4, Indonesia's at 5), not an administrative
  // unit. Worldwide that is 143 named region candidates and 1,103 city
  // candidates, all of them islands, islets or skerries by name; as a
  // region each became a "province" of its country.
  if (props?.natural === "coastline") return null;

  const geometry = feature as Feature<Polygon | MultiPolygon>;
  // Still needed as a point known to lie on the feature (gap-fill and
  // region assignment test it for containment), but no longer trusted
  // to say which country the feature is in -- see polygonCountry.ts.
  const { bbox: featureBbox, repPoint, interiorPoint } = bboxAndPointOnFeature(geometry.geometry);
  const country = resolvePolygonCountry(geometry, featureBbox, repPoint, countries as CountryIndex, {
    alwaysSample: REGION_SAMPLE_LEVELS.has(level),
    ...(outlineAt ? { outlineAt } : {}),
  });
  if (!country) return { noCountry: true };

  const levels = COUNTRY_ADMIN_LEVELS[country];
  // A superset check: a level that's only an override level for one of
  // this country's regions (not in the country-wide `city` list) still
  // needs to survive Pass 1, since which region a candidate belongs to
  // isn't known until regions are resolved, later in prepare-world.ts.
  // Routing a surviving candidate to its actual region/level (override
  // vs. country-wide) happens there, not here.
  const isCity = (levels?.city.includes(level) ?? false) || cachedOverrideLevels(country).includes(level);
  const name = props?.name;
  const isRegion = (levels?.region.includes(level) ?? false) && !!name;
  if (!isCity && !isRegion) return null;

  return {
    country,
    level,
    name,
    nameEn: props?.["name:en"],
    repPoint,
    ...(interiorPoint !== repPoint ? { regionPoint: interiorPoint } : {}),
    bbox: featureBbox,
    area: area(geometry) / 1_000_000, // m^2 -> km^2
    isCity,
    // Area accumulates only for the country-wide `city` vote -- an
    // override-only level (a candidate that survived solely because some
    // region's override list includes it) never competes for the
    // country's own primary level.
    cityVote: levels?.city.includes(level) ?? false,
    ...(isRegion
      ? {
          region: {
            ...(REGION_SIMPLIFY_TOLERANCE > 0 ? simplify(geometry, { tolerance: REGION_SIMPLIFY_TOLERANCE }) : geometry),
            properties: { name: name! },
          },
        }
      : {}),
  };
}

/** Pass 1's in-order half: folds each relation's `AdminFeatureClass` into
 * the index, in corpus order (which decides candidate order and which of
 * two same-named regions wins a tie). */
class AdminBoundaryAccumulator {
  readonly cityCandidates: CityCandidateMeta[] = [];
  readonly areaByCountryLevel = new Map<string, Map<number, number>>();
  readonly regionAreaByCountryLevel = new Map<string, Map<number, number>>();
  readonly regionsByCountryName = new Map<string, RegionCandidate>();
  readonly diagnostics: AdminBoundaryIndexDiagnostics = { scanned: 0, keptCity: 0, keptRegion: 0, noCountry: 0 };

  add(id: string, c: AdminFeatureClass): void {
    const diagnostics = this.diagnostics;
    diagnostics.scanned++;
    if (diagnostics.scanned % 500_000 === 0) {
      console.error(
        `adminBoundaryIndex: ${diagnostics.scanned} scanned, ${diagnostics.keptCity} city candidates, ` +
          `${diagnostics.keptRegion} region candidates, ${diagnostics.noCountry} no-country`,
      );
    }
    if (c === null) return;
    if (c.noCountry) {
      diagnostics.noCountry++;
      return;
    }
    const { country, level } = c;

    if (c.isCity) {
      this.cityCandidates.push({
        id,
        name: c.name,
        nameEn: c.nameEn,
        country,
        level,
        area: c.area,
        repPoint: c.repPoint,
        ...(c.regionPoint ? { regionPoint: c.regionPoint } : {}),
        bbox: c.bbox,
      });
      // `cityCandidates` above still holds an override-only candidate;
      // routing happens once each candidate's region is known, in
      // prepare-world.ts.
      if (c.cityVote) addArea(this.areaByCountryLevel, country, level, c.area);
      diagnostics.keptCity++;
    }

    if (!c.region) return;
    addArea(this.regionAreaByCountryLevel, country, level, c.area);
    const name = c.name!;
    const key = `${country} ${level} ${name}`;
    const existing = this.regionsByCountryName.get(key);
    if (!existing || bboxArea(c.bbox) > bboxArea(existing.bbox)) {
      this.regionsByCountryName.set(key, {
        id,
        name,
        nameEn: c.nameEn,
        country,
        level,
        bbox: c.bbox,
        feature: c.region,
      });
    }
    diagnostics.keptRegion++;
  }

  finish(): AdminBoundaryIndex {
    const { cityCandidates, areaByCountryLevel, regionAreaByCountryLevel, regionsByCountryName, diagnostics } = this;
    console.error(
      `adminBoundaryIndex: done -- ${diagnostics.scanned} scanned, ${diagnostics.keptCity} city candidates, ` +
        `${diagnostics.keptRegion} region matches (${regionsByCountryName.size} unique), ${diagnostics.noCountry} no-country`,
    );
    return { cityCandidates, areaByCountryLevel, regionAreaByCountryLevel, regionsByCountryName, diagnostics };
  }
}

function addArea(byCountry: Map<string, Map<number, number>>, country: string, level: number, value: number): void {
  let byLevel = byCountry.get(country);
  if (!byLevel) {
    byLevel = new Map();
    byCountry.set(country, byLevel);
  }
  byLevel.set(level, (byLevel.get(level) ?? 0) + value);
}

/** Pass 1 of the 3-pass admin_level auto-detection (README.md's "Europe
 * scaling test"): one full streaming read of the merged, deduplicated
 * corpus, computing just enough per candidate relation (area,
 * representative point, bbox, resolved country) to run Pass 2/3's
 * selection logic without holding any full polygon geometry -- memory
 * bounded by candidate *count*, not corpus size.
 *
 * With a `pool` (one whose workers got `AdminBoundaryWorkerData`), the
 * per-relation work (`classifyAdminFeature`: parsing, country
 * resolution, area) runs on its threads, in batches of raw records, and
 * the results are folded in in corpus order -- the same index the main
 * thread alone builds. */
export async function buildAdminBoundaryIndex(
  files: string[],
  countries: CountryIndex,
  outlineAt?: (point: LonLat) => string | null,
  pool?: WorkerPool,
): Promise<AdminBoundaryIndex> {
  const accumulator = new AdminBoundaryAccumulator();
  if (!pool || pool.size === 0) {
    for await (const { id, feature } of streamMergedAdminBoundaries(files)) {
      accumulator.add(id, classifyAdminFeature(feature, countries, outlineAt));
    }
    return accumulator.finish();
  }

  // Batches in flight, oldest first; enough to keep every thread busy
  // while the oldest is being waited for.
  const inFlight: { ids: string[]; results: Promise<AdminFeatureClass[]> }[] = [];
  const maxInFlight = pool.size * 3;
  let ids: string[] = [];
  let records: Buffer[] = [];
  let bytes = 0;
  const send = (): void => {
    const batch = new Uint8Array(bytes);
    const ends = new Int32Array(records.length);
    let offset = 0;
    records.forEach((record, i) => {
      batch.set(record, offset);
      offset += record.length;
      ends[i] = offset;
    });
    inFlight.push({
      ids,
      results: pool.run<AdminFeatureClass[]>("classifyAdminRecords", { batch, ends }, [batch.buffer, ends.buffer], bytes),
    });
    ids = [];
    records = [];
    bytes = 0;
  };
  const drainOne = async (): Promise<void> => {
    const { ids: batchIds, results } = inFlight.shift()!;
    const classes = await results;
    batchIds.forEach((id, i) => accumulator.add(id, classes[i]!));
  };

  for await (const { id, record } of streamMergedAdminRecords(files)) {
    ids.push(id);
    records.push(record);
    bytes += record.length;
    if (bytes < BATCH_BYTES && records.length < BATCH_RECORDS) continue;
    send();
    if (inFlight.length >= maxInFlight) await drainOne();
  }
  if (records.length > 0) send();
  while (inFlight.length > 0) await drainOne();
  return accumulator.finish();
}

const BATCH_BYTES = 4 * 1024 * 1024;
/** Raw record bytes a Pass 1 pool may be parsing at once (its `maxWeight`):
 * a relation's parsed form takes several times its text, and the biggest
 * country relations run to hundreds of MB. */
export const PASS1_MAX_BYTES = 512 * 1024 * 1024;
const BATCH_RECORDS = 1024;

/** What `buildAdminBoundaryIndex`'s pool workers need to resolve countries
 * the way the main thread does: Natural Earth (read from its file) plus
 * the same OSM borders and drawn outlines, shared rather than copied. */
export interface AdminBoundaryWorkerData {
  naturalEarthPath: string;
  osmBorders: PackedCountryPolygons;
  outlines: PackedCountryPolygons;
}

/** The worker side of `buildAdminBoundaryIndex`'s pool. The country index
 * is built on the first batch, from `workerData`. */
export function adminBoundaryHandlers(workerData: Partial<AdminBoundaryWorkerData> | undefined): Record<string, TaskHandler> {
  let resolver: { countries: CountryIndex; outlineAt: (point: LonLat) => string | null } | undefined;
  return {
    classifyAdminRecords({ batch, ends }: { batch: Uint8Array; ends: Int32Array }) {
      if (!resolver) {
        const { naturalEarthPath, osmBorders, outlines } = workerData ?? {};
        if (!naturalEarthPath || !osmBorders || !outlines) throw new Error("worker has no AdminBoundaryWorkerData");
        const outlineIndex = CountryPolygonIndex.fromPacked(outlines);
        resolver = {
          countries: withOsmCountryBorders(loadCountryIndex(naturalEarthPath), CountryPolygonIndex.fromPacked(osmBorders)),
          outlineAt: ([x, y]) => outlineIndex.first(x, y),
        };
      }
      const buffer = Buffer.from(batch.buffer, batch.byteOffset, batch.byteLength);
      const result: AdminFeatureClass[] = [];
      let start = 0;
      for (const end of ends) {
        const feature = JSON.parse(buffer.toString("utf8", start, end)) as Feature;
        result.push(classifyAdminFeature(feature, resolver.countries, resolver.outlineAt));
        start = end;
      }
      return { result };
    },
  };
}

function bboxArea(b: BBox): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
