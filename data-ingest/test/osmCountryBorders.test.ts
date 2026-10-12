import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { MultiPolygon, Polygon, Position } from "geojson";
import type { CountryIndex } from "../src/lib/countryIndex.ts";
import { CountryPolygonIndex } from "../src/lib/countryIndex.ts";
import type { LonLat } from "../src/lib/geo.ts";
import {
  loadOsmCountryBorders,
  loadOsmCountryRelations,
  packPolygons,
  withOsmCountryBorders,
} from "../src/lib/osmCountryBorders.ts";

function ring(minX: number, minY: number, maxX: number, maxY: number): Position[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

test("packPolygons: Polygon and MultiPolygon text, holes kept, vertices packed in order", () => {
  const polygon: Polygon = { type: "Polygon", coordinates: [ring(0, 0, 10, 10), ring(4, 4, 6, 6)] };
  const packed = packPolygons(JSON.stringify(polygon));
  assert.ok(packed);
  assert.equal(packed.length, 1);
  assert.deepEqual([...packed[0]!.outer.xy], ring(0, 0, 10, 10).flat());
  assert.deepEqual(
    packed[0]!.holes.map((h) => [...h.xy]),
    [ring(4, 4, 6, 6).flat()],
  );

  const multi: MultiPolygon = {
    type: "MultiPolygon",
    coordinates: [[ring(0, 0, 1, 1)], [ring(5.1234567, -3.5e-7, 6, 1), ring(5.2, 0.1, 5.3, 0.2)]],
  };
  const packedMulti = packPolygons(JSON.stringify(multi));
  assert.ok(packedMulti);
  assert.deepEqual(
    packedMulti.map((p) => [[...p.outer.xy], ...p.holes.map((h) => [...h.xy])]),
    multi.coordinates.map((rings) => rings.map((r) => r.flat())),
  );
});

test("packPolygons: anything but 2D Polygon/MultiPolygon text is refused, not misread", () => {
  assert.equal(packPolygons('{"type":"Polygon","coordinates":[[[0,0,5],[1,0,5],[1,1,5],[0,0,5]]]}'), undefined);
  assert.equal(packPolygons('{"type":"Point","coordinates":[0,0]}'), undefined);
  assert.equal(packPolygons('{"coordinates":[[[0,0],[1,0],[1,1],[0,0]]],"type":"Polygon"}'), undefined);
});

// Natural Earth's picture: A is the box [0,10]x[0,10], B the box east of
// it, C a small island with no OSM border at all, and nothing elsewhere.
function fakeNaturalEarth(): CountryIndex {
  const lookup = ([x, y]: LonLat): string | null => {
    if (y < 0 || y > 10) return null;
    if (x >= 0 && x <= 10) return "AA";
    if (x > 10 && x <= 20) return "BB";
    if (x >= 30 && x <= 31) return "CC";
    return null;
  };
  return { lookup, areaByCode: new Map(), nameByCode: new Map(), simplifiedFeatureByCode: new Map() };
}

// OSM's picture: A has a hole at [2,3]x[2,3] that is an enclave of B, and
// its border with B runs at x=9.5 rather than 10.
function osmBorders(): CountryPolygonIndex {
  const borders = new CountryPolygonIndex();
  const index = (coordinates: Position[][]) =>
    packPolygons(JSON.stringify({ type: "Polygon", coordinates } satisfies Polygon))!;
  borders.add("AA", index([ring(0, 0, 9.5, 10), ring(2, 2, 3, 3)]));
  borders.add("BB", index([ring(9.5, 0, 20, 10)]));
  borders.add("BB", index([ring(2, 2, 3, 3)]));
  return borders;
}

test("withOsmCountryBorders: an enclave Natural Earth doesn't have resolves to its own country", () => {
  const countries = withOsmCountryBorders(fakeNaturalEarth(), osmBorders());
  assert.equal(countries.lookup([2.5, 2.5]), "BB");
  assert.equal(countries.lookup([5, 5]), "AA");
});

test("withOsmCountryBorders: OSM's land border wins where the two disagree", () => {
  const countries = withOsmCountryBorders(fakeNaturalEarth(), osmBorders());
  assert.equal(countries.lookup([9.8, 5]), "BB");
  assert.equal(countries.lookup([10.5, 5]), "BB");
});

test("withOsmCountryBorders: Natural Earth still decides where OSM has nothing to say", () => {
  const countries = withOsmCountryBorders(fakeNaturalEarth(), osmBorders());
  assert.equal(countries.lookup([30.5, 5]), "CC", "no OSM border for CC at all");
  assert.equal(countries.lookup([50, 5]), null, "at sea per Natural Earth stays at sea");
  const narrower = new CountryPolygonIndex();
  narrower.add("AA", packPolygons(JSON.stringify({ type: "Polygon", coordinates: [ring(0, 0, 5, 10)] }))!);
  assert.equal(
    withOsmCountryBorders(fakeNaturalEarth(), narrower).lookup([7, 5]),
    "AA",
    "outside A's OSM border but inside no other: Natural Earth's answer stands",
  );
});

test("loadOsmCountryBorders: admin_level=2 relations of known codes only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "osm-borders-"));
  const file = path.join(dir, "planet-admin.geojson");
  const record = (id: string, coordinates: Position[][], properties: Record<string, string>) =>
    `\x1e{"type":"Feature","id":"${id}","geometry":${JSON.stringify({ type: "Polygon", coordinates })},"properties":${JSON.stringify(properties)}}\n`;
  writeFileSync(
    file,
    record("a1", [ring(0, 0, 1, 1)], { admin_level: "2", "ISO3166-1:alpha2": "BE", name: "België" }) +
      record("a2", [ring(2, 0, 3, 1)], { admin_level: "2", "ISO3166-1": "nl" }) +
      record("a3", [ring(4, 0, 5, 1)], { admin_level: "2", "ISO3166-1:alpha2": "ZZ" }) +
      record("a4", [ring(6, 0, 7, 1)], { admin_level: "4", "ISO3166-1:alpha2": "BE" }),
  );
  const borders = await loadOsmCountryBorders([file], new Set(["BE", "NL"]));
  assert.deepEqual([...borders.codes].sort(), ["BE", "NL"]);
  assert.equal(borders.first(0.5, 0.5), "BE");
  assert.equal(borders.first(2.5, 0.5), "NL");
  assert.equal(borders.first(4.5, 0.5), null);
  assert.equal(borders.first(6.5, 0.5), null);
});

