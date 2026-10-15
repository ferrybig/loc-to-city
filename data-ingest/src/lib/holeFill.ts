import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import type { Cities500Row } from "./cities500.ts";
import type { Clipper, Outline } from "./clip.ts";
import { preparePolygon, type PreparedPolygon } from "./preparedPolygon.ts";
import { buildContainerFallback, type VoronoiCityCandidate } from "./voronoiFallback.ts";

/** A real city polygon the hole fill must leave alone. */
export interface RealCity {
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}

/** The Voronoi hole fill (`VORONOI_CITY_FALLBACK_HOLES`): for a country whose
 * OSM city tier has polygons for only some of its towns, names the land no
 * real city covers after the nearest populated place of `points`
 * (cities500), without touching a real one.
 *
 * Sites are the points no real city polygon contains, except a section of a
 * populated place (GeoNames' `PPLX`: Doha's and Dubai's neighbourhoods), which
 * would split its town into neighbourhood names. They are grouped by the
 * region `regionAt` gives them, and each region's sites tessellate that
 * region's own polygon (`buildContainerFallback`), so a cell never crosses a
 * region border: a city belongs to one region, and a cell over another
 * region's land would answer with the wrong one. Each cell then has the real
 * cities near it cut out, so a real polygon is never covered by a synthesized
 * one. A region with no site stays as it is (a region answer, no city).
 *
 * `regions` must not overlap: where one lies inside another (PH's level 3
 * over its provinces) a cell of the outer one would cover the inner, so the
 * caller passes the outer one cut down to the land the inner ones leave. */
export async function buildHoleFill(
  regions: ReadonlyMap<string, Feature<Polygon | MultiPolygon>>,
  realCities: readonly RealCity[],
  points: readonly Cities500Row[],
  regionAt: (point: Cities500Row["point"]) => string | null,
  clip: Clipper,
): Promise<VoronoiCityCandidate[]> {
  const prepared: (PreparedPolygon | undefined)[] = new Array(realCities.length);
  const covered = (x: number, y: number): boolean =>
    realCities.some((city, i) => {
      const [minX, minY, maxX, maxY] = city.bbox;
      if (x < minX || x > maxX || y < minY || y > maxY) return false;
      return (prepared[i] ??= preparePolygon(city.geometry)).contains(x, y);
    });

  const sitesByRegion = new Map<string, Cities500Row[]>();
  for (const row of points) {
    if (row.featureCode === "PPLX" || covered(row.point[0], row.point[1])) continue;
    const region = regionAt(row.point);
    if (!region || !regions.has(region)) continue;
    let sites = sitesByRegion.get(region);
    if (!sites) sitesByRegion.set(region, (sites = []));
    sites.push(row);
  }

  const perRegion = await Promise.all(
    [...sitesByRegion].map(async ([region, sites]) => {
      const cells = await buildContainerFallback(regions.get(region)!, sites, clip);
      const out: VoronoiCityCandidate[] = [];
      for (const cell of cells) {
        const geometry = await subtractReal(cell.geometry, realCities, clip);
        if (geometry) out.push({ ...cell, geometry });
      }
      return out;
    }),
  );
  return perRegion.flat();
}

/** `geometry` without the real cities that overlap its bbox; null when nothing is left. */
async function subtractReal(
  geometry: Polygon | MultiPolygon,
  realCities: readonly RealCity[],
  clip: Clipper,
): Promise<Polygon | MultiPolygon | null> {
  const outline: Outline = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of outline) {
    for (const [x = 0, y = 0] of part[0]!) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const near: Outline = [];
  for (const city of realCities) {
    const [bMinX, bMinY, bMaxX, bMaxY] = city.bbox;
    if (bMaxX < minX || bMinX > maxX || bMaxY < minY || bMinY > maxY) continue;
    if (city.geometry.type === "Polygon") near.push(city.geometry.coordinates);
    else near.push(...city.geometry.coordinates);
  }
  if (near.length === 0) return geometry;
  const rest = await clip.difference(outline, near);
  if (rest.length === 0) return null;
  return rest.length === 1 ? { type: "Polygon", coordinates: rest[0]! } : { type: "MultiPolygon", coordinates: rest };
}
