import intersect from "@turf/intersect";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { difference, type Geom } from "polyclip-ts";
import { cropForClip } from "./cropForClip.ts";
import type { TaskHandler, WorkerPool } from "./workerPool.ts";

/** A MultiPolygon's `coordinates`. */
export type Outline = Position[][][];

/** The polygon clipping prepare-world.ts does, which is most of its run
 * outside Pass 1: polyclip-ts computes in arbitrary precision
 * (bignumber.js), so a single country outline minus another can take
 * seconds. Each call is independent, so a pool runs them side by side;
 * every call is the same polyclip-ts/turf call on the same input either
 * way, so where it runs never changes the result. */
export interface Clipper {
  /** `subject` minus `clipper`, as polyclip-ts' `difference` answers it. */
  difference(subject: Outline, clipper: Outline): Promise<Outline>;
  /** Each cell (a closed ring) intersected with `container`, as
   * `@turf/intersect` answers it: null where they don't meet. */
  intersectCells(cells: Position[][], container: Polygon | MultiPolygon): Promise<(Polygon | MultiPolygon | null)[]>;
}

/** Cropped-container vertices per pool task, summed over its cells, and
 * a cap on cells: enough work per task that the message isn't the cost,
 * small enough that a country's cells spread over every thread. */
const VERTICES_PER_TASK = 20_000;
const MAX_CELLS_PER_TASK = 16;

/** A cell and what of the container matters to it (`cropForClip`). */
interface CellJob {
  cell: Position[];
  container: MultiPolygon;
}

/** Vertices a clipping pool may have polyclip-ts working on at once (see
 * WorkerPool's `maxWeight`): ~5KB each, so about 5GB. */
export const CLIP_MAX_VERTICES = 1_000_000;

export function clipper(pool?: WorkerPool): Clipper {
  const inline = !pool || pool.size === 0;
  return {
    async difference(subject, clip) {
      // As with cells below: only what of the clipper comes near the
      // subject can change the answer (a country cut out of a region of its
      // neighbour's is mostly far from it). Still a polyclip-ts call when
      // nothing does, since it rewrites the subject's rings too.
      const cropped = cropForClip({ type: "MultiPolygon", coordinates: clip }, outlineBox(subject));
      const clipper = cropped ? cropped.coordinates : [];
      if (inline) return differenceOutline(subject, clipper);
      const subjectPacked = packOutline(subject);
      const clipperPacked = packOutline(clipper);
      const weight = (subjectPacked.xy.length + clipperPacked.xy.length) / 2;
      const packed = await pool.run<PackedOutline>(
        "difference",
        { subject: subjectPacked, clipper: clipperPacked },
        [],
        weight,
      );
      return unpackOutline(packed);
    },
    async intersectCells(cells, container) {
      // Every cell gets only the part of the container near it, which gives
      // polyclip-ts the same answer for a fraction of the work (Highland:
      // ~7s a cell against all of it). One that can't reach the container
      // at all is null without asking polyclip-ts, as it would answer.
      const results: (Polygon | MultiPolygon | null | Promise<(Polygon | MultiPolygon | null)[]>)[] = [];
      const jobs: CellJob[] = [];
      const slots: number[] = [];
      let vertices = 0;
      const flush = (): void => {
        if (jobs.length === 0) return;
        const batch = jobs.splice(0);
        const batchSlots = slots.splice(0);
        const done = pool!.run<(Polygon | MultiPolygon | null)[]>("intersectCells", { jobs: batch }, [], vertices);
        batchSlots.forEach((slot, i) => (results[slot] = done.then((r) => [r[i] ?? null])));
        vertices = 0;
      };
      for (const cell of cells) {
        const cropped = cropForClip(container, ringBox(cell));
        if (cropped === null) {
          results.push(null);
          continue;
        }
        if (inline) {
          results.push(intersectCell(cell, cropped));
          continue;
        }
        slots.push(results.length);
        results.push(null);
        jobs.push({ cell, container: cropped });
        vertices += cell.length;
        for (const rings of cropped.coordinates) for (const ring of rings) vertices += ring.length;
        if (vertices >= VERTICES_PER_TASK || jobs.length >= MAX_CELLS_PER_TASK) flush();
      }
      flush();
      return Promise.all(results.map(async (r) => (r instanceof Promise ? (await r)[0]! : r)));
    },
  };
}

/** The handlers a worker serving a `clipper` pool registers. */
export const clipHandlers: Record<string, TaskHandler> = {
  difference({ subject, clipper: clip }: { subject: PackedOutline; clipper: PackedOutline }) {
    const result = packOutline(differenceOutline(unpackOutline(subject), unpackOutline(clip)));
    return { result, transfer: [result.xy.buffer, result.ringLengths.buffer, result.partRings.buffer] as ArrayBuffer[] };
  },
  intersectCells({ jobs }: { jobs: CellJob[] }) {
    return { result: jobs.map(({ cell, container }) => intersectCell(cell, container)) };
  },
};

function differenceOutline(subject: Outline, clip: Outline): Outline {
  return difference(subject as Geom, clip as Geom) as Outline;
}

function intersectCell(cell: Position[], container: Polygon | MultiPolygon): Polygon | MultiPolygon | null {
  const cellFeature = turfPolygon([cell as [number, number][]]);
  const containerFeature: Feature<Polygon | MultiPolygon> = { type: "Feature", properties: {}, geometry: container };
  const clipped = intersect(featureCollection([cellFeature, containerFeature as Feature<Polygon>]));
  return clipped ? clipped.geometry : null;
}

/** An outline as three flat arrays, which cross a thread boundary far
 * cheaper than millions of little `[x, y]` arrays. */
interface PackedOutline {
  xy: Float64Array;
  ringLengths: Int32Array;
  partRings: Int32Array;
}

function packOutline(outline: Outline): PackedOutline {
  let vertices = 0;
  let rings = 0;
  for (const part of outline) {
    rings += part.length;
    for (const ring of part) vertices += ring.length;
  }
  const xy = new Float64Array(vertices * 2);
  const ringLengths = new Int32Array(rings);
  const partRings = new Int32Array(outline.length);
  let v = 0;
  let r = 0;
  outline.forEach((part, p) => {
    partRings[p] = part.length;
    for (const ring of part) {
      ringLengths[r++] = ring.length;
      for (const position of ring) {
        xy[v++] = position[0]!;
        xy[v++] = position[1]!;
      }
    }
  });
  return { xy, ringLengths, partRings };
}

function unpackOutline({ xy, ringLengths, partRings }: PackedOutline): Outline {
  const outline: Outline = [];
  let v = 0;
  let r = 0;
  for (const ringCount of partRings) {
    const part: Position[][] = [];
    for (let i = 0; i < ringCount; i++) {
      const length = ringLengths[r++]!;
      const ring: Position[] = new Array(length);
      for (let j = 0; j < length; j++, v += 2) ring[j] = [xy[v]!, xy[v + 1]!];
      part.push(ring);
    }
    outline.push(part);
  }
  return outline;
}

function outlineBox(outline: Outline): [number, number, number, number] {
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of outline) {
    const [minX, minY, maxX, maxY] = ringBox(part[0]!);
    box = [Math.min(box[0], minX), Math.min(box[1], minY), Math.max(box[2], maxX), Math.max(box[3], maxY)];
  }
  return box;
}

function ringBox(ring: Position[]): [number, number, number, number] {
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
