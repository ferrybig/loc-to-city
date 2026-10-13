import type { MultiPolygon, Polygon, Position } from "geojson";

type Box = readonly [minX: number, minY: number, maxX: number, maxY: number];

/** `container`, cut down to what can change polyclip-ts' intersection of
 * it with a polygon inside `box`, without changing that intersection.
 *
 * A Voronoi cell is tiny next to the container it is clipped to (Highland:
 * 355k vertices, ~7s a cell in polyclip-ts' arbitrary precision), and
 * polyclip-ts walks every vertex of both. What it answers, though, only
 * depends on the container near the cell:
 *
 * - every edge that comes near the cell (meets `box`, grown a little: `G`)
 *   is kept exactly, endpoints and all, so the same edges cross the cell
 *   at the same points, computed from the same endpoints;
 * - every point in the cell keeps its winding number, which is all
 *   polyclip-ts' nonzero rule asks of the rest of the ring.
 *
 * So a frame `F` is drawn around `G` and every kept edge, strictly outside
 * both. Inside `F` each ring is left as it is; each stretch of a ring
 * outside `F` is replaced by a path along `F`'s border that turns the same
 * total angle around `F`'s centre, so the stretch and its replacement
 * together wind zero times around every point inside `F`. An edge
 * crossing `F` is cut where it crosses; it comes nowhere near the cell, so
 * where it is cut doesn't matter. A part whose bbox misses `G` is dropped
 * whole, as is a ring winding zero times around `F` from outside it.
 *
 * The result is only meant to be intersected with a polygon inside `box`:
 * it is not the container's shape anywhere else. Rings that would need
 * several turns around `F` (never seen in practice) are kept as they are,
 * which is always correct, only slower. Null when nothing of the container
 * reaches `F`: the cell is outside it. */
export function cropForClip(container: Polygon | MultiPolygon, box: Box): MultiPolygon | null {
  const parts = container.type === "Polygon" ? [container.coordinates] : container.coordinates;
  const margin = (b: Box) => Math.max(b[2] - b[0], b[3] - b[1]) * 0.01 + 1e-9;
  const m = margin(box);
  const g: Box = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];

  // Parts that can reach G, and the frame F around G and their edges that meet it.
  const nearParts = parts.filter((rings) => boxesMeet(ringBox(rings[0]!), g));
  let fMinX = g[0];
  let fMinY = g[1];
  let fMaxX = g[2];
  let fMaxY = g[3];
  for (const rings of nearParts) {
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const [x1, y1] = ring[i] as [number, number];
        const [x2, y2] = ring[i + 1] as [number, number];
        if (!segmentMeetsBox(x1, y1, x2, y2, g)) continue;
        fMinX = Math.min(fMinX, x1, x2);
        fMinY = Math.min(fMinY, y1, y2);
        fMaxX = Math.max(fMaxX, x1, x2);
        fMaxY = Math.max(fMaxY, y1, y2);
      }
    }
  }
  const fm = margin([fMinX, fMinY, fMaxX, fMaxY]);
  const frame = new Frame([fMinX - fm, fMinY - fm, fMaxX + fm, fMaxY + fm]);

  const result: Position[][][] = [];
  for (const rings of nearParts) {
    const outer = cropRing(rings[0]!, frame);
    if (outer === null) continue; // winds nowhere inside F: the part covers none of it
    const holes: Position[][] = [];
    for (const hole of rings.slice(1)) {
      const cropped = cropRing(hole, frame);
      if (cropped !== null) holes.push(cropped);
    }
    result.push([outer, ...holes]);
  }
  return result.length === 0 ? null : { type: "MultiPolygon", coordinates: result };
}

/** A box, its border walked counterclockwise by arc length from its
 * bottom-left corner, and its centre to measure turning around. */
class Frame {
  readonly box: Box;
  readonly cx: number;
  readonly cy: number;
  readonly perimeter: number;
  private readonly w: number;
  private readonly h: number;

