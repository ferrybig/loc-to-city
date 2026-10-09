import { Delaunay } from "d3-delaunay";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import intersect from "@turf/intersect";
import union from "@turf/union";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type { LonLat } from "./geo.ts";
import type { Cities500Row } from "./cities500.ts";

/** One synthesized city candidate: a `cities500.txt` point's own name/id
 * plus its Voronoi cell, already clipped to the real country outline.
 * Deliberately shaped like the un-region-assigned half of
 * `adminBoundaryIndex.ts`'s `CityCandidateMeta` (no `region` field, and
 * `repPoint` is the original cities500 site rather than a recomputed
 * `pointOnFeature` -- guaranteed to fall inside its own cell by
 * construction, unlike a bbox-midpoint-style representative point) --
 * `prepare-world.ts` routes this through the exact same
 * `assignCityRegion`/`emitCity` path real OSM candidates go through,
 * rather than hardcoding a region here, so a fallback city still resolves
 * to its real containing region (already fixed for Libya/Egypt/Chad/
 * Eritrea by the region-drop fix -- see README's "Regions with no cities
 * were dropped from the build") instead of just the bare country code. */
export interface VoronoiCityCandidate {
  id: string;
  name: string;
  country: string;
  repPoint: LonLat;
  geometry: Polygon | MultiPolygon;
}

/** README's "Voronoi-from-cities500" fallback: for a country whose OSM
 * city boundaries are missing or near-empty (Libya, Egypt, Chad, Eritrea
 * -- `countryAdminLevels.ts`'s own comments record ~0-0.7% city
 * coverage), synthesize a city polygon per `cities500.txt` point instead,
 * via a Voronoi diagram clipped to the country's own outline. Every point
 * gets exactly one cell -- no population filtering (see
 * `VORONOI_CITY_FALLBACK`'s doc comment for why) -- so cell size follows
 * local point density the way it would for a real settlement layer: dense
 * near cities, large in empty country.
 *
 * Deliberately a real Voronoi tessellation, not e.g. a fixed-radius
 * buffer around each point: buffers would overlap in dense areas and
 * leave gaps in sparse ones, so a `query()` between two buffers would
 * fall through to the country/region instead of returning the nearest
 * city, exactly the "nearest-labeled-point is wrong" failure mode this
 * whole format exists to fix (see README's "Why nearest-point is
 * wrong") -- a Voronoi cell has no gaps or overlaps by construction, so
 * every point inside the country resolves to its nearest cities500 site,
 * consistently. */
export function buildCityFallback(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
): VoronoiCityCandidate[] {
  const cells = computeClippedCells(countryPolygon, points);
  const candidates: VoronoiCityCandidate[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const geometry = cells[i];
    if (!geometry) continue;
    candidates.push({
      id: `voronoi:${point.geonameId}`,
      name: point.name,
      country: point.countryCode,
      repPoint: point.point,
      geometry,
    });
  }
  return candidates;
}

/** The region-scoped half of the city fallback
 * (`VORONOI_CITY_FALLBACK_WITHIN_REGIONS`): the same Voronoi tessellation
 * as `buildCityFallback`, but over just the `points` that fall inside one
 * real OSM `container` polygon (a Scottish council area, a Northern Irish
 * district), clipped to that container instead of the country outline. The
 * region keeps its real internal borders -- a cell never crosses from one
 * district into the next. A container's cells tile it exactly, so they
 * replace it; with no point inside, this returns nothing and the caller
 * keeps the container as the city. */
export function buildContainerFallback(
  container: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
): VoronoiCityCandidate[] {
  const [minX, minY, maxX, maxY] = bbox(container);
  const inside = points.filter(
    ({ point: [x, y] }) =>
      x >= minX && x <= maxX && y >= minY && y <= maxY && booleanPointInPolygon([x, y], container),
  );
  return buildCityFallback(container, inside);
}

/** One synthesized region: the union of every cities500 point's Voronoi
 * cell that shares the same GeoNames admin1 code, named via
 * `admin1CodesASCII.txt` (through `namesByAdmin1Code`) -- see
 * `buildRegionFallback`. */
