import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { streamGeometries } from "../src/lib/adminLevelDetection.ts";
import {
  peekFeatureId,
  peekLeadingProperties,
  splitOsmiumFeature,
  streamGeoJSONSeq,
  streamGeoJSONSeqRecords,
} from "../src/lib/geojsonseqStream.ts";

const dir = mkdtempSync(path.join(tmpdir(), "geojsonseq-"));

function osmiumRecord(id: string, coordinates: number[][][], properties: Record<string, unknown>): string {
  return `{"type":"Feature","id":"${id}","geometry":${JSON.stringify({ type: "Polygon", coordinates })},"properties":${JSON.stringify(properties)}}`;
}

const SQUARE = [
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ],
];

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test("records: split on RS, trimmed, including one far larger than a single read", async () => {
  // ~10MB of coordinates: spans three 4MB reads, so the record is joined
  // from pending chunks rather than found inside one.
  const big = [Array.from({ length: 400_000 }, (_, i) => [i / 1e6, 52.1234567])];
  const records = [
    osmiumRecord("a1", SQUARE, { name: "small" }),
    osmiumRecord("a2", big, { name: "big" }),
    osmiumRecord("a3", SQUARE, { name: "last, no trailing newline" }),
  ];
  const file = path.join(dir, "big.geojsonseq");
  writeFileSync(file, `\x1e${records[0]}\n\x1e${records[1]}\n\n\x1e${records[2]}`);

  const raw = await collect(streamGeoJSONSeqRecords(file));
  assert.deepEqual(
    raw.map((r) => r.toString("utf8")),
    records,
  );
  const parsed = await collect(streamGeoJSONSeq(file));
  assert.deepEqual(
    parsed.map((f) => f.properties?.name),
    ["small", "big", "last, no trailing newline"],
  );
});

test("peekFeatureId: reads osmium's id prefix, and refuses anything else", () => {
  assert.equal(peekFeatureId(Buffer.from(osmiumRecord("a16115300", SQUARE, {}))), "a16115300");
  assert.equal(peekFeatureId(Buffer.from('{"type":"Feature","properties":{"@id":"a1"},"geometry":null}')), undefined);
});

test("splitOsmiumFeature: geometry source text unparsed, properties parsed", () => {
  const properties = { admin_level: "8", name: 'Brackets ]} and "quotes" in a name' };
  const parts = splitOsmiumFeature(Buffer.from(osmiumRecord("a1", SQUARE, properties)));
  assert.ok(parts);
  assert.equal(parts.geometryJson, JSON.stringify({ type: "Polygon", coordinates: SQUARE }));
  assert.deepEqual(parts.properties, properties);

  // Not osmium's key order: refused rather than guessed at.
  assert.equal(
    splitOsmiumFeature(Buffer.from('{"type":"Feature","id":"a1","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}')),
    undefined,
  );
});

test("peekLeadingProperties: prepare-world's properties-first records", () => {
  const properties = { id: "a1", name: 'St. "Odd" {Name}', region: "R", country: "NL" };
  const record = `{"type":"Feature","properties":${JSON.stringify(properties)},"geometry":${JSON.stringify({ type: "Polygon", coordinates: SQUARE })}}`;
  assert.deepEqual(peekLeadingProperties(Buffer.from(record)), properties);
  assert.equal(peekLeadingProperties(Buffer.from('{"type":"Feature","properties":null,"geometry":null}')), undefined);
  assert.equal(peekLeadingProperties(Buffer.from(osmiumRecord("a1", SQUARE, {}))), undefined);
});

test("streamGeometries: only the wanted ids, geometry text as written, first file wins a duplicate", async () => {
  const first = path.join(dir, "a-admin.geojson");
  const second = path.join(dir, "b-admin.geojson");
  const shifted = [SQUARE[0]!.map(([x, y]) => [x! + 10, y!])];
  writeFileSync(first, `\x1e${osmiumRecord("a1", SQUARE, {})}\n\x1e${osmiumRecord("a2", SQUARE, {})}\n`);
  // a1 again (a cross-file duplicate, dropped), plus a record osmium
  // wouldn't write, which still has to be found by parsing it.
  const foreign = `{"type":"Feature","properties":{"@id":"a3"},"geometry":${JSON.stringify({ type: "Polygon", coordinates: shifted })}}`;
  writeFileSync(second, `\x1e${osmiumRecord("a1", shifted, {})}\n\x1e${foreign}\n`);

  const got = await collect(streamGeometries([first, second], new Set(["a1", "a3"])));
  assert.deepEqual(got, [
    { id: "a1", geometryJson: JSON.stringify({ type: "Polygon", coordinates: SQUARE }) },
    { id: "a3", geometryJson: JSON.stringify({ type: "Polygon", coordinates: shifted }) },
  ]);
  assert.deepEqual(await collect(streamGeometries([first, second], new Set())), []);
});