  constructor(box: Box) {
    this.box = box;
    this.cx = (box[0] + box[2]) / 2;
    this.cy = (box[1] + box[3]) / 2;
    this.w = box[2] - box[0];
    this.h = box[3] - box[1];
    this.perimeter = 2 * (this.w + this.h);
  }

  /** Strictly inside. */
  contains(x: number, y: number): boolean {
    const [minX, minY, maxX, maxY] = this.box;
    return x > minX && x < maxX && y > minY && y < maxY;
  }

  angle(x: number, y: number): number {
    return Math.atan2(y - this.cy, x - this.cx);
  }

  /** Arc length of a point on the border. */
  arc(x: number, y: number): number {
    const [minX, minY, maxX, maxY] = this.box;
    const { w, h } = this;
    // Whichever side it is nearest to (it is on one of them, up to rounding).
    const d = [y - minY, maxX - x, maxY - y, x - minX].map(Math.abs);
    const side = d.indexOf(Math.min(...d));
    if (side === 0) return clamp(x - minX, 0, w);
    if (side === 1) return w + clamp(y - minY, 0, h);
    if (side === 2) return w + h + clamp(maxX - x, 0, w);
    return 2 * w + h + clamp(maxY - y, 0, h);
  }

  /** The corners passed walking the border from arc `from` by `length`
   * (negative: clockwise), in order. */
  cornersBetween(from: number, length: number): Position[] {
    const [minX, minY, maxX, maxY] = this.box;
    const { w, h, perimeter } = this;
    const cornerArcs = [0, w, w + h, 2 * w + h];
    const corners: Position[] = [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ];
    const passed: { at: number; corner: Position }[] = [];
    for (let k = 0; k < 4; k++) {
      // Distance along the walk to this corner, for each lap it comes round.
      let d = length >= 0 ? mod(cornerArcs[k]! - from, perimeter) : mod(from - cornerArcs[k]!, perimeter);
      for (; d < Math.abs(length); d += perimeter) {
        if (d > 0) passed.push({ at: d, corner: corners[k]! });
      }
    }
    return passed.sort((a, b) => a.at - b.at).map((p) => p.corner);
  }
}

/** The part of a closed ring that matters inside `frame` (see
 * `cropForClip`), closed; null when the ring winds zero times around the
 * inside of the frame without entering it. */
function cropRing(ring: Position[], frame: Frame): Position[] | null {
  const n = ring.length - 1; // edges; ring[n] repeats ring[0]
  if (n < 3) return ring;
  // Start the walk at a vertex inside the frame, so every excursion
  // outside is bracketed by an exit and an entry.
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (frame.contains(ring[i]![0]!, ring[i]![1]!)) {
      start = i;
      break;
    }
  }
  if (start === -1) return ringOutside(ring, frame);

  const out: Position[] = [];
  const push = (p: Position): void => {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  };
  // While outside: where the ring left the frame, and how far it has
  // turned around the frame's centre since.
  let outside = false;
  let exit: Position = [0, 0];
  let turned = 0;
  let prevAngle = 0;
  const leave = (point: Position, then: Position): void => {
    outside = true;
    exit = point;
    prevAngle = frame.angle(point[0]!, point[1]!);
    turned = 0;
    turnTo(then);
  };
  const turnTo = (p: Position): void => {
    const angle = frame.angle(p[0]!, p[1]!);
    turned += angleDelta(prevAngle, angle);
    prevAngle = angle;
  };
  const at = (ax: number, ay: number, bx: number, by: number, t: number, a: Position, b: Position): Position =>
    t <= 0 ? a : t >= 1 ? b : [ax + t * (bx - ax), ay + t * (by - ay)];

  for (let k = 0; k < n; k++) {
    const a = ring[(start + k) % n]!;
    const b = ring[(start + k + 1) % n]!;
    const ax = a[0]!;
    const ay = a[1]!;
    const bx = b[0]!;
    const by = b[1]!;
    const bInside = frame.contains(bx, by);
    if (!outside) {
      // `a` is inside: kept as it is, and so is the edge when `b` is too.
      push(a);
      if (bInside) continue;
      const clip = liangBarsky(ax, ay, bx, by, frame.box)!;
      leave(at(ax, ay, bx, by, clip[1], a, b), b);
      continue;
    }
    const clip = liangBarsky(ax, ay, bx, by, frame.box);
    if (clip === null || clip[1] <= 0) {
      turnTo(b);
      continue;
    }
    // Back at the frame: the excursion becomes a path along its border.
    const entry = at(ax, ay, bx, by, clip[0], a, b);
    turnTo(entry);
    if (!borderPath(exit, entry, turned, frame, push)) return ring;
    push(entry);
    outside = false;
    if (bInside) continue;
    // Only grazed the frame, or crossed a corner of it: off again.
    const again = at(ax, ay, bx, by, clip[1], a, b);
    push(again);
    leave(again, b);
  }
  // The walk ends where it started, inside the frame.
  if (outside) return ring;
  push(out[0]!);
  return out.length >= 4 ? out : ring;
}

