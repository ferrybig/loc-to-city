import type { MultiPolygon, Polygon } from "geojson";
import type { BBox } from "geojson";
import { preparePolygon } from "./preparedPolygon.ts";
import type { PreparedPolygon } from "./preparedPolygon.ts";

/** How much of a candidate polygon the primaries have covered so far: a
 * grid over its bbox, one byte per cell, 1 where the cell's centre lies in
 * the candidate and no primary has contained it yet. Gap-fill by
 * representative point (`createGapFillTracker`) drops a district as soon
 * as one parish covers its point, which loses a district that is mostly
 * parishes but has an unparished town in it (Norwich, Winchester). A
 * grid says how much of the district is left. Built where the geometry is
 * (Pass 1), so it travels with the candidate's metadata. */
export interface CoverageGrid {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

/** Cells per axis at most: a district 40 km across gets ~300 m cells. */
const MAX_CELLS_PER_AXIS = 128;

export function buildCoverageGrid(geometry: Polygon | MultiPolygon, bbox: BBox): CoverageGrid {
  const [minX, minY, maxX, maxY] = bbox;
  // Squarish cells in degrees of longitude and latitude alike, so a long thin
  // district does not spend 128 cells across its short side.
  const width = maxX - minX;
  const height = maxY - minY;
  const longest = Math.max(width, height);
  const cols = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.ceil((width / longest) * MAX_CELLS_PER_AXIS)));
  const rows = Math.max(1, Math.min(MAX_CELLS_PER_AXIS, Math.ceil((height / longest) * MAX_CELLS_PER_AXIS)));
  const cells = new Uint8Array(cols * rows);
  const polygon = preparePolygon(geometry);
  for (let row = 0; row < rows; row++) {
    const y = minY + ((row + 0.5) * height) / rows;
    for (let col = 0; col < cols; col++) {
      if (polygon.contains(minX + ((col + 0.5) * width) / cols, y)) cells[row * cols + col] = 1;
    }
  }
  return { cols, rows, cells };
}

/** Marks every still-open cell of `grid` (over `bbox`) that `polygon`
 * contains as covered. Only the cells inside `polygonBbox` are tested. */
export function coverGrid(grid: CoverageGrid, bbox: BBox, polygon: PreparedPolygon, polygonBbox: BBox): void {
  const { cols, rows, cells } = grid;
  const [minX, minY, maxX, maxY] = bbox;
  const width = maxX - minX;
  const height = maxY - minY;
  const col0 = Math.max(0, Math.floor(((polygonBbox[0] - minX) / width) * cols));
  const col1 = Math.min(cols - 1, Math.floor(((polygonBbox[2] - minX) / width) * cols));
  const row0 = Math.max(0, Math.floor(((polygonBbox[1] - minY) / height) * rows));
  const row1 = Math.min(rows - 1, Math.floor(((polygonBbox[3] - minY) / height) * rows));
  for (let row = row0; row <= row1; row++) {
    const y = minY + ((row + 0.5) * height) / rows;
    for (let col = col0; col <= col1; col++) {
      const i = row * cols + col;
      if (cells[i] === 1 && polygon.contains(minX + ((col + 0.5) * width) / cols, y)) cells[i] = 0;
    }
  }
}

/** Area (km^2) of the cells no primary has covered. */
export function uncoveredKm2(grid: CoverageGrid, bbox: BBox): number {
  const { cols, rows, cells } = grid;
  let open = 0;
  for (const cell of cells) open += cell;
  const [minX, minY, maxX, maxY] = bbox;
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const cellKm2 =
    (((maxX - minX) / cols) * 111.32 * Math.cos(midLat) * (maxY - minY)) / rows * 110.57;
  return open * cellKm2;
}