export interface VoronoiRegionCandidate {
  name: string;
  country: string;
  geometry: Polygon | MultiPolygon;
}

/** README's "Voronoi-from-cities500" fallback, region half: for a country
 * with no usable region tier at all (`region: []` -- Slovenia, whose real
 * regional tier, OSM's "Upravna Enota" at level 7, only covers 17.6% of
 * the country, see README's "Slovenia has zero cities" entry), groups its
 * own `cities500.txt` points by GeoNames admin1 code and unions each
 * group's individual Voronoi cells (computed together, over every point
 * in the country at once, so adjacent groups tile exactly -- computing a
 * separate Voronoi diagram per group would leave gaps or overlaps at
 * shared boundaries) into one region polygon per group.
 *
 * This reuses `cities500.txt` as the site source rather than
 * `admin1CodesASCII.txt`'s own rows because the latter has no coordinates
 * in this repo (the real GeoNames export pairs it with `allCountries.txt`,
 * not vendored here) -- but the grouping recovers the real admin1
 * structure anyway: Slovenia's 602 cities500 points fall into exactly 212
 * distinct admin1 codes, matching `admin1CodesASCII.txt`'s own 212
 * Slovenian municipalities exactly. A point with no admin1 code at all
 * (rare) is dropped from every region -- there's no group to add it to. */
export function buildRegionFallback(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
  namesByAdmin1Code: Map<string, string>,
): VoronoiRegionCandidate[] {
  const cells = computeClippedCells(countryPolygon, points);
  const cellsByGroup = new Map<string, Feature<Polygon | MultiPolygon>[]>();
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const geometry = cells[i];
    if (!geometry || !point.admin1Code) continue;
    const groupKey = `${point.countryCode}.${point.admin1Code}`;
    let group = cellsByGroup.get(groupKey);
    if (!group) {
      group = [];
      cellsByGroup.set(groupKey, group);
    }
    group.push({ type: "Feature", properties: {}, geometry });
  }

  const candidates: VoronoiRegionCandidate[] = [];
  for (const [groupKey, group] of cellsByGroup) {
    const name = namesByAdmin1Code.get(groupKey);
    if (!name) continue;
    const merged = group.length === 1 ? group[0]! : union(featureCollection(group as Feature<Polygon>[]));
    if (!merged) continue;
    const [countryCode] = groupKey.split(".");
    candidates.push({ name, country: countryCode!, geometry: merged.geometry });
  }
  return candidates;
}

/** The Voronoi diagram for every `points[i]`, one cell per index (`null`
 * where a site's bbox-clipped cell didn't overlap the country at all),
 * already clipped to the real country outline -- the step both
 * `buildCityFallback` and `buildRegionFallback` need, computed once over
 * every point in the country together so their results tile exactly (no
 * gaps or overlaps at a shared boundary, whether that boundary ends up
 * inside one region-fallback group or between two different ones). */
function computeClippedCells(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
): (Polygon | MultiPolygon | null)[] {
  if (points.length === 0) return [];
  const clipBox = bbox(countryPolygon);
  const sites = points.map((p) => p.point);
  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi(clipBox as [number, number, number, number]);
  return points.map((_, i) => clipCellToCountry(voronoi.cellPolygon(i), countryPolygon));
}

/** A cell from `d3-delaunay` is already clipped to the caller-supplied
 * bounding box, but that box is rectangular -- a country's real outline
 * usually isn't, so a cell can still extend past land into a neighboring
 * country or the sea. `@turf/intersect` clips it to the actual country
 * polygon; returns null for a site whose cell doesn't overlap the
 * country at all (its bbox-clipped cell was entirely outside the real
 * outline -- possible for a site right at the country's own bbox
 * corner). */
function clipCellToCountry(
  cell: Position[] | null,
  countryPolygon: Feature<Polygon | MultiPolygon>,
): Polygon | MultiPolygon | null {
  if (!cell || cell.length < 4) return null;
  const cellFeature = turfPolygon([cell as [number, number][]]);
  const clipped = intersect(featureCollection([cellFeature, countryPolygon as Feature<Polygon>]));
  if (!clipped) return null;
  return clipped.geometry;
}
