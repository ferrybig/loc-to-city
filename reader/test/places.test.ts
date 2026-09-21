import { test } from "node:test";
import assert from "node:assert/strict";
import { CGeoDataReader, type Place } from "../src/index.js";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

// Appendix A.3's identifier table: 0-1 countries, 2-3 regions, 4-6 cities.
const reader = CGeoDataReader.open(APPENDIX_A_BYTES);

const NL = { id: 0, names: ["Nederland", "The Netherlands"] };
const BE = { id: 1, names: ["België", "Belgium"] };
const NH = { id: 2, names: ["Noord-Holland"] };
const ANT = { id: 3, names: ["Antwerpen", "Antwerp"] };

function ids(places: Iterable<Place>): number[] {
  return [...places].map((p) => p.id);
}

test("placeCounts reflects the place table prefix", () => {
  assert.deepEqual(reader.placeCounts, { countries: 2, regions: 2, cities: 3 });
});

test("place(id) resolves each level with the QueryResult-shaped trio", () => {
  assert.deepEqual(reader.place(0), { id: 0, level: "country", names: NL.names, country: NL, region: null, city: null });
  assert.deepEqual(reader.place(3), { id: 3, level: "region", names: ANT.names, country: BE, region: ANT, city: null });
  assert.deepEqual(reader.place(5), {
    id: 5,
    level: "city",
    names: ["Zaandam"],
    country: NL,
    region: NH,
    city: { id: 5, names: ["Zaandam"] },
  });
  assert.throws(() => reader.place(7), RangeError);
});

test("places() walks in id order and honours level/country/region filters", () => {
  assert.deepEqual(ids(reader.places()), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(reader.places({ level: "country" })), [0, 1]);
  assert.deepEqual(ids(reader.places({ level: "city" })), [4, 5, 6]);
  assert.deepEqual(ids(reader.places({ country: 0 })), [0, 2, 4, 5], "the country itself, its regions, its cities");
  assert.deepEqual(ids(reader.places({ country: 1, level: "city" })), [6]);
  assert.deepEqual(ids(reader.places({ region: 2 })), [0, 2, 4, 5]);
  assert.deepEqual(ids(reader.places({ region: 3, level: "city" })), [6]);
  assert.deepEqual(ids(reader.places({ country: 0, region: 3 })), [], "a region not in that country yields nothing");
  assert.throws(() => [...reader.places({ country: 2 })], /not a country id/);
  assert.throws(() => [...reader.places({ region: 0 })], /not a region id/);
});

test("search() matches any name of any level, case-insensitively, with limit", () => {
  assert.deepEqual(ids(reader.search("antwerp")), [3, 6], "region and city share the name");
  assert.deepEqual(ids(reader.search("NETHER")), [0], "matches an alternative name");
  assert.deepEqual(ids(reader.search("dam")), [4, 5]);
  assert.deepEqual(ids(reader.search("dam", { limit: 1 })), [4]);
  assert.deepEqual(ids(reader.search("dam", { limit: 0 })), []);
  assert.deepEqual(ids(reader.search("antwerp", { level: "city" })), [6]);
  assert.deepEqual(ids(reader.search("e", { country: 1 })), [1, 3, 6]);
  assert.deepEqual(ids(reader.search("e", { region: 3 })), [1, 3, 6], "a region filter still yields its country");
  assert.deepEqual(ids(reader.search("nothing here")), []);
});

test("chunk()/chunkRecords() expose Appendix A.4's records with cells and places resolved", () => {
  assert.equal(reader.chunk(0), undefined, "empty chunk");
  assert.throws(() => reader.chunk(4), RangeError);
  assert.deepEqual(reader.chunkBoundingBox(3), { minLat: 0, maxLat: 90, minLon: 0, maxLon: 180 });

  const records = [...reader.chunkRecords(3)];
  assert.equal(records.length, reader.chunk(3)!.codes.length);
  // Lookup 1 (lat 20, lon 100) lands in the cell that resolves to Zaandam:
  // the same cell query() reports as its bounding box.
  const expected = reader.query(20, 100);
  const zaandam = records.find((r) => r.place?.id === 5);
  assert.ok(zaandam);
  assert.deepEqual(zaandam.boundingBox, expected.boundingBox);
  // Every record's cell lies inside the chunk, and "no place" records exist as null.
  for (const r of records) {
    assert.ok(r.boundingBox.minLat >= 0 && r.boundingBox.maxLat <= 90);
    assert.ok(r.boundingBox.minLon >= 0 && r.boundingBox.maxLon <= 180);
    assert.ok(r.depth <= reader.header.maxDepth);
  }
  assert.deepEqual([...reader.chunkRecords(0)], []);
});
