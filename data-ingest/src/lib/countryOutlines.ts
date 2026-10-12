import area from "@turf/area";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { difference, type Geom } from "polyclip-ts";
import { CountryPolygonIndex, indexPackedRing } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";

/** A MultiPolygon's `coordinates`. */
export type Outline = Position[][][];

export interface OverlapCut {
  /** The country the overlap was cut out of. */
  from: string;
  /** The country that keeps it. */
  owner: string;
  /** Sampled points in the overlap, by what `ownerAt` said about them
   * (`"-"`: neither of the two). */
  votes: Record<string, number>;
}

/** Makes country outlines that overlap each other not overlap.
 *
 * The compressor has no rule for two unrelated places that both cover a
 * cell, other than "smallest area wins when both contain it" and "largest
 * share wins at max depth". The second loses a nested country: Puerto Rico
 * inside the outline OSM draws for the United States lost every cell its
 * small cities share, to a country covering all of it (measured: 195 of
 * Puerto Rico's cities500 points answered "United States", no region).
 * So every overlap gets one owner, and is cut out of the other outline:
 *
 * - a dependency inside its parent's outline (Hong Kong in China, Aruba
 *   in the Netherlands, Åland in Finland), and
 * - a disputed area both claim (Crimea, Western Sahara, Abyei).
 *
 * The owner is whichever of the two `ownerAt` names for most sampled
 * points in the overlap -- prepare-world passes the same Natural Earth +
 * OSM lookup that assigned every city and region to a country, so the
 * outline agrees with the places under it. When it names neither (the
 * overlap is at sea), the smaller country keeps it: territorial waters
 * around a dependency are the dependency's.
 *
 * Except that a `coarse` outline (Natural Earth's, for a country OSM has
 * no relation for) never takes land from a precise one: its overshoot is
 * exactly where `ownerAt`, being Natural Earth too, names it. Palestine's
 * took Bāqa el Gharbīya and Zemer from Israel and Egyptian Rafah from
 * Egypt that way.
 *
 * Overlaps are found by sampling points in every polygon part of every
 * outline (seeded, so deterministic), not by intersecting every pair: a
 * country's bbox can span the globe (France, the United States), and the
 * clipping itself is the expensive part. A sliver no sample hits stays
 * overlapping, and is left to the compressor's tie-breaks. */
export function resolveCountryOverlaps(
  outlines: ReadonlyMap<string, Outline>,
  ownerAt: (point: LonLat) => string | null,
  coarse: ReadonlySet<string> = new Set(),
): { outlines: Map<string, Outline>; cuts: OverlapCut[] } {
  const index = indexOutlines(outlines);
  const votesByPair = new Map<string, Map<string, number>>();
  sampleOutlines(outlines, index, (code, point, codes) => {
    for (const other of codes) {
      if (other === code) continue;
      const pair = [code, other].sort().join("/");
      const owner = ownerAt(point);
      vote(votesByPair, pair, owner === code || owner === other ? owner : "-");
    }
  });

  const result = new Map(outlines);
  const cuts: OverlapCut[] = [];
  for (const pair of [...votesByPair.keys()].sort()) {
    const votes = votesByPair.get(pair)!;
    const [a, b] = pair.split("/") as [string, string];
    const forA = votes.get(a) ?? 0;
    const forB = votes.get(b) ?? 0;
    const owner =
      coarse.has(a) !== coarse.has(b)
        ? coarse.has(a)
          ? b
          : a
        : forA !== forB
          ? forA > forB
            ? a
            : b
          : outlineArea(result.get(a)!) <= outlineArea(result.get(b)!)
            ? a
            : b;
    const from = owner === a ? b : a;
    result.set(from, cutOut(result.get(from)!, result.get(owner)!));
    cuts.push({ from, owner, votes: Object.fromEntries(votes) });
  }
  return { outlines: result, cuts };
}

export interface RegionCut {
  /** The region's key, as passed in. */
  region: string;
  /** The country cut out of it. */
  country: string;
  votes: Record<string, number>;
}

/** Cuts countries out of *other* countries' region polygons, where
 * `ownerAt` says the land is the country's.
 *
 * Regions are simplified (~1.1 km, adminBoundaryIndex.ts), which drops a
 * small hole: France's Provence-Alpes-Côte d'Azur covered all of Monaco,
 * and Lazio the Vatican. A region of another country is no ancestor of
 * Monaco's places, so it wins every cell Monaco's own places only partly
 * cover (measured: Mareterra, Monaco's reclaimed district outside the
 * older city polygon, answered France / Provence-Alpes-Côte d'Azur).
 *
 * Each country's outline is sampled as in `resolveCountryOverlaps`; a
 * point inside a foreign region is a vote for whichever of the two
 * countries `ownerAt` names there. The country is cut out of the region
 * when it has at least two votes and more than the region's own country.
 * At sea `ownerAt` names neither, so a coastal region simply overlapping a
 * neighbour's territorial waters is left alone, and so is a disputed area
 * `ownerAt` gives to the region's country (Western Sahara inside
 * Morocco's regions). Only the regions that change are returned. */
