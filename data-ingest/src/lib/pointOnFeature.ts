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
 * still walked them all again for the bbox. */
export function bboxAndPointOnFeature(geometry: Polygon | MultiPolygon): { bbox: BBox; repPoint: LonLat } {
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
  if (booleanPointInPolygon(midpoint, geometry)) return { bbox, repPoint: midpoint };

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
  return { bbox, repPoint: nearest };
}
