import type { MultiPolygon, Polygon } from "geojson";

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

/** A candidate's geometry flattened for the classifier: every ring of
 * every part -- outer rings and holes alike, since nothing below tells them
 * apart (see `containsPoint`) -- as interleaved x,y pairs in one
 * `Float64Array`. Ring r is points [ringStarts[r], ringStarts[r + 1]), still
 * GeoJSON-closed (first point === last). Nested GeoJSON arrays cost ~70
 * bytes of heap per vertex and are cloned object by object on every
 * `postMessage` to a chunk worker; this costs 16 bytes and clones as one
 * copy. */
export interface PackedGeometry {
  coords: Float64Array;
  ringStarts: Uint32Array;
}

export function packGeometry(geometry: Polygon | MultiPolygon): PackedGeometry {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let ringCount = 0;
  let pointCount = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ringCount++;
      pointCount += ring.length;
    }
  }
  // Exactly sized, never a view into something larger: structured clone
  // copies a typed array's whole underlying buffer.
  const coords = new Float64Array(pointCount * 2);
  const ringStarts = new Uint32Array(ringCount + 1);
  let r = 0;
  let p = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ringStarts[r++] = p;
      for (const position of ring) {
        coords[2 * p] = position[0]!;
        coords[2 * p + 1] = position[1]!;
        p++;
      }
    }
  }
  ringStarts[r] = p;
  return { coords, ringStarts };
}

interface IndexedRing {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** This ring's points within the geometry's `coords`, [start, end). Edge
   * i is (point i-1, point i) for i in [start + 1, end). */
  start: number;
  end: number;
  /** Edge indices bucketed by horizontal band, or null for rings too small
   * for it to be worth it. Every edge is listed in each band its y-range
   * overlaps, so a query only walks the edges near its own y (or y-range)
   * instead of all of them -- the ray casts (`ringToggle`,
   * `countContainedSamples`) and the boundary walk (`boundaryContact`, the
   * dominant cost of a build) all use it. A country the size of Russia has
   * tens of thousands of edges in one ring. */
  bands: number[][] | null;
  bandHeight: number;
}

const BAND_MIN_VERTICES = 256;
const VERTICES_PER_BAND = 32;

/** The band holding `y`, clamped to the ring's band range. The same
 * monotonic formula files every edge (see `ringsOf`), which is what makes
 * "every edge whose y-range reaches [yLo, yHi] is in bands
 * bandOf(yLo)..bandOf(yHi)" hold exactly, rounding included. */
function bandOf(ring: IndexedRing, y: number): number {
  const band = Math.floor((y - ring.minY) / ring.bandHeight);
  return band < 0 ? 0 : Math.min(ring.bands!.length - 1, band);
}

/** Per-ring bounding boxes (and, for large rings, a banded edge index),
 * computed once per geometry and reused for every cell that geometry is
 * tested against. Without this, classifying a deep cell against a big
 * multi-ring candidate walks every island of, say, Russia's coastline to
 * answer a question about one small rectangle. The cache is keyed on the
 * geometry object, so it lives exactly as long as the candidate does -- in
 * a worker that means one chunk's worth of cells, which is precisely the
 * span over which the same candidates repeat. */
const ringCache = new WeakMap<PackedGeometry, IndexedRing[]>();

