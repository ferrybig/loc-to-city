import { test } from "node:test";
import assert from "node:assert/strict";
import { DuplicateGeometries, osmUrlFor } from "../src/lib/duplicateGeometries.ts";

test("DuplicateGeometries groups only identical geometry text", () => {
  const duplicates = new DuplicateGeometries<string>();
  const square = '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}';
  // The same outline from another starting vertex: not found, by design.
  const rotated = '{"type":"Polygon","coordinates":[[[1,0],[1,1],[0,0],[1,0]]]}';
  duplicates.add(square, "Alix");
  duplicates.add('{"type":"Polygon","coordinates":[[[5,5],[6,5],[6,6],[5,5]]]}', "Bentley");
  duplicates.add(square, "Village of Alix");
  duplicates.add(rotated, "Rotated");
  assert.deepEqual(duplicates.groups(), [["Alix", "Village of Alix"]]);
});

test("osmUrlFor maps osmium area ids to the relation or way", () => {
  // a12996131 is "Village of Alix", relation 6498065 (checked with osmium getid).
  assert.equal(osmUrlFor("a12996131"), "https://www.openstreetmap.org/relation/6498065");
  assert.equal(osmUrlFor("a12996130"), "https://www.openstreetmap.org/way/6498065");
  assert.equal(osmUrlFor("voronoi:LY.Tripoli"), undefined);
  assert.equal(osmUrlFor("region-city:a62422"), undefined);
});