export function cutCountriesOutOfForeignRegions(
  regions: ReadonlyMap<string, { country: string; geometry: Polygon | MultiPolygon }>,
  outlines: ReadonlyMap<string, Outline>,
  ownerAt: (point: LonLat) => string | null,
): { geometryByRegion: Map<string, Outline>; cuts: RegionCut[] } {
  const regionOutlines = new Map<string, Outline>();
  for (const [key, { geometry }] of regions) {
    regionOutlines.set(key, geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates);
  }
  const regionIndex = indexOutlines(regionOutlines);
  const votesByPair = new Map<string, Map<string, number>>();
  sampleOutlines(outlines, indexOutlines(outlines), (code, point) => {
    for (const key of regionIndex.codesAt(point[0], point[1])) {
      const regionCountry = regions.get(key)!.country;
      if (regionCountry === code) continue;
      const owner = ownerAt(point);
      vote(votesByPair, `${key}\t${code}`, owner === code || owner === regionCountry ? owner : "-");
    }
  });

  const geometryByRegion = new Map<string, Outline>();
  const cuts: RegionCut[] = [];
  for (const pair of [...votesByPair.keys()].sort()) {
    const votes = votesByPair.get(pair)!;
    const [region, country] = pair.split("\t") as [string, string];
    const forCountry = votes.get(country) ?? 0;
    if (forCountry < 2 || forCountry <= (votes.get(regions.get(region)!.country) ?? 0)) continue;
    geometryByRegion.set(region, cutOut(geometryByRegion.get(region) ?? regionOutlines.get(region)!, outlines.get(country)!));
    cuts.push({ region, country, votes: Object.fromEntries(votes) });
  }
  return { geometryByRegion, cuts };
}

/** Which outline contains a point, for outlines `resolveCountryOverlaps`
 * has made disjoint (the first in R-tree order, for a sliver it missed). */
export function outlineLookup(outlines: ReadonlyMap<string, Outline>): (point: LonLat) => string | null {
  const index = indexOutlines(outlines);
  return ([x, y]) => index.first(x, y);
}

function indexOutlines(outlines: ReadonlyMap<string, Outline>): CountryPolygonIndex {
  const index = new CountryPolygonIndex();
  for (const [code, outline] of outlines) {
    index.add(
      code,
      outline.map(([outer, ...holes]) => ({
        outer: indexPackedRing(packRing(outer!)),
        holes: holes.map((hole) => indexPackedRing(packRing(hole))),
      })),
    );
  }
  return index;
}

/** Calls `visit` with points sampled inside each outline (seeded, so the
 * same input always gives the same points), and every key of `index` at
 * that point. Every outline gets the same number of samples, shared out
 * over its parts by bbox area, so a small country's own land outvotes the
 * handful of points where Natural Earth's coarse border disagrees (Hong
 * Kong got 16 samples when counts went by part size, and lost to China's
 * 176 from that border strip). Every part gets a few more on top, or an
 * atoll in a country spread over an ocean might get none. */
function sampleOutlines(
  outlines: ReadonlyMap<string, Outline>,
  index: CountryPolygonIndex,
  visit: (code: string, point: LonLat, codes: string[]) => void,
): void {
  let seed = 1;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (const [code, outline] of outlines) {
    const boxes = outline.map((part) => ringBbox(part[0]!));
    const weights = boxes.map(([minX, minY, maxX, maxY]) => (maxX - minX) * (maxY - minY));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    boxes.forEach(([minX, minY, maxX, maxY], i) => {
      const count = Math.round((4000 * weights[i]!) / total) + 16;
      let inside = 0;
      for (let tries = 0; tries < count * 50 && inside < count; tries++) {
        const x = minX + random() * (maxX - minX);
        const y = minY + random() * (maxY - minY);
        const codes = index.codesAt(x, y);
        if (!codes.includes(code)) continue;
        inside++;
        visit(code, [x, y], codes);
      }
    });
  }
}

function vote(votesByPair: Map<string, Map<string, number>>, pair: string, owner: string): void {
  let votes = votesByPair.get(pair);
  if (!votes) {
    votes = new Map();
    votesByPair.set(pair, votes);
  }
  votes.set(owner, (votes.get(owner) ?? 0) + 1);
}

/** `outline` minus `owner`. Only the parts whose bbox meets the owner's
 * parts are clipped, against only those owner parts; the rest are kept
 * as they are, untouched by the clipper's rounding. */
function cutOut(outline: Outline, owner: Outline): Outline {
  const ownerBoxes = owner.map((part) => ringBbox(part[0]!));
  const meets = (box: number[]) =>
    ownerBoxes.some((o) => box[0]! <= o[2]! && box[2]! >= o[0]! && box[1]! <= o[3]! && box[3]! >= o[1]!);
  const near: Outline = [];
  const kept: Outline = [];
  for (const part of outline) (meets(ringBbox(part[0]!)) ? near : kept).push(part);
  if (near.length === 0) return outline;
  const nearBox = near.map((part) => ringBbox(part[0]!));
  const clipper = owner.filter((_, i) =>
    nearBox.some((n) => n[0]! <= ownerBoxes[i]![2]! && n[2]! >= ownerBoxes[i]![0]! && n[1]! <= ownerBoxes[i]![3]! && n[3]! >= ownerBoxes[i]![1]!),
  );
  return [...kept, ...(difference(near as Geom, clipper as Geom) as Outline)];
}

function outlineArea(outline: Outline): number {
  return area({ type: "MultiPolygon", coordinates: outline } satisfies MultiPolygon);
}

function ringBbox(ring: Position[]): [number, number, number, number] {
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

function packRing(ring: Position[]): Float64Array {
  const xy = new Float64Array(ring.length * 2);
  ring.forEach(([x = 0, y = 0], i) => {
    xy[i * 2] = x;
    xy[i * 2 + 1] = y;
  });
  return xy;
}
