import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import bbox from "@turf/bbox";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { loadCountryIndex } from "../src/lib/countryIndex.js";
import type { LonLat } from "../src/lib/geo.js";
import { resolvePolygonCountry } from "../src/lib/polygonCountry.js";

// A two-country world in Natural Earth's shape: WEST covers lon [0, 10),
// EAST covers lon [10, 20), both lat [0, 10]. Everything else is "sea".
function box(minX: number, minY: number, maxX: number, maxY: number): Feature<Polygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    },
  };
}

const world: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { ...box(0, 0, 10, 10), properties: { ISO_A2_EH: "WE", NAME: "West", POP_EST: 1 } },
    { ...box(10, 0, 20, 10), properties: { ISO_A2_EH: "EA", NAME: "East", POP_EST: 1 } },
  ],
};
const nePath = path.join(mkdtempSync(path.join(tmpdir(), "polygon-country-")), "ne.geojson");
writeFileSync(nePath, JSON.stringify(world));
const countries = loadCountryIndex(nePath);

function resolve(feature: Feature<Polygon | MultiPolygon>, repPoint: LonLat, alwaysSample = false): string | null {
  return resolvePolygonCountry(feature, bbox(feature), repPoint, countries, { alwaysSample });
}

test("countryIndex: the banded ray cast agrees with the plain one on a large ring", () => {
  // A ring with enough vertices to be banded (a jagged circle), vs the same
  // shape as a plain polygon that isn't. Both must classify every probe
  // identically, or the band bookkeeping is off by an edge somewhere.
  const ring: [number, number][] = [];
  for (let i = 0; i < 2000; i++) {
    const a = (i / 2000) * 2 * Math.PI;
    const r = 4 + (i % 2) * 0.5;
    ring.push([5 + r * Math.cos(a), 5 + r * Math.sin(a)]);
  }
  ring.push(ring[0]!);
  const jagged: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { ISO_A2_EH: "JG", NAME: "Jagged", POP_EST: 1 }, geometry: { type: "Polygon", coordinates: [ring] } },
    ],
  };
  const jaggedPath = path.join(path.dirname(nePath), "jagged.geojson");
  writeFileSync(jaggedPath, JSON.stringify(jagged));
  const banded = loadCountryIndex(jaggedPath);

  // Reference: even-odd over every edge, no bands.
  const plain = (x: number, y: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let checked = 0;
  for (let x = 0; x <= 10; x += 0.037) {
    for (let y = 0; y <= 10; y += 0.041) {
      assert.equal(banded.lookup([x, y]) === "JG", plain(x, y), `disagree at ${x},${y}`);
      checked++;
    }
  }
  assert.ok(checked > 50_000);
});

test("fast path: an inland polygon whose corners all agree is placed by its representative point", () => {
  const inland = box(2, 2, 4, 4);
  assert.equal(resolve(inland, [3, 3]), "WE");
});

test("fast path: sea corners don't disqualify a coastal polygon", () => {
  // Hangs off the south coast; two bbox corners are in the sea.
  const coastal = box(2, -1, 4, 2);
  assert.equal(resolve(coastal, [3, 1]), "WE");
});

test("border polygon: a representative point on the wrong side is outvoted by the interior", () => {
  // 80% in WEST, 20% in EAST -- but the representative point sits in the
  // EAST sliver, the way a nearest-vertex fallback lands on a border.
  const straddling = box(2, 2, 12, 4);
  assert.equal(resolve(straddling, [11, 3]), "WE");
  assert.equal(resolve(straddling, [11, 3], true), "WE");
});

test("polygon with a sea midpoint (territorial waters) resolves by the land it does cover", () => {
  // A crescent-ish shape: two land lobes joined by a strip out at sea, so
  // the bbox midpoint is in the water. This is the Scotland/Alaska case.
  const crescent: Feature<MultiPolygon> = {
    type: "Feature",
    properties: {},
    geometry: {
      type: "MultiPolygon",
      coordinates: [box(1, 8, 3, 10).geometry.coordinates, box(7, 8, 9, 10).geometry.coordinates, box(1, 14, 9, 14.5).geometry.coordinates],
    },
  };
  // Old behaviour: the bbox midpoint (5, 11.25) is in no country at all.
  assert.equal(countries.lookup([5, 11.25]), null);
  assert.equal(resolve(crescent, [5, 11.25], true), "WE");
  assert.equal(resolve(crescent, [5, 11.25]), "WE");
});

test("a polygon entirely at sea resolves to nothing rather than to a neighbour", () => {
  const island = box(30, 30, 31, 31);
  assert.equal(resolve(island, [30.5, 30.5]), null);
  assert.equal(resolve(island, [30.5, 30.5], true), null);
});

test("a polygon thinner than the sample grid falls back to its representative point", () => {
  // A hair-thin sliver: no grid sample can land inside it.
  const sliver = box(5, 5, 5.0001, 9);
  assert.equal(resolve(sliver, [5.00005, 7], true), "WE");
});
