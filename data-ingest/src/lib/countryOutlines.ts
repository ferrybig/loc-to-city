import area from "@turf/area";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { type Clipper, clipper, type Outline } from "./clip.ts";
import { CountryPolygonIndex, indexPackedRing } from "./countryIndex.ts";
import type { LonLat } from "./geo.ts";

export type { Outline } from "./clip.ts";

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
 * overlapping, and is left to the compressor's tie-breaks.
 *
 * The cuts are made in sorted pair order, each from the outlines as the
 * cuts before it left them; `clip` may run cuts that don't depend on each
 * other side by side, which changes nothing about the result. */
export async function resolveCountryOverlaps(
  outlines: ReadonlyMap<string, Outline>,
  ownerAt: (point: LonLat) => string | null,
  coarse: ReadonlySet<string> = new Set(),
  clip: Clipper = clipper(),
): Promise<{ outlines: Map<string, Outline>; cuts: OverlapCut[] }> {
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

  // Each country's latest outline, as a promise of it: a cut starts as soon
  // as the two versions it reads are done.
  const result = new Map([...outlines].map(([code, outline]) => [code, Promise.resolve(outline)]));
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
          : outlineArea(await result.get(a)!) <= outlineArea(await result.get(b)!)
            ? a
            : b;
    const from = owner === a ? b : a;
    const fromOutline = result.get(from)!;
    const ownerOutline = result.get(owner)!;
    result.set(from, Promise.all([fromOutline, ownerOutline]).then(([f, o]) => cutOut(f, o, clip)));
    cuts.push({ from, owner, votes: Object.fromEntries(votes) });
  }
  const settled = await Promise.all([...result].map(async ([code, outline]) => [code, await outline] as const));
  return { outlines: new Map(settled), cuts };
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
 * Regions used to be simplified (~1.1 km), which dropped a small hole:
 * France's Provence-Alpes-Côte d'Azur covered all of Monaco, and Lazio the
 * Vatican; 302 regions were cut, most by a sliver of overshoot. At full
 * precision only 10 are (Western Sahara, a Danube island between Croatia
 * and Serbia, Kafia Kingi), but a region whose OSM relation includes land
 * the lookup gives to another country still needs this. A region of another country is no ancestor of
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
export async function cutCountriesOutOfForeignRegions(
  regions: ReadonlyMap<string, { country: string; geometry: Polygon | MultiPolygon }>,
  outlines: ReadonlyMap<string, Outline>,
  ownerAt: (point: LonLat) => string | null,
  clip: Clipper = clipper(),
): Promise<{ geometryByRegion: Map<string, Outline>; cuts: RegionCut[] }> {
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

  // As in resolveCountryOverlaps: a region's cuts are made one after the
  // other, and different regions' side by side.
  const geometryByRegion = new Map<string, Promise<Outline>>();
  const cuts: RegionCut[] = [];
  for (const pair of [...votesByPair.keys()].sort()) {
    const votes = votesByPair.get(pair)!;
    const [region, country] = pair.split("\t") as [string, string];
    const forCountry = votes.get(country) ?? 0;
    if (forCountry < 2 || forCountry <= (votes.get(regions.get(region)!.country) ?? 0)) continue;
    const before = geometryByRegion.get(region) ?? Promise.resolve(regionOutlines.get(region)!);
    geometryByRegion.set(region, before.then((outline) => cutOut(outline, outlines.get(country)!, clip)));
    cuts.push({ region, country, votes: Object.fromEntries(votes) });
  }
  const settled = await Promise.all(
    [...geometryByRegion].map(async ([region, outline]) => [region, await outline] as const),
  );
  return { geometryByRegion: new Map(settled), cuts };
}

/** Which outline contains a point, for outlines `resolveCountryOverlaps`
 * has made disjoint (the first in R-tree order, for a sliver it missed). */
export function outlineLookup(outlines: ReadonlyMap<string, Outline>): (point: LonLat) => string | null {
  const index = indexOutlines(outlines);
  return ([x, y]) => index.first(x, y);
}

/** The index `outlineLookup` answers from. */
export function indexOutlines(outlines: ReadonlyMap<string, Outline>): CountryPolygonIndex {
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
async function cutOut(outline: Outline, owner: Outline, clip: Clipper): Promise<Outline> {
  const ownerBoxes = owner.map((part) => ringBbox(part[0]!));
  const meets = (box: number[]) =>
    ownerBoxes.some((o) => box[0]! <= o[2]! && box[2]! >= o[0]! && box[1]! <= o[3]! && box[3]! >= o[1]!);
  const near: Outline = [];
  const kept: Outline = [];
  for (const part of outline) (meets(ringBbox(part[0]!)) ? near : kept).push(part);
  if (near.length === 0) return outline;
  const nearBox = near.map((part) => ringBbox(part[0]!));
  const clipParts = owner.filter((_, i) =>
    nearBox.some((n) => n[0]! <= ownerBoxes[i]![2]! && n[2]! >= ownerBoxes[i]![0]! && n[1]! <= ownerBoxes[i]![3]! && n[3]! >= ownerBoxes[i]![1]!),
  );
  return [...kept, ...(await clip.difference(near, clipParts))];
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
