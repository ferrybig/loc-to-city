import { readFileSync } from "node:fs";
import RBush from "rbush";
import area from "@turf/area";
import simplify from "@turf/simplify";
import type { Feature, FeatureCollection, Polygon, MultiPolygon, Position } from "geojson";
import type { LonLat } from "./geo.ts";

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
 * point. Vertices are packed `x0, y0, x1, y1, ...` into one Float64Array:
 * OSM's own country borders (see osmCountryBorders.ts) run to tens of
 * millions of vertices, which as GeoJSON `[x, y]` arrays would cost
 * several times the memory. */
interface IndexedRing {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  xy: Float64Array;
  /** Edge indices bucketed by horizontal band, or null for small rings.
   * Rejecting island rings by bbox isn't enough on its own: a mainland
   * outer ring still has tens of thousands of edges, and a ray cast that
   * walks all of them is ~50us. With edges bucketed by the band of y they
   * span, a cast only touches the few hundred edges near the query's y. */
  bands: Int32Array[] | null;
  bandHeight: number;
}

/** One polygon: an outer ring plus its holes. */
export interface IndexedPolygon {
  outer: IndexedRing;
  holes: IndexedRing[];
}

/** One polygon of a country, as its own rbush entry: a country made of
 * thousands of islands (Norway, Canada, Indonesia) would otherwise have
 * every one of them walked, even if each is only a bbox reject, on every
 * lookup that lands anywhere in the country's overall bbox. Measured at
 * 7.05us -> 1.83us per lookup over FR/DE/NL/NO/CA/ID. */
interface IndexedCountryPolygon {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  code: string;
  polygon: IndexedPolygon;
}

const BAND_MIN_VERTICES = 256;
const VERTICES_PER_BAND = 32;

/** Indexes one ring of packed `x, y` pairs (see `IndexedRing`). */
export function indexPackedRing(xy: Float64Array): IndexedRing {
  const n = xy.length / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xy[2 * i]!;
    const y = xy[2 * i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  let bands: Int32Array[] | null = null;
  let bandHeight = maxY - minY;
  if (n >= BAND_MIN_VERTICES && bandHeight > 0) {
    const bandCount = Math.ceil(n / VERTICES_PER_BAND);
    bandHeight /= bandCount;
    const lists: number[][] = Array.from({ length: bandCount }, () => []);
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = xy[2 * i + 1]!;
      const yj = xy[2 * j + 1]!;
      const lo = Math.floor((Math.min(yi, yj) - minY) / bandHeight);
      const hi = Math.min(bandCount - 1, Math.floor((Math.max(yi, yj) - minY) / bandHeight));
      for (let b = lo; b <= hi; b++) lists[b]!.push(i);
    }
    bands = lists.map((list) => Int32Array.from(list));
  }
  return { minX, minY, maxX, maxY, xy, bands, bandHeight };
}

function packRing(coords: Position[]): Float64Array {
  const xy = new Float64Array(coords.length * 2);
  coords.forEach(([x = 0, y = 0], i) => {
    xy[2 * i] = x;
    xy[2 * i + 1] = y;
  });
  return xy;
}

function indexPolygons(geometry: Polygon | MultiPolygon): IndexedPolygon[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .filter((rings) => rings.length > 0)
    .map((rings) => ({ outer: indexPackedRing(packRing(rings[0]!)), holes: rings.slice(1).map((r) => indexPackedRing(packRing(r))) }));
}

/** Even-odd ray cast; a point exactly on an edge may land either way,
 * which is fine for a lookup that is sampled or majority-voted by its
 * callers, and no worse than what turf did. */
function ringContains(ring: IndexedRing, x: number, y: number): boolean {
  if (x < ring.minX || x > ring.maxX || y < ring.minY || y > ring.maxY) return false;
  const { xy, bands } = ring;
  const n = xy.length / 2;
  let inside = false;
  const crosses = (i: number, j: number): void => {
    const xi = xy[2 * i]!;
    const yi = xy[2 * i + 1]!;
    const xj = xy[2 * j]!;
    const yj = xy[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  };
  if (bands) {
    const band = bands[Math.min(bands.length - 1, Math.floor((y - ring.minY) / ring.bandHeight))]!;
    for (const i of band) crosses(i, i === 0 ? n - 1 : i - 1);
  } else {
    for (let i = 0, j = n - 1; i < n; j = i++) crosses(i, j);
  }
  return inside;
}

function polygonContains({ outer, holes }: IndexedPolygon, x: number, y: number): boolean {
  return ringContains(outer, x, y) && !holes.some((hole) => ringContains(hole, x, y));
}

/** Country polygons, one rbush entry per polygon (see
 * `IndexedCountryPolygon`), answering which codes contain a point. */
export class CountryPolygonIndex {
  private readonly items: IndexedCountryPolygon[] = [];
  private tree: RBush<IndexedCountryPolygon> | null = null;
  readonly codes = new Set<string>();

  add(code: string, polygons: IndexedPolygon[]): void {
    for (const polygon of polygons) {
      const { minX, minY, maxX, maxY } = polygon.outer;
      this.items.push({ minX, minY, maxX, maxY, code, polygon });
    }
    this.codes.add(code);
    this.tree = null;
  }

  private search(x: number, y: number): IndexedCountryPolygon[] {
    if (!this.tree) this.tree = new RBush<IndexedCountryPolygon>().load(this.items);
    return this.tree.search({ minX: x, minY: y, maxX: x, maxY: y });
  }

  /** The first containing polygon's code, in rbush order. */
  first(x: number, y: number): string | null {
    for (const hit of this.search(x, y)) {
      if (polygonContains(hit.polygon, x, y)) return hit.code;
    }
    return null;
  }

  /** Every code with a polygon containing the point, in rbush order. */
  codesAt(x: number, y: number): string[] {
    const codes: string[] = [];
    for (const hit of this.search(x, y)) {
      if (!codes.includes(hit.code) && polygonContains(hit.polygon, x, y)) codes.push(hit.code);
    }
    return codes;
  }
}

/** Worldwide, indexed country resolution from Natural Earth's admin-0
 * countries (`data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson`,
 * already worldwide in scope -- no changes needed there). Promoted out of
 * `prepare-europe.ts`'s inline `loadCountryPolygons` because world-scale
 * admin-boundary resolution runs millions of point tests, not a few
 * hundred, and needs a bbox prefilter to stay fast. */
export interface CountryIndex {
  /** Exact point-in-polygon lookup (bbox-prefiltered per polygon via
   * rbush, then per-ring bbox), against unsimplified Natural Earth geometry. Returns
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
 * file. See history.md's "How much precision these tolerances cost".
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
  const index = new CountryPolygonIndex();

  for (const [code, feature] of byCode) {
    areaByCode.set(code, area(feature) / 1_000_000); // m^2 -> km^2
    nameByCode.set(code, feature.properties.NAME ?? code);
    const simplified =
      COUNTRY_SIMPLIFY_TOLERANCE <= 0 ? feature : simplify(feature, { tolerance: COUNTRY_SIMPLIFY_TOLERANCE });
    simplifiedFeatureByCode.set(code, { ...simplified, properties: { code } });

    index.add(code, indexPolygons(feature.geometry));
  }

  const lookup = (point: LonLat): string | null => index.first(point[0], point[1]);

  return { lookup, areaByCode, nameByCode, simplifiedFeatureByCode };
}
