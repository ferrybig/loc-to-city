import { Delaunay } from "d3-delaunay";
import bbox from "@turf/bbox";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import union from "@turf/union";
import { featureCollection } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { type Clipper, clipper } from "./clip.ts";
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

/** The Voronoi-from-cities500 city fallback (countries.md, Libya): for a country whose OSM
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
export async function buildCityFallback(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
  clip: Clipper = clipper(),
): Promise<VoronoiCityCandidate[]> {
  const cells = await computeClippedCells(countryPolygon, points, clip);
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
export async function buildContainerFallback(
  container: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
  clip: Clipper = clipper(),
): Promise<VoronoiCityCandidate[]> {
  const [minX, minY, maxX, maxY] = bbox(container);
  const inside = points.filter(
    ({ point: [x, y] }) =>
      x >= minX && x <= maxX && y >= minY && y <= maxY && booleanPointInPolygon([x, y], container),
  );
  return buildCityFallback(container, inside, clip);
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

/** The Voronoi-from-cities500 region fallback (countries.md, Slovenia): for a country
 * with no usable region tier at all (`region: []`; no country uses it now,
 * Slovenia did until its census regions were read, see
 * `VORONOI_REGION_FALLBACK`), groups its
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
export async function buildRegionFallback(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
  namesByAdmin1Code: Map<string, string>,
  clip: Clipper = clipper(),
): Promise<VoronoiRegionCandidate[]> {
  const cells = await computeClippedCells(countryPolygon, points, clip);
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
 * inside one region-fallback group or between two different ones).
 * `wanted` limits the clipping to some cells (`regionHoles.ts` needs only
 * the cells of points no region covers); the rest come back null. */
export async function computeClippedCells(
  countryPolygon: Feature<Polygon | MultiPolygon>,
  points: Cities500Row[],
  clip: Clipper,
  wanted: (index: number) => boolean = () => true,
): Promise<(Polygon | MultiPolygon | null)[]> {
  if (points.length === 0) return [];
  const clipBox = bbox(countryPolygon);
  const sites = points.map((p) => p.point);
  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi(clipBox as [number, number, number, number]);
  // A cell from `d3-delaunay` is already clipped to the bbox, but that box
  // is rectangular -- a country's real outline usually isn't, so a cell can
  // still extend past land into a neighboring country or the sea. Each cell
  // is intersected with the actual outline; null for a site whose cell
  // doesn't overlap the country at all (its bbox-clipped cell was entirely
  // outside the real outline -- possible for a site right at the country's
  // own bbox corner).
  // Every point is a site, so a wanted cell is bounded by all its
  // neighbours; only the wanted ones are clipped (null for the rest).
  const cells: (Position[] | null)[] = points.map((_, i) => (wanted(i) ? voronoi.cellPolygon(i) : null));
  const toClip: Position[][] = [];
  for (const cell of cells) if (cell && cell.length >= 4) toClip.push(cell);
  const clipped = await clip.intersectCells(toClip, countryPolygon.geometry);
  let next = 0;
  return cells.map((cell) => (cell && cell.length >= 4 ? (clipped[next++] ?? null) : null));
}
