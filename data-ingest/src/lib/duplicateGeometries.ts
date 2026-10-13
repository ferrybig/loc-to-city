import { createHash } from "node:crypto";

/** Finds cities emitted with byte-identical geometry: two OSM relations
 * drawn with the same ways (Alix and "Village of Alix", Pulap and
 * Tamatam), a few hundred worldwide. The compressor gives such a pair's
 * cells to one of them only (quadtree.ts's `preferred`), so the other
 * never resolves; listed so they can be reported upstream or picked by a
 * rule. Only identical text counts: the same outline written from another
 * starting vertex is not found. */
export class DuplicateGeometries<T> {
  private readonly byHash = new Map<string, T[]>();

  add(geometryJson: string, item: T): void {
    const hash = createHash("sha1").update(geometryJson).digest("base64");
    const items = this.byHash.get(hash);
    if (items) items.push(item);
    else this.byHash.set(hash, [item]);
  }

  /** Every geometry added more than once, with its items in the order they
   * were added; groups in the order their first item was. */
  groups(): T[][] {
    return [...this.byHash.values()].filter((items) => items.length > 1);
  }
}

/** The openstreetmap.org page of the object a city came from. osmium's
 * `--add-unique-id type_id` area ids are `a` plus twice the way id, or
 * twice the relation id plus one; anything else (a synthesized city) has
 * none. */
export function osmUrlFor(id: string): string | undefined {
  const match = /^a(\d+)$/.exec(id);
  if (!match) return undefined;
  const areaId = Number(match[1]);
  return areaId % 2 === 1
    ? `https://www.openstreetmap.org/relation/${(areaId - 1) / 2}`
    : `https://www.openstreetmap.org/way/${areaId / 2}`;
}
