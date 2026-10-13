import { mortonEncode } from "@ferrybig/cgeodata-reader/format";
import type { IndexedCandidate } from "./candidateIndex.ts";
import { type CellBounds, classifyCell, countContainedSamples } from "./geometry.ts";

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

/** Of two candidates equally good for a cell, the one that gets it: the
 * smaller, then (for identical polygons, which only differ in this) the
 * finer tier -- a city over a region over a country -- then the lower
 * global id (cities in a region are numbered by their `id` property, OSM's
 * relation id for an OSM city). A total order, so the
 * answer never depends on the order candidates come in: that is the
 * spatial index's search order, which any added candidate anywhere
 * reshuffles. OSM holds a few hundred duplicate relations with identical
 * geometry (Alix and "Village of Alix"); with first-in-array-wins they
 * flipped between builds for no reason (countries.md, "Capitals that are
 * their own region"). */
function preferred(a: IndexedCandidate, b: IndexedCandidate): IndexedCandidate {
  if (a.area !== b.area) return a.area < b.area ? a : b;
  if (a.ancestorIds.length !== b.ancestorIds.length) return a.ancestorIds.length > b.ancestorIds.length ? a : b;
  return a.globalId <= b.globalId ? a : b;
}

/** Adaptive quadtree subdivision for one chunk (Section 10's "Building
 * records" guidance): stop and emit nothing when no place touches a cell;
 * otherwise prune ancestors of any more specific candidate also touching
 * this cell (a region is irrelevant here if one of its own cities is also a
 * candidate), then stop and emit a record when *every remaining* candidate
 * fully contains the cell (preferring the smallest, see `preferred` -- safe
 * exactly because none of their boundaries pass through here); otherwise at least
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
 * to that region once no city touches that specific cell anymore.
 *
 * `rootCandidates` must already be the result of querying the spatial
 * index for `chunkBounds` (i.e. `CandidateIndex.candidatesForBbox`) --
 * this function never touches the index itself, which is what makes it
 * safe to run inside a worker thread given only a plain array. Their
 * order does not matter: every pick below goes through
 * `preferred`, a total order, so the output is the same for any order of
 * `rootCandidates`. */
export function buildChunkRecords(
  rootCandidates: IndexedCandidate[],
  chunkBounds: CellBounds,
  maxDepth: number,
): ChunkRecord[] {
  const records: ChunkRecord[] = [];

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

    // Cheap numeric bbox pre-filters before falling back to the (much more
    // expensive) polygon walk in classifyCell -- most candidates drop
    // out here well before max_depth, since a shrinking cell quickly moves
    // outside a candidate's bounding box.
    const bboxOverlapping = candidates.filter(
      (c) => c.minX < bounds.lonMax && c.maxX > bounds.lonMin && c.minY < bounds.latMax && c.maxY > bounds.latMin,
    );
    if (bboxOverlapping.length === 0) return;

    // One classification per candidate answers both questions this cell
    // needs -- "does it touch" and "does it fully contain" -- so the
    // expensive geometry is walked once instead of twice.
    const touching: IndexedCandidate[] = [];
    const containsCell = new Set<number>();
    for (const candidate of bboxOverlapping) {
      const relation = classifyCell(candidate.geometry, bounds, candidate.minX, candidate.minY, candidate.maxX, candidate.maxY);
      if (relation === "disjoint") continue;
      touching.push(candidate);
      if (relation === "contains") containsCell.add(candidate.globalId);
    }
    if (touching.length === 0) return;

    // Ignore any candidate that's an ancestor of a more specific candidate
    // also touching this same cell -- only for *deciding* this cell (the
    // full, unpruned `touching` is still what gets passed to children
    // below, since a child cell further down may have no such descendant
    // touching it at all, at which point the ancestor becomes relevant
    // again).
    const relevant = pruneAncestors(touching);

    const containing = relevant.filter((candidate) => containsCell.has(candidate.globalId));
    if (containing.length === relevant.length) {
      const winner = containing.reduce(preferred);
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

    let best = relevant[0]!;
    let bestScore = -1;
    for (const candidate of relevant) {
      const score = countContainedSamples(candidate.geometry, bounds);
      if (score > bestScore || (score === bestScore && preferred(candidate, best) === candidate)) {
        bestScore = score;
        best = candidate;
      }
    }
    emit(cellX, cellY, depth, best.globalId);
  }

  recurse(0, 0, 0, rootCandidates);
  records.sort((a, b) => a.code - b.code);
  return records;
}
