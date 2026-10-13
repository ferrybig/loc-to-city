import { orient2d } from "robust-predicates";
import type { MultiPolygon, Polygon, Position } from "geojson";

/** Turf's `booleanPointInPolygon` (boundary counts as inside), answered
 * from an index built once per polygon instead of walking every vertex on
 * every call. Use it where one polygon is tested against many points:
 * sampling a relation for its country takes 64 to 1,024 tests, and every
 * city is tested against the regions around it.
 *
 * The answers are turf's own, not just close to them. Turf's test
 * (`point-in-polygon-hao`) only ever looks at an edge whose y-range
 * includes the point's y, so edges are bucketed by horizontal band (as in
 * countryIndex.ts) and only the point's band is walked, with the same
 * arithmetic: the same `x - px` subtractions, the same `orient2d`, the
 * same crossing count summed over all of a polygon's rings, and a point on
 * an edge inside. A point outside a polygon's bbox gets no crossing from
 * it either way, so that is a plain reject. */
export interface PreparedPolygon {
  contains(x: number, y: number): boolean;
}

const BAND_MIN_EDGES = 64;
const EDGES_PER_BAND = 16;

interface PreparedPart {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Every ring's vertices, packed `x, y`, one ring after the other. */
  xy: Float64Array;
  /** The edges in band `b` are `edges[bandStart[b] .. bandStart[b + 1]]`,
   * each the index of its first vertex (the edge runs to the next one). */
  bandStart: Int32Array;
  edges: Int32Array;
  bandHeight: number;
}

export function preparePolygon(geometry: Polygon | MultiPolygon): PreparedPolygon {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const parts = polygons.map(preparePart);
  if (parts.length === 1) {
    const part = parts[0]!;
    return { contains: (x, y) => partContains(part, x, y) };
  }
  return {
    contains(x, y) {
      for (const part of parts) if (partContains(part, x, y)) return true;
      return false;
    },
  };
}

function preparePart(rings: Position[][]): PreparedPart {
  let vertexCount = 0;
  for (const ring of rings) {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    // point-in-polygon-hao's own check, word for word.
    if (first[0] !== last[0] && first[1] !== last[1]) {
      throw new Error("First and last coordinates in a ring must be the same");
    }
    vertexCount += ring.length;
  }
  const xy = new Float64Array(vertexCount * 2);
  // The first vertex of each edge. Rings are not closed implicitly: like
  // turf, the edges run from each vertex to the next, the last vertex
  // being (normally) a repeat of the first.
  const edgeStarts = new Int32Array(Math.max(0, vertexCount - rings.length));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let v = 0;
  let e = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++, v++) {
      const x = ring[i]![0]!;
      const y = ring[i]![1]!;
      xy[2 * v] = x;
      xy[2 * v + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (i < ring.length - 1) edgeStarts[e++] = v;
    }
  }

  const edgeCount = e;
  const bandCount = edgeCount >= BAND_MIN_EDGES && maxY > minY ? Math.ceil(edgeCount / EDGES_PER_BAND) : 1;
  const bandHeight = (maxY - minY) / bandCount;
  const band = (y: number): number => (bandCount === 1 ? 0 : Math.min(bandCount - 1, Math.floor((y - minY) / bandHeight)));
  // Two passes, counting then filling, into one flat array.
  const bandStart = new Int32Array(bandCount + 1);
  for (let k = 0; k < edgeCount; k++) {
    const i = edgeStarts[k]!;
    const y1 = xy[2 * i + 1]!;
    const y2 = xy[2 * i + 3]!;
    const hi = band(y1 > y2 ? y1 : y2);
    for (let b = band(y1 < y2 ? y1 : y2); b <= hi; b++) bandStart[b + 1]!++;
  }
  for (let b = 0; b < bandCount; b++) bandStart[b + 1]! += bandStart[b]!;
  const edges = new Int32Array(bandStart[bandCount]!);
  const fill = bandStart.slice(0, bandCount);
  for (let k = 0; k < edgeCount; k++) {
    const i = edgeStarts[k]!;
    const y1 = xy[2 * i + 1]!;
    const y2 = xy[2 * i + 3]!;
    const hi = band(y1 > y2 ? y1 : y2);
    for (let b = band(y1 < y2 ? y1 : y2); b <= hi; b++) edges[fill[b]!++] = i;
  }
  return { minX, minY, maxX, maxY, xy, bandStart, edges, bandHeight };
}

function partContains(part: PreparedPart, x: number, y: number): boolean {
  if (x < part.minX || x > part.maxX || y < part.minY || y > part.maxY) return false;
  const { xy, edges, bandStart } = part;
  const bandCount = bandStart.length - 1;
  const b = bandCount === 1 ? 0 : Math.min(bandCount - 1, Math.floor((y - part.minY) / part.bandHeight));
  let k = 0;
  for (let n = bandStart[b]!, end = bandStart[b + 1]!; n < end; n++) {
    const i = edges[n]!;
    const u1 = xy[2 * i]! - x;
    const v1 = xy[2 * i + 1]! - y;
    const u2 = xy[2 * i + 2]! - x;
    const v2 = xy[2 * i + 3]! - y;
    if (v1 === 0 && v2 === 0) {
      if ((u2 <= 0 && u1 >= 0) || (u1 <= 0 && u2 >= 0)) return true;
    } else if ((v2 >= 0 && v1 <= 0) || (v2 <= 0 && v1 >= 0)) {
      const f = orient2d(u1, u2, v1, v2, 0, 0);
      if (f === 0) return true;
      if ((f > 0 && v2 > 0 && v1 <= 0) || (f < 0 && v2 <= 0 && v1 > 0)) k++;
    }
  }
  return k % 2 === 1;
}
