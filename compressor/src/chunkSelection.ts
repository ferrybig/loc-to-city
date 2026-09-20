/** Parses a `--only-chunks` spec: a comma-separated list of chunk indices
 * and inclusive ranges, e.g. `"200"` or `"200,300-500"`. The empty string
 * parses to an empty selection, meaning no chunk is compressed at all --
 * the resulting file still carries a complete place table and name blocks,
 * which is the point (a dictionary-only build).
 *
 * Only non-negative integers are accepted; anything else throws rather
 * than silently selecting nothing, since a typo that quietly produces an
 * all-empty file is exactly the failure this flag exists to avoid. */
export function parseChunkSelection(spec: string): Set<number> {
  const selected = new Set<number>();
  const trimmed = spec.trim();
  if (trimmed === "") return selected;

  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (item === "") {
      throw new Error(`empty entry in chunk selection ${JSON.stringify(spec)}`);
    }

    const range = /^(\d+)-(\d+)$/.exec(item);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) {
        throw new Error(`chunk range ${item} starts after it ends`);
      }
      for (let i = start; i <= end; i++) selected.add(i);
      continue;
    }

    if (!/^\d+$/.test(item)) {
      throw new Error(`not a chunk index or range: ${JSON.stringify(item)}`);
    }
    selected.add(Number(item));
  }

  return selected;
}
