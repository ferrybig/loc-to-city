import { mortonEncode } from "@loc-to-city/reader";
import type { CandidateIndex, IndexedCandidate } from "./candidateIndex.js";
import { cellPolygon, fullyContains, touches, countContainedSamples, type CellBounds } from "./geometry.js";

export interface ChunkRecord {
  code: number;
  depth: number;
  globalId: number;
}

/** Drops any candidate that is an ancestor of another candidate in the same
 * list (e.g. a region whose own city is also present) -- the more specific
 * place should always win when it's actually a candidate for this cell; the
 * ancestor only matters once no descendant applies here at all. Never
 * empties the list: a candidate that is nobody else's ancestor (every leaf
 * city, and any region/country with no touching descendant) always
 * survives. */
function pruneAncestors(candidates: IndexedCandidate[]): IndexedCandidate[] {
  if (candidates.length <= 1) return candidates;
  const ancestorIds = new Set<number>();
  for (const candidate of candidates) {
    for (const ancestorId of candidate.ancestorIds) ancestorIds.add(ancestorId);
  }
  if (ancestorIds.size === 0) return candidates;
  return candidates.filter((c) => !ancestorIds.has(c.globalId));
}

/** Adaptive quadtree subdivision for one chunk (Section 10's "Building
 * records" guidance): stop and emit nothing when no place touches a cell;
 * otherwise prune ancestors of any more specific candidate also touching
 * this cell (a region is irrelevant here if one of its own cities is also a
 * candidate), then stop and emit a record when *every remaining* candidate
 * fully contains the cell (preferring the smallest on ties -- safe exactly
 * because none of their boundaries pass through here); otherwise at least
 * one remaining candidate's boundary crosses the cell, so subdivide to find
 * where; at max_depth, resolve remaining ambiguity among the pruned
 * candidates by whichever covers the largest share of the cell, since this
 * format has no exact-fallback marker.
 *
 * Pruning ancestors (not just "does at least one candidate fully contain
 * it") matters once region/country polygons are candidates alongside
 * cities: without it, a region trivially fully-contains a cell long before
 * the cell has shrunk enough to fit inside one of its much smaller cities,
 * so the whole cell gets attributed to the region and the city is never
 * discovered; and at max_depth, a region/country almost always wins a raw
 * area-share comparison against a small nested city simply by being much
 * bigger, which is backwards -- the city should win whenever it's actually
 * a candidate. Pruning is recomputed fresh at every cell (never inherited
 * from a parent), so a genuine gap with no covering city -- deep inside a
 * region but outside every one of its cities -- still correctly falls back
 * to that region once no city touches that specific cell anymore. */
export function buildChunkRecords(
  index: CandidateIndex,
  chunkBounds: CellBounds,
  maxDepth: number,
): ChunkRecord[] {
  const records: ChunkRecord[] = [];
  const rootCandidates = index.candidatesForBbox(
    chunkBounds.lonMin,
    chunkBounds.latMin,
    chunkBounds.lonMax,
    chunkBounds.latMax,
  );

  function cellBoundsOf(cellX: number, cellY: number, depth: number): CellBounds {
    const cellsPerSide = 2 ** depth;
    const lonWidth = (chunkBounds.lonMax - chunkBounds.lonMin) / cellsPerSide;
    const latHeight = (chunkBounds.latMax - chunkBounds.latMin) / cellsPerSide;
    const lonMin = chunkBounds.lonMin + cellX * lonWidth;
    const latMin = chunkBounds.latMin + cellY * latHeight;
    return { lonMin, lonMax: lonMin + lonWidth, latMin, latMax: latMin + latHeight };
  }

  function emit(cellX: number, cellY: number, depth: number, globalId: number): void {
    const fullX = cellX * 2 ** (maxDepth - depth);
    const fullY = cellY * 2 ** (maxDepth - depth);
    records.push({ code: mortonEncode(fullX, fullY, maxDepth), depth, globalId });
  }

  function recurse(cellX: number, cellY: number, depth: number, candidates: IndexedCandidate[]): void {
    if (candidates.length === 0) return;

    const bounds = cellBoundsOf(cellX, cellY, depth);

    // Cheap numeric bbox pre-filters before falling back to turf's exact
    // (and much more expensive) polygon algorithms -- most candidates drop
    // out here well before max_depth, since a shrinking cell quickly moves
    // outside a candidate's bounding box.
    const bboxOverlapping = candidates.filter(
      (c) => c.minX < bounds.lonMax && c.maxX > bounds.lonMin && c.minY < bounds.latMax && c.maxY > bounds.latMin,
    );
    if (bboxOverlapping.length === 0) return;

    const cell = cellPolygon(bounds);
    const touching = bboxOverlapping.filter((candidate) => touches(candidate.feature, cell));
    if (touching.length === 0) return;

    // Ignore any candidate that's an ancestor of a more specific candidate
    // also touching this same cell -- only for *deciding* this cell (the
    // full, unpruned `touching` is still what gets passed to children
    // below, since a child cell further down may have no such descendant
    // touching it at all, at which point the ancestor becomes relevant
    // again).
    const relevant = pruneAncestors(touching);

    const bboxContaining = relevant.filter(
      (c) => c.minX <= bounds.lonMin && c.maxX >= bounds.lonMax && c.minY <= bounds.latMin && c.maxY >= bounds.latMax,
    );
    const containing = bboxContaining.filter((candidate) => fullyContains(candidate.feature, cell));
    if (containing.length === relevant.length) {
      const winner = containing.reduce((a, b) => (a.area <= b.area ? a : b));
      emit(cellX, cellY, depth, winner.globalId);
      return;
    }

    if (depth < maxDepth) {
      const childDepth = depth + 1;
      recurse(cellX * 2, cellY * 2, childDepth, touching);
      recurse(cellX * 2 + 1, cellY * 2, childDepth, touching);
      recurse(cellX * 2, cellY * 2 + 1, childDepth, touching);
      recurse(cellX * 2 + 1, cellY * 2 + 1, childDepth, touching);
      return;
    }

    let bestId = relevant[0]!.globalId;
    let bestScore = -1;
    let bestArea = Infinity;
    for (const candidate of relevant) {
      const score = countContainedSamples(candidate.feature, bounds);
      if (score > bestScore || (score === bestScore && candidate.area < bestArea)) {
        bestScore = score;
        bestArea = candidate.area;
        bestId = candidate.globalId;
      }
    }
    emit(cellX, cellY, depth, bestId);
  }

  recurse(0, 0, 0, rootCandidates);
  records.sort((a, b) => a.code - b.code);
  return records;
}
