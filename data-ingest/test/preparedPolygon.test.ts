import { test } from "node:test";
import assert from "node:assert/strict";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { preparePolygon } from "../src/lib/preparedPolygon.ts";

// Seeded, so a failure reproduces.
let seed = 7;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

/** A star-shaped ring around (cx, cy) -- simple, but jagged enough to put
 * many edges in one band -- with some coordinates snapped to a coarse grid
 * so there are horizontal and vertical edges and shared y values. */
function ring(cx: number, cy: number, radius: number, vertices: number): Position[] {
  const points: Position[] = [];
  for (let i = 0; i < vertices; i++) {
    const angle = (2 * Math.PI * i) / vertices;
    const r = radius * (0.3 + 0.7 * random());
    let x = cx + r * Math.cos(angle);
    let y = cy + r * Math.sin(angle);
    if (random() < 0.3) {
      x = Math.round(x * 4) / 4;
      y = Math.round(y * 4) / 4;
    }
    points.push([x, y]);
  }
  points.push(points[0]!);
  return points;
}

/** Points worth asking about: random ones over the bbox, every vertex, and
 * points on edges (midpoints, which a horizontal or vertical edge puts on
 * the line exactly). */
function probes(geometry: Polygon | MultiPolygon): Position[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const out: Position[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of polygons) {
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const [x, y] = r[i] as [number, number];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        out.push([x, y]);
        const next = r[i + 1];
        if (next) out.push([(x + next[0]!) / 2, (y + next[1]!) / 2]);
      }
    }
  }
  for (let i = 0; i < 4000; i++) {
    out.push([minX - 1 + random() * (maxX - minX + 2), minY - 1 + random() * (maxY - minY + 2)]);
    // On a grid line, where the snapped vertices are.
    out.push([Math.round((minX + random() * (maxX - minX)) * 4) / 4, Math.round((minY + random() * (maxY - minY)) * 4) / 4]);
  }
  return out;
}

function assertMatchesTurf(geometry: Polygon | MultiPolygon): void {
  const prepared = preparePolygon(geometry);
  let inside = 0;
  for (const [x, y] of probes(geometry) as [number, number][]) {
    const expected = booleanPointInPolygon([x, y], geometry);
    assert.equal(prepared.contains(x, y), expected, `(${x}, ${y})`);
    if (expected) inside++;
  }
  assert.ok(inside > 0);
}

test("preparePolygon: same answers as turf on small and large rings", () => {
  for (const vertices of [4, 10, 63, 64, 300, 5000]) {
    assertMatchesTurf({ type: "Polygon", coordinates: [ring(5, 50, 3, vertices)] });
  }
});

test("preparePolygon: same answers as turf with holes and several parts", () => {
  for (let n = 0; n < 20; n++) {
    const vertices = 20 + Math.floor(random() * 800);
    const geometry: MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [
        [ring(0, 0, 10, vertices), ring(0, 0, 2, 12)],
        [ring(15, 3, 4, vertices / 2)],
        [ring(15.5, 3, 4, 40)], // overlaps the previous part
      ],
    };
    assertMatchesTurf(geometry);
  }
});

test("preparePolygon: a ring that is a horizontal line", () => {
  const geometry: Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [0, 1],
        [4, 1],
        [0, 1],
      ],
    ],
  };
  const prepared = preparePolygon(geometry);
  for (const [x, y] of [
    [2, 1],
    [0, 1],
    [5, 1],
    [2, 1.5],
  ] as [number, number][]) {
    assert.equal(prepared.contains(x, y), booleanPointInPolygon([x, y], geometry));
  }
});
