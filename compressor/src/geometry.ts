import type { Feature, Polygon, MultiPolygon } from "geojson";
import { polygon as turfPolygon } from "@turf/helpers";
import booleanContains from "@turf/boolean-contains";
import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

export interface CellBounds {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

export function cellPolygon(bounds: CellBounds): Feature<Polygon> {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  return turfPolygon([
    [
      [lonMin, latMin],
      [lonMax, latMin],
      [lonMax, latMax],
      [lonMin, latMax],
      [lonMin, latMin],
    ],
  ]);
}

export function fullyContains(candidate: Feature<Polygon | MultiPolygon>, cell: Feature<Polygon>): boolean {
  return booleanContains(candidate, cell);
}

export function touches(candidate: Feature<Polygon | MultiPolygon>, cell: Feature<Polygon>): boolean {
  return booleanIntersects(candidate, cell);
}

const AREA_SHARE_SAMPLE_GRID = 5; // 5x5 = 25 sample points per ambiguous max-depth cell

/**
 * Approximates a candidate's share of a cell's area by counting how many of
 * a small grid of sample points inside the cell it contains. This stands in
 * for Section 10's "largest area share" tie-break at max_depth without
 * calling an exact polygon-clipping routine: Turf v7's `intersect()` uses
 * BigNumber arithmetic for robustness, which measured as the dominant cost
 * of a real build (profiled at ~45% of samples) precisely because this is
 * the one place it was called for every still-ambiguous leaf cell. A cell
 * this small only needs an approximate winner, not an exact area.
 */
export function countContainedSamples(candidate: Feature<Polygon | MultiPolygon>, bounds: CellBounds): number {
  let count = 0;
  for (let iy = 0; iy < AREA_SHARE_SAMPLE_GRID; iy++) {
    const lat = bounds.latMin + ((iy + 0.5) / AREA_SHARE_SAMPLE_GRID) * (bounds.latMax - bounds.latMin);
    for (let ix = 0; ix < AREA_SHARE_SAMPLE_GRID; ix++) {
      const lon = bounds.lonMin + ((ix + 0.5) / AREA_SHARE_SAMPLE_GRID) * (bounds.lonMax - bounds.lonMin);
      if (booleanPointInPolygon([lon, lat], candidate)) count++;
    }
  }
  return count;
}