/** A ring with no vertex strictly inside the frame. If no edge meets the
 * frame either, it winds a whole number of times around all of it: zero
 * (dropped) or once (replaced by the frame itself, the same way round);
 * anything else is kept whole. */
function ringOutside(ring: Position[], frame: Frame): Position[] | null {
  const n = ring.length - 1;
  let turned = 0;
  let prev = frame.angle(ring[0]![0]!, ring[0]![1]!);
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;
    if (liangBarsky(a[0]!, a[1]!, b[0]!, b[1]!, frame.box) !== null) return ring;
    const angle = frame.angle(b[0]!, b[1]!);
    turned += angleDelta(prev, angle);
    prev = angle;
  }
  const winding = Math.round(turned / (2 * Math.PI));
  if (winding === 0) return null;
  if (Math.abs(winding) !== 1) return ring;
  const [minX, minY, maxX, maxY] = frame.box;
  const ccw: Position[] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
  return winding > 0 ? ccw : ccw.reverse();
}

/** Pushes the corners of the border path from `exit` to `entry` that
 * turns `turned` radians around the frame's centre. False when that takes
 * a full lap or more (left to the caller to keep the ring whole). */
function borderPath(exit: Position, entry: Position, turned: number, frame: Frame, push: (p: Position) => void): boolean {
  const from = frame.arc(exit[0]!, exit[1]!);
  const to = frame.arc(entry[0]!, entry[1]!);
  const ccwAngle = mod(frame.angle(entry[0]!, entry[1]!) - frame.angle(exit[0]!, exit[1]!), 2 * Math.PI);
  const laps = Math.round((turned - ccwAngle) / (2 * Math.PI));
  let length = mod(to - from, frame.perimeter) + laps * frame.perimeter;
  // Exit and entry at the same arc, with no turn: no path at all.
  if (Math.abs(length) >= frame.perimeter) return false;
  push(exit);
  for (const corner of frame.cornersBetween(from, length)) push(corner);
  return true;
}

/** The parameter range [t0, t1] of segment a-b inside the closed box, or
 * null when it misses it. */
function liangBarsky(ax: number, ay: number, bx: number, by: number, box: Box): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - box[0], box[2] - ax, ay - box[1], box[3] - ay];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return null;
      continue;
    }
    const r = qi / pi;
    if (pi < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

function segmentMeetsBox(x1: number, y1: number, x2: number, y2: number, box: Box): boolean {
  return liangBarsky(x1, y1, x2, y2, box) !== null;
}

function angleDelta(from: number, to: number): number {
  let d = to - from;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function ringBox(ring: Position[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x = 0, y = 0] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function boxesMeet(a: Box, b: Box): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
