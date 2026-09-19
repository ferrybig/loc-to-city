/** A lat/lon rectangle, half-open like the rest of the format (Section
 * 2.3): `minLat <= lat < maxLat`, `minLon <= lon < maxLon`. */
export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** The lat/lon extent of chunk (c, r) in a W x H grid (Section 6.1). */
export function chunkBoundingBox(c: number, r: number, width: number, height: number): BoundingBox {
  const lonWidth = 360 / width;
  const latHeight = 180 / height;
  const minLon = -180 + c * lonWidth;
  const minLat = -90 + r * latHeight;
  return { minLon, maxLon: minLon + lonWidth, minLat, maxLat: minLat + latHeight };
}

/** The lat/lon extent of cell (cellX, cellY) at the given depth within a
 * chunk (Section 8.1: cell (0, 0) is the chunk's own south-west corner). */
export function cellBoundingBox(chunkBox: BoundingBox, cellX: number, cellY: number, depth: number): BoundingBox {
  const cellsPerSide = 2 ** depth;
  const lonWidth = (chunkBox.maxLon - chunkBox.minLon) / cellsPerSide;
  const latHeight = (chunkBox.maxLat - chunkBox.minLat) / cellsPerSide;
  const minLon = chunkBox.minLon + cellX * lonWidth;
  const minLat = chunkBox.minLat + cellY * latHeight;
  return { minLon, maxLon: minLon + lonWidth, minLat, maxLat: minLat + latHeight };
}

export function boundingBoxContains(box: BoundingBox, lat: number, lon: number): boolean {
  return lat >= box.minLat && lat < box.maxLat && lon >= box.minLon && lon < box.maxLon;
}
