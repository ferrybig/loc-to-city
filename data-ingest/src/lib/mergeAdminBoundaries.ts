import type { Feature } from "geojson";
import { streamGeoJSONSeq } from "./geojsonseqStream.js";

/** Streams every file in `files`, in order, deduplicating by the id field
 * `osmium export --add-unique-id type_id` adds (observed in practice as
 * e.g. `"a16115300"` -- osmium's internal "area" id, deterministically
 * derived from the underlying relation id, not a bare `"r<relation id>"`
 * as osmium's docs might suggest; the exact prefix doesn't matter here,
 * only that the same source relation always produces the same id). First
 * occurrence wins.
 *
 * This is safe because of what this session verified empirically on the
 * real Europe/Asia/Russia extracts: a relation that spans more than one
 * Geofabrik continent file (Russia, Turkey...) has a byte-identical,
 * full-detail copy in every file whose geographic clip it falls inside --
 * never a truncated/coarser stub in one and a full copy in another. So
 * there's no need for a per-country "prefer this file" priority list;
 * whichever file is scanned first for a given id is exactly as correct as
 * any other. */
export async function* streamMergedAdminBoundaries(
  files: string[],
): AsyncGenerator<{ id: string; feature: Feature }> {
  const seen = new Set<string>();
  let noId = 0;
  let duplicates = 0;

  for (const file of files) {
    for await (const feature of streamGeoJSONSeq(file)) {
      const id = featureId(feature);
      if (id === undefined) {
        noId++;
        continue;
      }
      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);
      yield { id, feature };
    }
  }

  if (noId > 0) {
    console.error(
      `streamMergedAdminBoundaries: ${noId} features had no id (extraction missing --add-unique-id?), skipped`,
    );
  }
  console.error(`streamMergedAdminBoundaries: ${seen.size} unique relations, ${duplicates} cross-file duplicates dropped`);
}

function featureId(feature: Feature): string | undefined {
  if (typeof feature.id === "string" || typeof feature.id === "number") return String(feature.id);
  const props = feature.properties as { ["@id"]?: string } | null;
  const atId = props?.["@id"];
  return typeof atId === "string" ? atId : undefined;
}
