import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { CountryIndex, IndexedPolygon } from "./countryIndex.ts";
import { CountryPolygonIndex, indexPackedRing } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";
import { peekOsmiumProperties, splitOsmiumFeature } from "./geojsonseqStream.ts";
import { streamMergedAdminRecords } from "./mergeAdminBoundaries.ts";

interface CountryBorderProps {
  admin_level?: string;
  "ISO3166-1:alpha2"?: string;
  "ISO3166-1"?: string;
}

/** OSM's own country borders (`admin_level=2` relations), indexed by the
 * same ISO 3166-1 alpha-2 codes Natural Earth's `ISO_A2_EH` uses. Only
 * codes Natural Earth also has are kept, so this can never introduce a
 * country the hierarchy doesn't list. */
export async function loadOsmCountryBorders(
  files: string[],
  knownCodes: ReadonlySet<string>,
): Promise<CountryPolygonIndex> {
  const index = new CountryPolygonIndex();
  let relations = 0;
  let vertices = 0;
  for await (const { record, parsed } of streamMergedAdminRecords(files)) {
    const props = (parsed?.properties ?? peekOsmiumProperties(record)) as CountryBorderProps | null | undefined;
    if (props?.admin_level !== "2") continue;
    const code = (props["ISO3166-1:alpha2"] ?? props["ISO3166-1"])?.toUpperCase();
    if (!code || !knownCodes.has(code)) continue;

    const geometryJson = parsed ? undefined : splitOsmiumFeature(record)?.geometryJson;
    const polygons = geometryJson
      ? (packPolygons(geometryJson) ?? indexGeometry(JSON.parse(geometryJson) as Polygon | MultiPolygon))
      : indexGeometry((parsed ?? (JSON.parse(record.toString("utf8")) as Feature)).geometry as Polygon | MultiPolygon);
    index.add(code, polygons);
    relations++;
    for (const p of polygons) vertices += [p.outer, ...p.holes].reduce((n, r) => n + r.xy.length / 2, 0);
  }
  console.error(
    `loadOsmCountryBorders: ${relations} admin_level=2 relations for ${index.codes.size} countries, ` +
      `${vertices.toLocaleString()} vertices`,
  );
  return index;
}

/** Natural Earth, corrected by OSM's own country borders where the two
 * disagree outright: a point Natural Earth puts in country X, while OSM
 * has a border for X that doesn't contain it but does have another
 * country's border that does, resolves to that other country.
 *
 * Natural Earth's 10m outlines are too coarse for enclaves -- Baarle-
 * Hertog's ~22 Belgian enclaves inside the Netherlands don't exist there,
 * so every Belgian polygon in them resolved to NL and was dropped -- and
 * only approximately follow land borders. Natural Earth still decides
 * everywhere else: where OSM has no border for its answer (a dependency OSM
 * folds into its parent country, say), where OSM agrees, and where OSM puts
 * the point in no country at all. Points Natural Earth puts at sea stay at
 * sea, even though OSM's borders include territorial waters --
 * polygonCountry.ts depends on that. */
export function withOsmCountryBorders(countries: CountryIndex, borders: CountryPolygonIndex): CountryIndex {
  const lookup = (point: LonLat): string | null => {
    const ne = countries.lookup(point);
    if (ne === null || !borders.codes.has(ne)) return ne;
    const osm = borders.codesAt(point[0], point[1]);
    if (osm.length === 0 || osm.includes(ne)) return ne;
    return osm[0]!;
  };
  return { ...countries, lookup };
}

function indexGeometry(geometry: Polygon | MultiPolygon): IndexedPolygon[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons
    .filter((rings) => rings.length > 0)
    .map((rings) => {
      const [outer, ...holes] = rings.map((ring) => indexPackedRing(Float64Array.from(ring.flatMap(([x = 0, y = 0]) => [x, y]))));
      return { outer: outer!, holes };
    });
}

/** Parses a Polygon/MultiPolygon's JSON text straight into packed rings,
 * without building a JS array per vertex first -- a country border can
 * run to millions of vertices. Undefined for anything else (the caller
 * falls back to JSON.parse). */
export function packPolygons(geometryJson: string): IndexedPolygon[] | undefined {
  const typeMatch = /^\{"type":"(Polygon|MultiPolygon)","coordinates":\[/.exec(geometryJson);
  if (!typeMatch) return undefined;
  // Depth of the bracket that holds one [x, y] pair, counting the
  // "coordinates" array itself as depth 1.
  const pointDepth = typeMatch[1] === "Polygon" ? 3 : 4;
  const polygons: IndexedPolygon[] = [];
  let rings: IndexedPolygon["holes"] = [];
  let ring: number[] = [];
  let pointValues = 0;
  let depth = 1;
  let i = typeMatch[0].length;
  for (; i < geometryJson.length && depth > 0; i++) {
    const c = geometryJson.charCodeAt(i);
    if (c === 0x5b) {
      depth++;
    } else if (c === 0x5d) {
      if (depth === pointDepth) {
        if (pointValues !== 2) return undefined;
        pointValues = 0;
      } else if (depth === pointDepth - 1) {
        rings.push(indexPackedRing(Float64Array.from(ring)));
        ring = [];
      } else if (depth === pointDepth - 2) {
        const [outer, ...holes] = rings;
        if (outer) polygons.push({ outer, holes });
        rings = [];
      }
      depth--;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      if (depth !== pointDepth) return undefined;
      let end = i + 1;
      while (end < geometryJson.length) {
        const d = geometryJson.charCodeAt(end);
        if (d === 0x2c || d === 0x5d) break;
        end++;
      }
      const value = Number(geometryJson.slice(i, end));
      if (!Number.isFinite(value)) return undefined;
      ring.push(value);
      pointValues++;
      i = end - 1;
    } else if (c !== 0x2c && c !== 0x20) {
      return undefined;
    }
  }
  if (depth !== 0 || geometryJson.slice(i) !== "}") return undefined;
  return polygons;
}
