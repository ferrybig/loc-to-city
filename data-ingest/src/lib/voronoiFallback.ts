import { Delaunay } from "d3-delaunay";
import bbox from "@turf/bbox";
import intersect from "@turf/intersect";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import type { LonLat } from "./geo.js";
import type { Cities500Row } from "./cities500.js";

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
  if (points.length === 0) return [];
  const clipBox = bbox(countryPolygon);
  const sites = points.map((p) => p.point);
  const delaunay = Delaunay.from(sites);
  const voronoi = delaunay.voronoi(clipBox as [number, number, number, number]);

  const candidates: VoronoiCityCandidate[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const geometry = clipCellToCountry(voronoi.cellPolygon(i), countryPolygon);
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
