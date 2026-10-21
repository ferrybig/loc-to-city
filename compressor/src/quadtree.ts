import { mortonEncode } from "@ferrybig/cgeodata-reader/format";
import type { IndexedCandidate } from "./candidateIndex.ts";
import { AREA_SHARE_SAMPLE_COUNT, type CellBounds, classifyCell, containedSampleMask } from "./geometry.ts";

/** Every sample point of a cell (`containedSampleMask`). */
const ALL_SAMPLES = 2 ** AREA_SHARE_SAMPLE_COUNT - 1;

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

/** Of two candidates equally good for a cell, the one that gets it: not a
 * gap-fill city (`CityProperties.gapFill`: it names what primary cities
 * leave, so where it overlaps one, the primary keeps the cell; drawn from
 * other sources, their shared edges otherwise trade cells back and forth,
 * Hyderabad and the mandals around it), then the
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
  if (a.gapFill !== b.gapFill) return a.gapFill ? b : a;
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
 * Subdivision is forced by *any* surviving candidate's boundary crossing
 * the cell, including one that then wins nothing: all four children can
 * still resolve to the same place, each by its own route (full containment
 * on one side, the sample vote on the other). `recurse` therefore returns
 * its subtree's records instead of pushing them into one array, and four
 * children that came back as one record each *at the child depth*, for the
 * same place, are replaced by the single record their parent would have
 * emitted (a child only part of which any place touches comes back as one
 * record too, of that part, at a deeper depth: merging four of those would
 * hand the place the empty cells in between). That is
 * lossless on the wire -- a record's `code` and `depth` already describe a
 * cell of any size, and not every leaf reaches max_depth anyway -- and it
 * cascades, since a merged record is itself one of four siblings one level
 * up. Measured on `world-high-res.bin`: 166,081,761 records down to
 * 106,377,942 (-36.0%), 73,911,162 chunk bytes down to 62,220,461
 * (-15.8%).
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
  function cellBoundsOf(cellX: number, cellY: number, depth: number): CellBounds {
    const cellsPerSide = 2 ** depth;
    const lonWidth = (chunkBounds.lonMax - chunkBounds.lonMin) / cellsPerSide;
    const latHeight = (chunkBounds.latMax - chunkBounds.latMin) / cellsPerSide;
    const lonMin = chunkBounds.lonMin + cellX * lonWidth;
    const latMin = chunkBounds.latMin + cellY * latHeight;
    return { lonMin, lonMax: lonMin + lonWidth, latMin, latMax: latMin + latHeight };
  }

  /** The one record a cell resolving as a whole produces. */
  function recordFor(cellX: number, cellY: number, depth: number, globalId: number): ChunkRecord[] {
    const fullX = cellX * 2 ** (maxDepth - depth);
    const fullY = cellY * 2 ** (maxDepth - depth);
    return [{ code: mortonEncode(fullX, fullY, maxDepth), depth, globalId }];
  }

  /** A cell no place touches: shared, so the common case allocates nothing.
   * Never handed out as the result -- `buildChunkRecords` copies it. */
  const EMPTY: ChunkRecord[] = [];

  function recurse(cellX: number, cellY: number, depth: number, candidates: IndexedCandidate[]): ChunkRecord[] {
    if (candidates.length === 0) return EMPTY;

    const bounds = cellBoundsOf(cellX, cellY, depth);

    // Cheap numeric bbox pre-filters before falling back to the (much more
    // expensive) polygon walk in classifyCell -- most candidates drop
    // out here well before max_depth, since a shrinking cell quickly moves
    // outside a candidate's bounding box.
    const bboxOverlapping = candidates.filter(
      (c) => c.minX < bounds.lonMax && c.maxX > bounds.lonMin && c.minY < bounds.latMax && c.maxY > bounds.latMin,
    );
    if (bboxOverlapping.length === 0) return EMPTY;

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
    if (touching.length === 0) return EMPTY;

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
      return recordFor(cellX, cellY, depth, winner.globalId);
    }

    if (depth < maxDepth) {
      const childDepth = depth + 1;
      // In Morton order, so the concatenation below is already sorted by
      // code (the final sort then only has to confirm it).
      const sw = recurse(cellX * 2, cellY * 2, childDepth, touching);
      const se = recurse(cellX * 2 + 1, cellY * 2, childDepth, touching);
      const nw = recurse(cellX * 2, cellY * 2 + 1, childDepth, touching);
      const ne = recurse(cellX * 2 + 1, cellY * 2 + 1, childDepth, touching);
      // Nothing here needed subdividing after all: four children that each
      // resolved as a whole, to the same place, are this cell. A candidate
      // whose boundary crosses the cell but wins none of it forces the
      // subdivision above, and this is what takes it back.
      //
      // `depth === childDepth` is what says a child resolved as a whole,
      // and one record is not enough on its own: a child only part of
      // which any place touches at all also returns a single record, of
      // that part, and merging those four would hand the place the cells
      // in between -- four islands of one city, one per quadrant, would
      // become the whole cell.
      const whole = (child: ChunkRecord[]): ChunkRecord | undefined =>
        child.length === 1 && child[0]!.depth === childDepth ? child[0] : undefined;
      const first = whole(sw);
      if (first) {
        const { globalId } = first;
        const same = (child: ChunkRecord[]): boolean => whole(child)?.globalId === globalId;
        if (same(se) && same(nw) && same(ne)) return recordFor(cellX, cellY, depth, globalId);
      }
      return [...sw, ...se, ...nw, ...ne];
    }

    // A max-depth cell that no candidate decides alone goes to the place
    // most of it would get as a cell of its own: at each sample point, the
    // candidates containing that point, less the ancestors of any other
    // among them, `preferred` between the rest; the most frequent answer
    // wins. Any other rule makes a border cell disagree with the cells on
    // both sides, and a border becomes a line of cells of its own:
    // - a district over its parishes, if containing the cell won it: every
    //   parish border district-named;
    // - a region crossing a city of another region it overlaps, if a large
    //   enough share won it: a line of region cells through the city
    //   (Egypt's Voronoi cities spanning their governorates' borders);
    // - a city reaching into another region that is smaller than it (the
    //   region wins inside), if that region was pruned for its own city
    //   touching the cell: a line of the city's cells along that city's
    //   edge (Tāzirbū across Al-Jufra, Libya; a Malian cercle drawn before
    //   Taoudénit was split off Timbuktu).
    // A point where only candidates pruned above remain (an ancestor of a
    // candidate touching the cell) has no vote: a region never takes a cell
    // from its own city for the sea or the unincorporated land beside it
    // (coastal towns, Munford's hole). Where such a region meets a candidate
    // that is not its own, as in the last case above, it does count. Points
    // with the same candidates around them share an answer.
    // A pruned candidate's samples are only needed where a candidate that
    // is not its own descendant contains the point, which is rare: the
    // country and region outlines pruned here are the biggest polygons.
    const pruned = touching.filter((candidate) => !relevant.includes(candidate));
    const masks = relevant.map((candidate) =>
      containsCell.has(candidate.globalId) ? ALL_SAMPLES : containedSampleMask(candidate.geometry, bounds),
    );
    const prunedMasks: (number | undefined)[] = [];
    const prunedMask = (j: number): number => {
      const candidate = pruned[j]!;
      prunedMasks[j] ??= containsCell.has(candidate.globalId) ? ALL_SAMPLES : containedSampleMask(candidate.geometry, bounds);
      return prunedMasks[j];
    };
    const answers = new Map<string, IndexedCandidate | undefined>();
    const votes = new Map<IndexedCandidate, number>();
    for (let sample = 0; sample < AREA_SHARE_SAMPLE_COUNT; sample++) {
      const bit = 2 ** sample;
      const here = relevant.filter((_, i) => masks[i]! & bit);
      if (here.length === 0) continue;
      let key = "";
      for (let i = 0; i < relevant.length; i++) if (masks[i]! & bit) key += `${i},`;
      for (let j = 0; j < pruned.length; j++) {
        const id = pruned[j]!.globalId;
        if (here.some((candidate) => !candidate.ancestorIds.includes(id)) && prunedMask(j) & bit) {
          here.push(pruned[j]!);
          key += `p${j},`;
        }
      }
      let answer = answers.get(key);
      if (!answers.has(key)) {
        const ancestors = new Set(here.flatMap((candidate) => candidate.ancestorIds));
        answer = here.filter((candidate) => !ancestors.has(candidate.globalId)).reduce(preferred);
        answers.set(key, answer);
      }
      votes.set(answer!, (votes.get(answer!) ?? 0) + 1);
    }
    let best: IndexedCandidate | undefined;
    let bestVotes = 0;
    for (const [candidate, count] of votes) {
      if (count > bestVotes || (count === bestVotes && preferred(candidate, best!) === candidate)) {
        bestVotes = count;
        best = candidate;
      }
    }
    // No sample point inside any candidate: a sliver of each, at most.
    best ??= relevant.reduce(preferred);
    return recordFor(cellX, cellY, depth, best.globalId);
  }

  const records = [...recurse(0, 0, 0, rootCandidates)];
  records.sort((a, b) => a.code - b.code);
  return records;
}
