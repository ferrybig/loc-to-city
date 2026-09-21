import { readFileSync } from "node:fs";
import RBush from "rbush";
import bbox from "@turf/bbox";
import area from "@turf/area";
import simplify from "@turf/simplify";
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position } from "geojson";
import type { LonLat } from "./geo.js";

interface NECountryProps {
  ISO_A2_EH?: string;
  ISO_A2?: string;
  NAME?: string;
  POP_EST?: number;
}

/** One ring with its bbox, so a point-in-polygon test can reject whole
 * rings by bbox before walking their edges. Natural Earth's coastlines
 * give countries like Norway or Canada thousands of island rings, and
 * turf's `booleanPointInPolygon` walks every one of them on every call
 * (100-200us per lookup on land, measured); with the bbox reject a lookup
 * is dominated by the one or two rings that could actually contain the
 * point. */
interface IndexedRing {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  coords: Position[];
  /** Edge indices bucketed by horizontal band, or null for small rings.
   * Rejecting island rings by bbox isn't enough on its own: a mainland
   * outer ring still has tens of thousands of edges, and a ray cast that
   * walks all of them is ~50us. With edges bucketed by the band of y they
   * span, a cast only touches the few hundred edges near the query's y. */
  bands: number[][] | null;
  bandHeight: number;
}

/** One polygon: an outer ring plus its holes. */
interface IndexedPolygon {
  outer: IndexedRing;
  holes: IndexedRing[];
}

interface IndexedCountry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  code: string;
  polygons: IndexedPolygon[];
}

const BAND_MIN_VERTICES = 256;
const VERTICES_PER_BAND = 32;

function indexRing(coords: Position[]): IndexedRing {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x = 0, y = 0] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  let bands: number[][] | null = null;
  let bandHeight = maxY - minY;
  if (coords.length >= BAND_MIN_VERTICES && bandHeight > 0) {
    const bandCount = Math.ceil(coords.length / VERTICES_PER_BAND);
    bandHeight /= bandCount;
    bands = Array.from({ length: bandCount }, () => []);
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const yi = coords[i]![1] ?? 0;
      const yj = coords[j]![1] ?? 0;
      const lo = Math.floor((Math.min(yi, yj) - minY) / bandHeight);
      const hi = Math.min(bandCount - 1, Math.floor((Math.max(yi, yj) - minY) / bandHeight));
      for (let b = lo; b <= hi; b++) bands[b]!.push(i);
    }
  }
  return { minX, minY, maxX, maxY, coords, bands, bandHeight };
}

function indexPolygons(geometry: Polygon | MultiPolygon): IndexedPolygon[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .filter((rings) => rings.length > 0)
    .map((rings) => ({ outer: indexRing(rings[0]!), holes: rings.slice(1).map(indexRing) }));
}

/** Even-odd ray cast; a point exactly on an edge may land either way,
 * which is fine for a lookup that is sampled or majority-voted by its
 * callers, and no worse than what turf did. */
function ringContains(ring: IndexedRing, x: number, y: number): boolean {
  if (x < ring.minX || x > ring.maxX || y < ring.minY || y > ring.maxY) return false;
  const { coords, bands } = ring;
  let inside = false;
  const crosses = (i: number, j: number): void => {
    const [xi = 0, yi = 0] = coords[i]!;
    const [xj = 0, yj = 0] = coords[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  };
  if (bands) {
    const band = bands[Math.min(bands.length - 1, Math.floor((y - ring.minY) / ring.bandHeight))]!;
    for (const i of band) crosses(i, i === 0 ? coords.length - 1 : i - 1);
  } else {
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) crosses(i, j);
  }
  return inside;
}

function polygonsContain(polygons: IndexedPolygon[], x: number, y: number): boolean {
  for (const { outer, holes } of polygons) {
    if (!ringContains(outer, x, y)) continue;
    if (holes.some((hole) => ringContains(hole, x, y))) continue;
    return true;
  }
  return false;
}

/** Worldwide, indexed country resolution from Natural Earth's admin-0
 * countries (`agent-resources/ne_10m_admin_0_countries.geojson`, already
 * worldwide in scope -- no changes needed there). Promoted out of
 * `prepare-europe.ts`'s inline `loadCountryPolygons` because world-scale
 * admin-boundary resolution runs millions of point tests, not a few
 * hundred, and needs a bbox prefilter to stay fast. */
