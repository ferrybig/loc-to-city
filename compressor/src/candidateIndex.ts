import RBush from "rbush";
import bbox from "@turf/bbox";
import area from "@turf/area";
import type { Feature, Polygon, MultiPolygon } from "geojson";

/** One candidate place to feed into the spatial index. `ancestorIds` is the
 * chain of enclosing place ids (e.g. a city's [regionId, countryId]), used
 * to prune a coarser candidate whenever a more specific descendant is also
 * a candidate for the same cell (see quadtree.ts). */
export interface CandidateEntry {
  globalId: number;
  feature: Feature<Polygon | MultiPolygon>;
  ancestorIds: number[];
}

export interface IndexedCandidate {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  globalId: number;
  feature: Feature<Polygon | MultiPolygon>;
  area: number;
  ancestorIds: number[];
}

/** bbox-based candidate lookup (the STRtree-equivalent from the Python
 * prototype), keyed by global place id so results can go straight into a
 * chunk's palette. */
export class CandidateIndex {
  private readonly tree = new RBush<IndexedCandidate>();

  constructor(entries: CandidateEntry[]) {
    const items: IndexedCandidate[] = entries.map(({ globalId, feature, ancestorIds }) => {
      const [minX, minY, maxX, maxY] = bbox(feature);
      return { minX, minY, maxX, maxY, globalId, feature, area: area(feature), ancestorIds };
    });
    this.tree.load(items);
  }

  candidatesForBbox(lonMin: number, latMin: number, lonMax: number, latMax: number): IndexedCandidate[] {
    return this.tree.search({ minX: lonMin, minY: latMin, maxX: lonMax, maxY: latMax });
  }
}
