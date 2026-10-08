import RBush from "rbush";
import bbox from "@turf/bbox";
import area from "@turf/area";
import type { Feature, Polygon, MultiPolygon } from "geojson";
import { packGeometry, type PackedGeometry } from "./geometry.ts";

/** Everything the build needs from a place's polygon, computed from its
 * GeoJSON once: the classifier's flat rings, plus the bbox and area turf
 * measures on the original feature. Packing as early as possible is what
 * lets the city layer be loaded without ever holding it as GeoJSON (see
 * `loadCities`). */
export interface PackedShape {
  geometry: PackedGeometry;
  bbox: [number, number, number, number];
  area: number;
}

export function packFeature(feature: Feature<Polygon | MultiPolygon>): PackedShape {
  const [minX, minY, maxX, maxY] = bbox(feature);
  return { geometry: packGeometry(feature.geometry), bbox: [minX, minY, maxX, maxY], area: area(feature) };
}

/** One candidate place to feed into the spatial index. `ancestorIds` is the
 * chain of enclosing place ids (e.g. a city's [regionId, countryId]), used
 * to prune a coarser candidate whenever a more specific descendant is also
 * a candidate for the same cell (see quadtree.ts). */
export interface CandidateEntry {
  globalId: number;
  shape: PackedShape;
  ancestorIds: number[];
}

export interface IndexedCandidate {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  globalId: number;
  geometry: PackedGeometry;
  area: number;
  ancestorIds: number[];
}

/** bbox-based candidate lookup (the STRtree-equivalent from the Python
 * prototype), keyed by global place id so results can go straight into a
 * chunk's palette. */
export class CandidateIndex {
  private readonly tree = new RBush<IndexedCandidate>();

  constructor(entries: CandidateEntry[]) {
    const items: IndexedCandidate[] = entries.map(({ globalId, shape, ancestorIds }) => {
      const [minX, minY, maxX, maxY] = shape.bbox;
      return { minX, minY, maxX, maxY, globalId, geometry: shape.geometry, area: shape.area, ancestorIds };
    });
    this.tree.load(items);
  }

  candidatesForBbox(lonMin: number, latMin: number, lonMax: number, latMax: number): IndexedCandidate[] {
    return this.tree.search({ minX: lonMin, minY: latMin, maxX: lonMax, maxY: latMax });
  }
}
