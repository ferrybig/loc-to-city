import assert from "node:assert/strict";
import { test } from "node:test";
import bbox from "@turf/bbox";
import pointOnFeature from "@turf/point-on-feature";
import type { MultiPolygon, Polygon } from "geojson";
import { bboxAndPointOnFeature } from "../src/lib/pointOnFeature.ts";

// The repPoint feeds gap-fill and region assignment, so it has to stay
// exactly what turf's pointOnFeature gave, not merely "a point inside".
const shapes: Record<string, Polygon | MultiPolygon> = {
  "convex (midpoint inside)": {
    type: "Polygon",
    coordinates: [
      [
        [4.1, 52.0],
        [4.9, 52.1],
        [4.7, 52.6],
        [4.2, 52.4],
        [4.1, 52.0],
      ],
    ],
  },
  "C shape (midpoint in the notch)": {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [3, 0],
        [3, 1],
        [1, 1],
        [1, 2],
        [3, 2],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
    ],
  },
  "two islands (midpoint at sea)": {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      [
        [
          [5, 4],
          [6, 4],
          [6, 5.5],
          [5, 5],
          [5, 4],
        ],
      ],
    ],
  },
  "ring with a hole around the midpoint": {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
      [
        [1, 1],
        [3, 1],
        [3, 3.5],
        [1, 3],
        [1, 1],
      ],
    ],
  },
};

for (const [label, geometry] of Object.entries(shapes)) {
  test(`bboxAndPointOnFeature matches turf: ${label}`, () => {
    const feature = { type: "Feature" as const, properties: {}, geometry };
    const { bbox: gotBbox, repPoint } = bboxAndPointOnFeature(geometry);
    assert.deepEqual(gotBbox, bbox(feature));
    assert.deepEqual(repPoint, pointOnFeature(feature).geometry.coordinates);
  });
}
