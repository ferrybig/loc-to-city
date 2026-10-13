import { test } from "node:test";
import assert from "node:assert/strict";
import intersect from "@turf/intersect";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { cropForClip } from "../src/lib/cropForClip.ts";

let seed = 11;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function clip(cell: Position[], container: Polygon | MultiPolygon): Polygon | MultiPolygon | null {
  const feature: Feature<Polygon | MultiPolygon> = { type: "Feature", properties: {}, geometry: container };
  const result = intersect(featureCollection([turfPolygon([cell]), feature as Feature<Polygon>]));
  return result ? result.geometry : null;
}

function box(minX: number, minY: number, maxX: number, maxY: number): Position[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ];
}

/** A jagged ring around (cx, cy), counterclockwise. */
function blob(cx: number, cy: number, radius: number, vertices: number): Position[] {
  const ring: Position[] = [];
  for (let i = 0; i < vertices; i++) {
    const angle = (2 * Math.PI * i) / vertices;
    const r = radius * (0.6 + 0.4 * random());
    ring.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** A thick spiral arm: a ring that winds round (0, 0) `turns` times on its
 * way out and back, without crossing itself -- every stretch of it far from
 * a cell near the centre has to be replaced by a path that turns the same
 * way, or the cell's winding number changes. */
function spiral(turns: number, steps: number): Position[] {
  const out: Position[] = [];
  const back: Position[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (turns * 2 * Math.PI * i) / steps;
    const r = 1 + t / Math.PI;
    out.push([r * Math.cos(t), r * Math.sin(t)]);
    back.push([(r + 0.8) * Math.cos(t), (r + 0.8) * Math.sin(t)]);
  }
  const ring = [...out, ...back.reverse()];
  ring.push(ring[0]!);
  return ring;
}

/** Random cells over a region, some inside, some across the boundary. */
function cells(minX: number, minY: number, maxX: number, maxY: number, count: number): Position[][] {
  const result: Position[][] = [];
  for (let i = 0; i < count; i++) {
    const x = minX + random() * (maxX - minX);
    const y = minY + random() * (maxY - minY);
    const size = 0.05 + random() * 0.6;
    result.push(random() < 0.5 ? box(x, y, x + size, y + size * 0.7) : blob(x, y, size, 7));
  }
  return result;
}

function assertSameClip(container: Polygon | MultiPolygon, testCells: Position[][]): void {
  let nonEmpty = 0;
  for (const cell of testCells) {
    const xs = cell.map((p) => p[0]!);
    const ys = cell.map((p) => p[1]!);
    const [minX, minY, maxX, maxY] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const cropped = cropForClip(container, [minX, minY, maxX, maxY]);
    const expected = clip(cell, container);
    const actual = cropped ? clip(cell, cropped) : null;
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), JSON.stringify(cell));
    if (expected) nonEmpty++;
  }
  assert.ok(nonEmpty > 0);
}

test("cropForClip: the same intersection as the whole container, for a big jagged ring", () => {
  const container: Polygon = { type: "Polygon", coordinates: [blob(0, 0, 10, 600)] };
  assertSameClip(container, cells(-11, -11, 11, 11, 60));
});

test("cropForClip: the same intersection with holes and far-away parts", () => {
  const container: MultiPolygon = {
    type: "MultiPolygon",
    coordinates: [
      [blob(0, 0, 10, 500), blob(0, 0, 3, 200), blob(6, 0, 1, 80)],
      [blob(30, 0, 5, 300)],
      [blob(0, 30, 2, 50)],
    ],
  };
  assertSameClip(container, cells(-11, -11, 36, 11, 80));
});

test("cropForClip: a ring winding round the cell keeps the cell's winding number", () => {
  for (const turns of [1, 2, 3]) {
    const container: Polygon = { type: "Polygon", coordinates: [spiral(turns, 150 * turns)] };
    const extent = 2 + 2 * turns;
    assertSameClip(container, cells(-extent, -extent, extent, extent, 60));
  }
});

test("cropForClip: a container nowhere near the cell", () => {
  const container: Polygon = { type: "Polygon", coordinates: [blob(50, 50, 2, 100)] };
  assert.equal(cropForClip(container, [0, 0, 1, 1]), null);
});

test("cropForClip: a cell inside a ring that encloses it from far away", () => {
  // No edge comes near: the container is replaced by a frame around the cell.
  const container: Polygon = { type: "Polygon", coordinates: [blob(0, 0, 40, 2000)] };
  const cell = box(0, 0, 0.5, 0.5);
  const cropped = cropForClip(container, [0, 0, 0.5, 0.5])!;
  assert.equal(cropped.coordinates[0]![0]!.length, 5);
  assert.equal(JSON.stringify(clip(cell, cropped)), JSON.stringify(clip(cell, container)));
});
