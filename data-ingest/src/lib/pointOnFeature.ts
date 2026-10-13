import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import distance from "@turf/distance";
import type { BBox, MultiPolygon, Polygon } from "geojson";
import type { LonLat } from "./geo.ts";

/** A polygon's bbox plus turf's `pointOnFeature` for it, in one walk over
 * the coordinates and with the same answer: the bbox midpoint when it
 * falls inside the polygon, otherwise the vertex nearest to it by
 * haversine distance (the first such vertex on a tie).
 *
 * turf gets there by walking the coordinates for `center`'s bbox, then --
 * whenever the midpoint is outside, which is common for coastal and
 * multi-part boundaries -- `explode`-ing every vertex into its own Point
 * feature just to scan them for the nearest. On a relation with millions
 * of vertices that's millions of short-lived objects, and the caller
 * still walked them all again for the bbox.
 *
 * `interiorPoint` is the midpoint too when that is inside, and otherwise
 * `interiorPoint()`'s answer: the nearest vertex is on the polygon's
 * boundary, which a town on a border shares with the neighbouring region
 * (see `interiorPoint`). */
export function bboxAndPointOnFeature(geometry: Polygon | MultiPolygon): {
  bbox: BBox;
  repPoint: LonLat;
  interiorPoint: LonLat;
} {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [x = 0, y = 0] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const bbox: BBox = [minX, minY, maxX, maxY];
  const midpoint: LonLat = [(minX + maxX) / 2, (minY + maxY) / 2];
  if (booleanPointInPolygon(midpoint, geometry)) return { bbox, repPoint: midpoint, interiorPoint: midpoint };

  let nearest: LonLat = midpoint;
  let nearestDistance = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const vertex of ring) {
        const d = distance(midpoint, vertex);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = [vertex[0] ?? 0, vertex[1] ?? 0];
        }
      }
    }
  }
  return { bbox, repPoint: nearest, interiorPoint: interiorPoint(geometry) ?? nearest };
}

/** A point strictly inside the polygon (GEOS's InteriorPoint idea): across
 * each part, a horizontal line through the middle of the part's bbox, and
 * the midpoint of the widest stretch of it that lies inside the part.
 * Undefined only for a degenerate polygon without any such stretch.
 *
 * `pointOnFeature`'s fallback, the vertex nearest the bbox midpoint, lies
 * on the boundary, and a town on a region border shares that boundary
 * with the neighbouring region: both regions contain the vertex, and the
 * town went to whichever `assignCityRegion` tried first (Trenton, New
 * Jersey to Pennsylvania; Lotte, North Rhine-Westphalia to Lower Saxony).
 * A point strictly inside the town is inside one region only. */
export function interiorPoint(geometry: Polygon | MultiPolygon): LonLat | undefined {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best: LonLat | undefined;
  let bestWidth = 0;
  for (const rings of polygons) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y = 0] of rings[0] ?? []) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y = (minY + maxY) / 2;
    // Every ring crosses the line an even number of times (half-open
    // rule), so sorted crossings pair up into inside stretches.
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [ax = 0, ay = 0] = ring[i - 1]!;
        const [bx = 0, by = 0] = ring[i]!;
        if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1]! - xs[i]!;
      if (width > bestWidth) {
        bestWidth = width;
        best = [(xs[i]! + xs[i + 1]!) / 2, y];
      }
    }
  }
  return best;
}
