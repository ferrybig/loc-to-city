import type { Feature, Polygon, MultiPolygon } from "geojson";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";

export interface CellBounds {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

/** How a candidate polygon relates to one axis-aligned cell. This replaces
 * a pair of separate, independently expensive turf calls -- `disjoint` was
 * `!booleanIntersects`, `contains` was `booleanContains`, `crosses` was
 * "intersects but doesn't contain". */
export type CellRelation = "disjoint" | "crosses" | "contains";

const CONTACT_NONE = 0;
/** Meets the rectangle only along its edge -- collinear with it, or
 * touching at a single point. The cell is still wholly inside or wholly
 * outside the polygon, so this does *not* rule out full containment. */
const CONTACT_GRAZE = 1;
/** Passes through the rectangle's interior, so the cell is genuinely cut
 * by this boundary and cannot be fully contained. */
const CONTACT_INTERIOR = 2;

/** How segment (x1,y1)-(x2,y2) meets the rectangle: not at all, only along
 * its edge, or through its interior. Liang-Barsky clipping in plain
 * floating point -- no exact arithmetic. */
function segmentContact(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lonMin: number,
  lonMax: number,
  latMin: number,
  latMax: number,
): number {
  // Cheap reject first: most segments of a big polygon are nowhere near
  // any one cell, and this skips the clipping math entirely for them.
  if ((x1 < lonMin && x2 < lonMin) || (x1 > lonMax && x2 > lonMax)) return CONTACT_NONE;
  if ((y1 < latMin && y2 < latMin) || (y1 > latMax && y2 > latMax)) return CONTACT_NONE;

  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;

  // Unrolled over the four half-planes (left, right, bottom, top). Each
  // step narrows [t0,t1], the surviving portion of the segment; an empty
  // interval means it misses the rectangle.
  for (let edge = 0; edge < 4; edge++) {
    let p: number;
    let q: number;
    if (edge === 0) {
      p = -dx;
      q = x1 - lonMin;
    } else if (edge === 1) {
      p = dx;
      q = lonMax - x1;
    } else if (edge === 2) {
      p = -dy;
      q = y1 - latMin;
    } else {
      p = dy;
      q = latMax - y1;
    }

    if (p === 0) {
      // Parallel to this edge: only rejected if it starts outside it.
      if (q < 0) return CONTACT_NONE;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return CONTACT_NONE;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return CONTACT_NONE;
      if (r < t1) t1 = r;
    }
  }

  // The segment meets the rectangle over [t0,t1]. Whether that clipped
  // piece runs through the interior or only along an edge is what decides
  // containment, so test its midpoint: a piece lying on an edge (or
  // touching at a single point, t0 === t1) keeps its midpoint on the
  // boundary, while any piece crossing the interior has an interior
  // midpoint.
  const tm = (t0 + t1) / 2;
  const mx = x1 + tm * dx;
  const my = y1 + tm * dy;
  const interior = mx > lonMin && mx < lonMax && my > latMin && my < latMax;
  return interior ? CONTACT_INTERIOR : CONTACT_GRAZE;
}

interface IndexedRing {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  points: [number, number][];
}

/** Per-ring bounding boxes, computed once per geometry and reused for
 * every cell that geometry is tested against. Without this, classifying a
 * deep cell against a big multi-ring candidate walks every island of, say,
 * Russia's coastline to answer a question about one small rectangle. The
 * cache is keyed on the geometry object, so it lives exactly as long as
 * the candidate does -- in a worker that means one chunk's worth of cells,
 * which is precisely the span over which the same candidates repeat. */
const ringCache = new WeakMap<Polygon | MultiPolygon, IndexedRing[]>();

function ringsOf(geometry: Polygon | MultiPolygon): IndexedRing[] {
  const cached = ringCache.get(geometry);
  if (cached) return cached;

  const rings: IndexedRing[] = [];
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const points = ring as [number, number][];
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      rings.push({ minX, minY, maxX, maxY, points });
    }
  }

  ringCache.set(geometry, rings);
  return rings;
}

/** Strongest contact any ring of the candidate -- outer or hole, every
 * part of a MultiPolygon -- makes with the cell rectangle. Returning
 * `CONTACT_INTERIOR` also covers a polygon lying entirely *inside* the
 * cell, whose segments are interior by definition; that case would
 * otherwise be missed by the corner test and wrongly reported disjoint. */
function boundaryContact(geometry: Polygon | MultiPolygon, bounds: CellBounds): number {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  let strongest = CONTACT_NONE;

  for (const ring of ringsOf(geometry)) {
    // Whole islands drop out here without a single segment being examined.
    if (ring.minX > lonMax || ring.maxX < lonMin || ring.minY > latMax || ring.maxY < latMin) continue;

    const points = ring.points;
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1] as [number, number];
      const [x2, y2] = points[i] as [number, number];
      const contact = segmentContact(x1, y1, x2, y2, lonMin, lonMax, latMin, latMax);
      // Interior contact is the strongest answer available, so stop as
      // soon as one turns up.
      if (contact === CONTACT_INTERIOR) return CONTACT_INTERIOR;
      if (contact > strongest) strongest = contact;
    }
  }
  return strongest;
}

/**
 * Classifies a candidate against a cell without any exact-arithmetic
 * polygon algebra, replacing a `touches` + `fullyContains` pair.
 *
 * The idea (credit: the project owner): if no part of the candidate's
 * boundary meets the cell, then the cell cannot be partly in and partly
 * out -- it is wholly inside the candidate or wholly outside it, and a
 * single point test settles which. Only when the boundary does cut through
 * the cell is there anything to subdivide for, and that answer arrives
 * from cheap segment/rectangle clipping rather than from Turf's
 * BigNumber-backed sweep.
 *
 * `cMinX`..`cMaxY` are the candidate's precomputed bbox, already on hand
 * from the spatial index.
 */
export function classifyCell(
  candidate: Feature<Polygon | MultiPolygon>,
  bounds: CellBounds,
  cMinX: number,
  cMinY: number,
  cMaxX: number,
  cMaxY: number,
): CellRelation {
  if (cMinX > bounds.lonMax || cMaxX < bounds.lonMin || cMinY > bounds.latMax || cMaxY < bounds.latMin) {
    return "disjoint";
  }

  const contact = boundaryContact(candidate.geometry, bounds);
  if (contact === CONTACT_INTERIOR) return "crosses";

  // Nothing cuts the cell's interior, so the whole cell shares one fate
  // with its corner. (A point inside one of the candidate's holes
  // correctly reads as outside -- hole rings are scanned like any other.)
  // Boundary points count as inside, which is what makes a candidate whose
  // edge runs exactly along this cell still contain it.
  if (booleanPointInPolygon([bounds.lonMin, bounds.latMin], candidate)) return "contains";

  // Corner is outside and nothing cuts the interior, but the boundary
  // still grazes the cell: the two meet along an edge or at a point. That
  // is an intersection with zero area -- enough to touch, never enough to
  // contain.
  return contact === CONTACT_GRAZE ? "crosses" : "disjoint";
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
