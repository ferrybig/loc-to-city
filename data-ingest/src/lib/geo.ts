/** GeoJSON's `Position` is typed as plain `number[]`, which destructures
 * as `number | undefined` under this repo's `noUncheckedIndexedAccess` --
 * a real 2D point is always exactly `[lon, lat]`, so every representative
 * point in this pipeline is carried as this tuple instead. */
export type LonLat = [number, number];
