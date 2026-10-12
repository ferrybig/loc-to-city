import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import type { CountryIndex } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";

/** Resolves which country an admin polygon belongs to.
 *
 * The first worldwide build placed every polygon by a single
 * `pointOnFeature` lookup against Natural Earth, and that point is a poor
 * witness for the whole shape: turf's `pointOnFeature` is the bbox
 * midpoint, or the nearest vertex to it when the midpoint falls outside
 * the polygon. Checked against a cities500 cross-reference, that single
 * point went wrong three different ways:
 *
 *  - midpoint inside the polygon but in the sea per Natural Earth, because
 *    OSM relations include territorial waters: Scotland, Wales, Alaska,
 *    Hawaii, Florida, Tokyo (its prefecture reaches 1,000km south through
 *    the Izu/Ogasawara islands), Okinawa, every province of Java. Each
 *    region was silently dropped and with it every city inside it.
 *  - midpoint outside the polygon, so the nearest vertex -- a border point
 *    by construction -- decided: Basel-Stadt filed under Germany, Odessa
 *    Oblast under Moldova.
 *  - midpoint on land but in a border river or reservoir: Mehedinti under
 *    Serbia (the Iron Gates).
 *
 * So the country is decided by a majority of sampled interior points
 * instead. Regions always sample. Cities take a fast path first, since
 * there are ~900k of them: the representative point plus the four bbox
 * corners, accepted when the representative point resolves and every
 * corner that resolves agrees with it. Corners in the sea don't disqualify
 * a coastal city; a corner in another country, or a representative point
 * that resolves nowhere, does, and the polygon is sampled.
 *
 * A polygon Natural Earth places nowhere at all, not one sample on land,
 * is asked of `options.outlineAt` the same way: the country outlines the
 * compressor draws, territorial waters included. Natural Earth's 10m
 * coastline runs inland of a whole coastal village (Ter Heijde, inside
 * Monster) and misses small islands and atolls, which were all dropped.
 * Only then, so Natural Earth's land still decides every polygon that has
 * any: a coastal region's sea samples, voting for whoever's waters they
 * are in, could otherwise outvote its land near a border. */
export function resolvePolygonCountry(
  feature: Feature<Polygon | MultiPolygon>,
  featureBbox: BBox,
  repPoint: LonLat,
  countries: CountryIndex,
  options: { alwaysSample?: boolean; outlineAt?: (point: LonLat) => string | null } = {},
): string | null {
  const country = resolveWith(feature, featureBbox, repPoint, countries.lookup, options.alwaysSample ?? false);
  if (country !== null || !options.outlineAt) return country;
  return resolveWith(feature, featureBbox, repPoint, options.outlineAt, true);
}

function resolveWith(
  feature: Feature<Polygon | MultiPolygon>,
  featureBbox: BBox,
  repPoint: LonLat,
  lookup: (point: LonLat) => string | null,
  alwaysSample: boolean,
): string | null {
  const [minX, minY, maxX, maxY] = featureBbox;
  if (!alwaysSample) {
    const guess = lookup(repPoint);
    if (guess) {
      const corners: LonLat[] = [
        [minX, minY],
        [minX, maxY],
        [maxX, minY],
        [maxX, maxY],
      ];
      if (corners.every((corner) => (lookup(corner) ?? guess) === guess)) return guess;
    }
  }
  const { majority, interior } = sampledMajority(feature, featureBbox, lookup);
  // A polygon thinner than the finest grid gives sampling no say at all;
  // only then is the single representative point still the best witness.
  if (interior === 0) return lookup(repPoint);
  return majority;
}

const SAMPLE_GRIDS = [8, 16, 32] as const;
/** Enough interior hits to trust a majority; below this the grid is
 * refined, since a thin or fragmented polygon can put most of a coarse
 * grid outside itself. */
const MIN_INTERIOR_SAMPLES = 12;

function sampledMajority(
  feature: Feature<Polygon | MultiPolygon>,
  featureBbox: BBox,
  lookup: (point: LonLat) => string | null,
): { majority: string | null; interior: number } {
  const [minX, minY, maxX, maxY] = featureBbox;
  const tally = new Map<string, number>();
  let interior = 0;
  for (const grid of SAMPLE_GRIDS) {
    tally.clear();
    interior = 0;
    for (let i = 0; i < grid; i++) {
      for (let j = 0; j < grid; j++) {
        const point: LonLat = [minX + ((i + 0.5) / grid) * (maxX - minX), minY + ((j + 0.5) / grid) * (maxY - minY)];
        if (!booleanPointInPolygon(point, feature)) continue;
        interior++;
        const code = lookup(point);
        if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
      }
    }
    if (interior >= MIN_INTERIOR_SAMPLES) break;
  }
  let majority: string | null = null;
  let bestCount = 0;
  for (const [code, count] of tally) {
    if (count > bestCount) {
      majority = code;
      bestCount = count;
    }
  }
  return { majority, interior };
}