test("loadOsmCountryRelations: admin_level=2 outline, else a dependency's lowest-level relation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "osm-outlines-"));
  const file = path.join(dir, "planet-admin.geojson");
  const record = (id: string, coordinates: Position[][], properties: Record<string, string>) =>
    `\x1e{"type":"Feature","id":"${id}","geometry":${JSON.stringify({ type: "Polygon", coordinates })},"properties":${JSON.stringify(properties)}}\n`;
  const administrative = { boundary: "administrative" };
  writeFileSync(
    file,
    record("a1", [ring(0, 0, 9, 9)], { ...administrative, admin_level: "2", "ISO3166-1:alpha2": "CN" }) +
      record("a2", [ring(1, 1, 2, 2)], { ...administrative, admin_level: "4", "ISO3166-1:alpha2": "HK" }) +
      record("a3", [ring(1, 1, 3, 3)], { ...administrative, admin_level: "3", "ISO3166-1:alpha2": "HK" }) +
      record("a4", [ring(5, 5, 6, 6)], { ...administrative, admin_level: "4", "ISO3166-1:alpha2": "CN" }) +
      record("a5", [ring(7, 7, 8, 8)], { ...administrative, "ISO3166-1:alpha2": "EH" }) +
      record("a6", [ring(7, 7, 8, 8)], { boundary: "maritime", admin_level: "3", "ISO3166-1:alpha2": "MO" }),
  );
  const { borders, outlineJsonByCode } = await loadOsmCountryRelations([file], new Set(["CN", "HK", "EH", "MO"]));
  assert.deepEqual([...borders.codes], ["CN"], "only admin_level=2 corrects Natural Earth");
  const outline = (code: string) => outlineJsonByCode.get(code)?.map((json) => JSON.parse(json).coordinates);
  assert.deepEqual(outline("CN"), [[ring(0, 0, 9, 9)]], "a country's own lower-level relation is not its outline");
  assert.deepEqual(outline("HK"), [[ring(1, 1, 3, 3)]], "the lowest admin_level wins");
  assert.deepEqual(outline("EH"), [[ring(7, 7, 8, 8)]], "no admin_level at all still counts");
  assert.equal(outline("MO"), undefined, "not boundary=administrative");
});
