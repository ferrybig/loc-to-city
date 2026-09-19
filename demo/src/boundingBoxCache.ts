import { boundingBoxContains, type BoundingBox, type QueryResult } from "@loc-to-city/reader";

/**
 * A small most-recently-used cache of {boundingBox, result} pairs.
 *
 * A tile render samples many nearby pixels, and at any reasonable zoom
 * level several of them land inside the exact same underlying grid cell
 * (see CGeoDataReader.query's `boundingBox` field) -- without this, each
 * of those repeat hits pays for a full binary search plus name lookups for
 * a result that's already been computed. Checked linearly, since the
 * capacity is small and a plain array beats any fancier structure at this
 * size.
 */
export class BoundingBoxCache {
  private readonly entries: Array<{ box: BoundingBox; result: QueryResult }> = [];

  constructor(private readonly capacity = 16) {}

  lookup(lat: number, lon: number): QueryResult | undefined {
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (boundingBoxContains(entry.box, lat, lon)) {
        if (i > 0) {
          this.entries.splice(i, 1);
          this.entries.unshift(entry);
        }
        return entry.result;
      }
    }
    return undefined;
  }

  insert(result: QueryResult): void {
    this.entries.unshift({ box: result.boundingBox, result });
    if (this.entries.length > this.capacity) this.entries.pop();
  }
}