function ringsOf(geometry: PackedGeometry): IndexedRing[] {
  const cached = ringCache.get(geometry);
  if (cached) return cached;

  const { coords, ringStarts } = geometry;
  const rings: IndexedRing[] = [];
  for (let r = 0; r + 1 < ringStarts.length; r++) {
    const start = ringStarts[r]!;
    const end = ringStarts[r + 1]!;
    // A closed linear ring needs at least 3 distinct vertices plus the
    // repeated closing point. Turf used to reject anything short of that
    // for us, as a side effect of calling into it for every cell; now that
    // classifyCell never does, this is the one place left that would ever
    // notice malformed input, so it has to check explicitly rather than let
    // a 2-point "ring" silently produce a wrong answer.
    if (end - start < 4) {
      throw new Error(`malformed ring: expected >= 4 points (a closed ring), got ${end - start}`);
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = start; i < end; i++) {
      const x = coords[2 * i]!;
      const y = coords[2 * i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const ring: IndexedRing = { minX, minY, maxX, maxY, start, end, bands: null, bandHeight: maxY - minY };
    if (end - start >= BAND_MIN_VERTICES && ring.bandHeight > 0) {
      const bandCount = Math.ceil((end - start) / VERTICES_PER_BAND);
      ring.bandHeight /= bandCount;
      const bands: number[][] = Array.from({ length: bandCount }, () => []);
      ring.bands = bands;
      // Both ends go through bandOf's clamp: an edge whose lower end rounds
      // to band `bandCount` (a horizontal edge along the ring's top, say)
      // must still land in the last band, or a boundary walk over that band
      // would never see it.
      for (let i = start + 1; i < end; i++) {
        const yi = coords[2 * i + 1]!;
        const yj = coords[2 * i - 1]!;
        const hi = bandOf(ring, Math.max(yi, yj));
        for (let b = bandOf(ring, Math.min(yi, yj)); b <= hi; b++) bands[b]!.push(i);
      }
    }

    rings.push(ring);
  }

  ringCache.set(geometry, rings);
  return rings;
}

/** Even-odd ray cast for one ring, ignoring hole/outer status -- see
 * `containsPoint` for why testing every ring this way and XORing the
 * results is the correct full answer for a candidate with holes or
 * multiple parts, not just an approximation. Bbox-rejects first (a
 * point outside a ring's bbox can never be inside it), then either walks
 * every edge or, for a ring large enough to have been banded, only the
 * edges in the query's own band. */
function ringToggle(coords: Float64Array, ring: IndexedRing, x: number, y: number): boolean {
  if (x < ring.minX || x > ring.maxX || y < ring.minY || y > ring.maxY) return false;
  let inside = false;
  if (ring.bands) {
    const band = ring.bands[bandOf(ring, y)]!;
    for (let k = 0; k < band.length; k++) {
      if (rayCrossesEdge(coords, band[k]!, x, y)) inside = !inside;
    }
  } else {
    for (let i = ring.start + 1; i < ring.end; i++) {
      if (rayCrossesEdge(coords, i, x, y)) inside = !inside;
    }
  }
  return inside;
}

/** Whether a ray from (x, y) towards +x crosses edge i. */
function rayCrossesEdge(coords: Float64Array, i: number, x: number, y: number): boolean {
  const yi = coords[2 * i + 1]!;
  const yj = coords[2 * i - 1]!;
  if (yi > y === yj > y) return false;
  const xi = coords[2 * i]!;
  const xj = coords[2 * i - 2]!;
  return x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
}

/**
 * Plain even-odd point-in-polygon, replacing `@turf/boolean-point-in-
 * polygon`. Turf v7 delegates to `point-in-polygon-hao`, which uses
 * exact/robust arithmetic to be correct on degenerate input -- profiled as
 * ~80% of a real worldwide build's chunk-compression time, almost all of it
 * in `countContainedSamples` below (up to 25 calls per candidate per
 * still-ambiguous max-depth cell). Plain floating point is enough here for
 * the same reason it already was in `segmentContact`: these aren't
 * adversarial inputs, just ordinary OSM/Natural Earth coordinates, and a
 * wrong answer on a literal knife-edge case costs at most one grid cell's
 * precision, not correctness.
 *
 * XORing every ring's own even-odd result (outer rings and holes alike,
 * across every part of a MultiPolygon) gives the same answer as tracking
 * hole/outer status explicitly: a point inside an outer ring and inside
 * one of its holes toggles twice (even, i.e. outside the polygon with the
 * hole punched out); a point inside exactly one part of a valid (non-
 * overlapping) MultiPolygon toggles once from that part's outer ring and
 * zero times from every other ring. Verified against turf on real
 * candidate geometry, not just this reasoning -- see geometry.test.ts.
 */
export function containsPoint(geometry: PackedGeometry, x: number, y: number): boolean {
  let inside = false;
  for (const ring of ringsOf(geometry)) {
    if (ringToggle(geometry.coords, ring, x, y)) inside = !inside;
  }
  return inside;
}

/** Strongest contact any ring of the candidate -- outer or hole, every
 * part of a MultiPolygon -- makes with the cell rectangle. Returning
 * `CONTACT_INTERIOR` also covers a polygon lying entirely *inside* the
 * cell, whose segments are interior by definition; that case would
 * otherwise be missed by the corner test and wrongly reported disjoint. */
function boundaryContact(geometry: PackedGeometry, bounds: CellBounds): number {
  const { lonMin, lonMax, latMin, latMax } = bounds;
  const { coords } = geometry;
  let strongest = CONTACT_NONE;

  for (const ring of ringsOf(geometry)) {
    // Whole islands drop out here without a single segment being examined.
    if (ring.minX > lonMax || ring.maxX < lonMin || ring.minY > latMax || ring.maxY < latMin) continue;

    // segmentContact rejects any edge whose y-range misses [latMin,
    // latMax], so only the bands covering that range can contribute. An
    // edge spanning several of them is just checked more than once, which
    // can't change a max. A cell spanning the whole ring gains nothing
    // from the bands, so that case walks the ring directly.
    const { bands } = ring;
    if (bands) {
      const lo = bandOf(ring, latMin);
      const hi = bandOf(ring, latMax);
      if (hi - lo + 1 < bands.length) {
        for (let b = lo; b <= hi; b++) {
          const band = bands[b]!;
          for (let k = 0; k < band.length; k++) {
            const contact = edgeContact(coords, band[k]!, lonMin, lonMax, latMin, latMax);
            if (contact === CONTACT_INTERIOR) return CONTACT_INTERIOR;
            if (contact > strongest) strongest = contact;
          }
        }
        continue;
      }
    }
    for (let i = ring.start + 1; i < ring.end; i++) {
      const contact = edgeContact(coords, i, lonMin, lonMax, latMin, latMax);
      // Interior contact is the strongest answer available, so stop as
      // soon as one turns up.
      if (contact === CONTACT_INTERIOR) return CONTACT_INTERIOR;
      if (contact > strongest) strongest = contact;
    }
  }
  return strongest;
}

function edgeContact(
  coords: Float64Array,
  i: number,
  lonMin: number,
  lonMax: number,
  latMin: number,
  latMax: number,
): number {
  return segmentContact(
    coords[2 * i - 2]!,
    coords[2 * i - 1]!,
    coords[2 * i]!,
    coords[2 * i + 1]!,
    lonMin,
    lonMax,
    latMin,
    latMax,
  );
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
  geometry: PackedGeometry,
  bounds: CellBounds,
  cMinX: number,
  cMinY: number,
  cMaxX: number,
  cMaxY: number,
): CellRelation {
  if (cMinX > bounds.lonMax || cMaxX < bounds.lonMin || cMinY > bounds.latMax || cMaxY < bounds.latMin) {
    return "disjoint";
  }

  const contact = boundaryContact(geometry, bounds);
  if (contact === CONTACT_INTERIOR) return "crosses";

  // Nothing cuts the cell's interior, so the whole cell shares one fate
  // with its corner. (A point inside one of the candidate's holes
  // correctly reads as outside -- hole rings are scanned like any other.)
  // Boundary points count as inside, which is what makes a candidate whose
  // edge runs exactly along this cell still contain it.
  if (containsPoint(geometry, bounds.lonMin, bounds.latMin)) return "contains";

  // Corner is outside and nothing cuts the interior, but the boundary
  // still grazes the cell: the two meet along an edge or at a point. That
  // is an intersection with zero area -- enough to touch, never enough to
  // contain.
  return contact === CONTACT_GRAZE ? "crosses" : "disjoint";
}

// 5x5 = 25 sample points per ambiguous max-depth cell. At most 31: a row's
// samples are tracked as the bits of one int (see countContainedSamples).
const AREA_SHARE_SAMPLE_GRID = 5;
// The current cell's sample longitudes, shared by every row.
const sampleLons = new Float64Array(AREA_SHARE_SAMPLE_GRID);

/**
 * Approximates a candidate's share of a cell's area by counting how many of
 * a small grid of sample points inside the cell it contains. This stands in
 * for Section 10's "largest area share" tie-break at max_depth without
 * calling an exact polygon-clipping routine -- originally to avoid Turf
 * v7's `intersect()` (BigNumber arithmetic, profiled at ~45% of a real
 * build), and later `containsPoint` above replaced `booleanPointInPolygon`
 * itself for the same reason. A cell this small only needs an approximate
 * winner, not an exact area.
 *
 * Gives exactly `containsPoint`'s answer for every sample, but casts each
 * row's rays together: a row's samples share one y, so each edge's
 * crossing x is computed once (the same expression `rayCrossesEdge` uses)
 * and compared against all of them, with the samples' parities kept as
 * bits of one int, rather than walking the same band once per sample.
 */
export function countContainedSamples(geometry: PackedGeometry, bounds: CellBounds): number {
  const { coords } = geometry;
  const rings = ringsOf(geometry);
  for (let ix = 0; ix < AREA_SHARE_SAMPLE_GRID; ix++) {
    sampleLons[ix] = bounds.lonMin + ((ix + 0.5) / AREA_SHARE_SAMPLE_GRID) * (bounds.lonMax - bounds.lonMin);
  }

  let count = 0;
  for (let iy = 0; iy < AREA_SHARE_SAMPLE_GRID; iy++) {
    const lat = bounds.latMin + ((iy + 0.5) / AREA_SHARE_SAMPLE_GRID) * (bounds.latMax - bounds.latMin);
    let inside = 0;
    for (const ring of rings) {
      if (lat < ring.minY || lat > ring.maxY) continue;
      // ringToggle's bbox reject, per sample: a ring never toggles a
      // sample outside its own x-range.
      let eligible = 0;
      for (let ix = 0; ix < AREA_SHARE_SAMPLE_GRID; ix++) {
        const lon = sampleLons[ix]!;
        if (lon >= ring.minX && lon <= ring.maxX) eligible |= 1 << ix;
      }
      if (eligible === 0) continue;

      let toggles = 0;
      if (ring.bands) {
        const band = ring.bands[bandOf(ring, lat)]!;
        for (let k = 0; k < band.length; k++) toggles ^= rowCrossings(coords, band[k]!, lat);
      } else {
        for (let i = ring.start + 1; i < ring.end; i++) toggles ^= rowCrossings(coords, i, lat);
      }
      inside ^= toggles & eligible;
    }
    for (; inside !== 0; inside &= inside - 1) count++;
  }
  return count;
}

/** Bit ix set when a ray from sample ix of the current row (`sampleLons`,
 * at y) towards +x crosses edge i -- `rayCrossesEdge` for the whole row. */
function rowCrossings(coords: Float64Array, i: number, y: number): number {
  const yi = coords[2 * i + 1]!;
  const yj = coords[2 * i - 1]!;
  if (yi > y === yj > y) return 0;
  const xi = coords[2 * i]!;
  const xj = coords[2 * i - 2]!;
  const crossingX = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
  let bits = 0;
  for (let ix = 0; ix < AREA_SHARE_SAMPLE_GRID; ix++) {
    if (sampleLons[ix]! < crossingX) bits |= 1 << ix;
  }
  return bits;
}