export interface CountryIndex {
  /** Exact point-in-polygon lookup (bbox-prefiltered via rbush, then
   * per-ring bbox), against unsimplified Natural Earth geometry. Returns
   * the ISO_A2_EH code, or null if the point falls inside no country (open
   * ocean, a gap in NE's coverage, etc.). A single point is a fragile way
   * to place a whole polygon -- see polygonCountry.ts for why and for what
   * to use instead. */
  lookup(point: LonLat): string | null;
  /** Unsimplified area per country, km^2 -- the denominator for Pass 2's
   * "does this admin_level's area cover >=60% of the country" ratio. */
  areaByCode: Map<string, number>;
  nameByCode: Map<string, string>;
  /** Simplified (COUNTRY_SIMPLIFY_TOLERANCE) polygon per country, for the
   * compressor's country-polygon output layer -- same simplification
   * `prepare-europe.ts` already applies for the same reason (country
   * polygons are a coarse fallback layer, not precision-critical). */
  simplifiedFeatureByCode: Map<string, Feature<Polygon | MultiPolygon, { code: string }>>;
}

/** Country outlines are kept at Natural Earth's full 10m precision. They
 * used to be simplified to ~5.5km because vertex count drove the
 * compressor's dominant cost, but the segment/rectangle classifier made
 * that affordable: on Europe, full precision costs about four minutes
 * instead of thirty seconds and removes ~500 of 361,201 sampled points
 * that a 5.5km outline gets wrong -- all of them on coastlines and
 * borders, answering "unknown" where a country was meant, or the reverse.
 * Build time is paid once per rebuild; that error would ship in every
 * file. See README's "How much precision these tolerances cost".
 *
 * Regions are a different trade and stay simplified -- see
 * adminBoundaryIndex.ts. */
const COUNTRY_SIMPLIFY_TOLERANCE = 0; // 0 = keep every vertex

export function loadCountryIndex(neCountriesPath: string): CountryIndex {
  const data = JSON.parse(readFileSync(neCountriesPath, "utf8")) as FeatureCollection<
    Polygon | MultiPolygon,
    NECountryProps
  >;

  // A handful of ISO_A2_EH codes (France is the one that matters here)
  // have more than one Natural Earth feature (mainland + a dependency) --
  // keep the most populous one. ISO_A2 itself is literally "-99" for
  // France (a long-documented NE artifact), so ISO_A2_EH ("everywhere,
  // including disputed") is used instead -- same fix prepare-europe.ts
  // already applies.
  const byCode = new Map<string, Feature<Polygon | MultiPolygon, NECountryProps>>();
  for (const feature of data.features) {
    const code = feature.properties.ISO_A2_EH;
    if (!code || code === "-99") continue;
    const existing = byCode.get(code);
    if (!existing || (feature.properties.POP_EST ?? 0) > (existing.properties.POP_EST ?? 0)) {
      byCode.set(code, feature);
    }
  }

  const areaByCode = new Map<string, number>();
  const nameByCode = new Map<string, string>();
  const simplifiedFeatureByCode = new Map<string, Feature<Polygon | MultiPolygon, { code: string }>>();
  const items: IndexedCountry[] = [];

  for (const [code, feature] of byCode) {
    areaByCode.set(code, area(feature) / 1_000_000); // m^2 -> km^2
    nameByCode.set(code, feature.properties.NAME ?? code);
    const simplified =
      COUNTRY_SIMPLIFY_TOLERANCE <= 0 ? feature : simplify(feature, { tolerance: COUNTRY_SIMPLIFY_TOLERANCE });
    simplifiedFeatureByCode.set(code, { ...simplified, properties: { code } });

    const [minX, minY, maxX, maxY] = bbox(feature);
    items.push({ minX, minY, maxX, maxY, code, polygons: indexPolygons(feature.geometry) });
  }

  const tree = new RBush<IndexedCountry>();
  tree.load(items);

  function lookup(point: LonLat): string | null {
    const [x, y] = point;
    const hits = tree.search({ minX: x, minY: y, maxX: x, maxY: y });
    for (const hit of hits) {
      if (polygonsContain(hit.polygons, x, y)) return hit.code;
    }
    return null;
  }

  return { lookup, areaByCode, nameByCode, simplifiedFeatureByCode };
}
