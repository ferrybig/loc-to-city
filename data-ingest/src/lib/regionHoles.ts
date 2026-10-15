import type { BBox, Feature, MultiPolygon, Polygon } from "geojson";
import type { Cities500Row } from "./cities500.ts";
import type { Clipper, Outline } from "./clip.ts";
import { preparePolygon, type PreparedPolygon } from "./preparedPolygon.ts";
import { computeClippedCells } from "./voronoiFallback.ts";

/** A region of the country, as the region hole fill sees it. */
export interface RegionShape {
  name: string;
  bbox: BBox;
  geometry: Polygon | MultiPolygon;
}

export interface RegionHoles {
  /** Land added to an existing region, by its name. */
  extend: Map<string, Outline>;
  /** New regions, by name. */
  created: Map<string, Outline>;
}

/** The region hole fill (`VORONOI_REGION_HOLES`): names the land of a country
 * that no region of it covers, where `cities500.txt` places lie (Bissau,
 * Baku's outer districts, Karakalpakstan, Madeira), so its cities are no
 * longer dropped for having no region.
 *
 * Every point inside `outline` is a Voronoi site, so a hole's cells are
 * bounded by the places around it; only the cells of points no region
 * contains are used, each minus the regions it overlaps. A cell goes by its
 * point's GeoNames admin1 code: to the region of the nearest covered place
 * with the same code (Sabunçu is admin1 Baku, like the places in the `Bakı`
 * region, so Baku grows), else to a new region named after the admin1
 * (`admin1Names`; Bissau, Karakalpakstan), else, with no named admin1, to
 * the region of the nearest covered place, and in a country with no region
 * at all to a new one called `fallbackName`. Land a hole leaves nearer a
 * covered place stays as it was. */
export async function buildRegionHoles(
  country: string,
  outline: MultiPolygon,
  regions: readonly RegionShape[],
  points: readonly Cities500Row[],
  admin1Names: ReadonlyMap<string, string>,
  fallbackName: string,
  clip: Clipper,
): Promise<RegionHoles> {
  const extend = new Map<string, Outline>();
  const created = new Map<string, Outline>();
  const prepared: (PreparedPolygon | undefined)[] = new Array(regions.length);
  const regionAt = (x: number, y: number): RegionShape | undefined =>
    regions.find((region, i) => {
      const [minX, minY, maxX, maxY] = region.bbox;
      if (x < minX || x > maxX || y < minY || y > maxY) return false;
      return (prepared[i] ??= preparePolygon(region.geometry)).contains(x, y);
    });
  const land = preparePolygon(outline);
  const sites = points.filter(({ point: [x, y] }) => land.contains(x, y));
  const homes = sites.map(({ point: [x, y] }) => regionAt(x, y));
  if (!homes.includes(undefined)) return { extend, created };

  // Where a hole place goes: the region of the nearest covered place with
  // its admin1 code, else a region named for that admin1, else (no named
  // admin1) the region of the nearest covered place at all.
  const covered = sites.flatMap((site, i) => (homes[i] ? [{ site, region: homes[i]!.name }] : []));
  const nearest = (site: Cities500Row, code?: string): string | undefined => {
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const other of covered) {
      if (code !== undefined && other.site.admin1Code !== code) continue;
      const distance = (other.site.point[0] - site.point[0]) ** 2 + (other.site.point[1] - site.point[1]) ** 2;
      if (distance < bestDistance) [best, bestDistance] = [other.region, distance];
    }
    return best;
  };
  const existing = new Set(regions.map((r) => r.name));
  const target = (site: Cities500Row): { name: string; into: Map<string, Outline> } => {
    const sameCode = site.admin1Code ? nearest(site, site.admin1Code) : undefined;
    if (sameCode) return { name: sameCode, into: extend };
    const named = site.admin1Code ? admin1Names.get(`${country}.${site.admin1Code}`) : undefined;
    if (named) return { name: named, into: existing.has(named) ? extend : created };
    const any = nearest(site);
    if (any) return { name: any, into: extend };
    return { name: fallbackName, into: created };
  };

  const container: Feature<MultiPolygon> = { type: "Feature", properties: {}, geometry: outline };
  const cells = await computeClippedCells(container, sites, clip, (i) => homes[i] === undefined);
  const pieces = await Promise.all(
    cells.map(async (cell) => {
      if (!cell) return [];
      const shape: Outline = cell.type === "Polygon" ? [cell.coordinates] : cell.coordinates;
      const [minX, minY, maxX, maxY] = outlineBox(shape);
      const near = regions
        .filter(({ bbox: [a, b, c, d] }) => a <= maxX && c >= minX && b <= maxY && d >= minY)
        .flatMap(({ geometry }) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates));
      return near.length > 0 ? clip.difference(shape, near) : shape;
    }),
  );
  sites.forEach((site, i) => {
    const piece = pieces[i]!;
    if (piece.length === 0) return;
    const { name, into } = target(site);
    into.set(name, [...(into.get(name) ?? []), ...piece]);
  });
  return { extend, created };
}

function outlineBox(outline: Outline): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of outline) {
    for (const [x = 0, y = 0] of part[0]!) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}
