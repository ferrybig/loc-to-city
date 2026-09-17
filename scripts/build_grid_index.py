#!/usr/bin/env python3
"""
Approach C: adaptive Morton/Z-order quadtree grid, flattened to a single
sorted array of fixed-width records -- no pointer chasing, one binary search
per query for the common case.

Grid: world-aligned, lon in [-180,180), lat in [-90,90), split into a
2^MAX_DEPTH x 2^MAX_DEPTH grid.

Each record packs into one uint64:
  bits [63:20]  Morton code (2*MAX_DEPTH bits, zero-padded to full width --
                see make_record()), directly comparable across depths
  bits [19:15]  5-bit depth of the cell this record represents
  bits [14:0]   15-bit payload: index into the city table, NO_CITY, or
                BOUNDARY

Build: recursive subdivision starting from depth-8 seed cells covering the
Netherlands' bounding box (so we never touch cells outside it). A cell stops
recursing as soon as it's fully "uniform" (no city polygon touches it, or
exactly one fully contains it) -- most of NL's land area resolves this way
within a handful of levels. Otherwise it splits into 4 children.

First attempt (see git history / data/nl_grid_d22_naive_reference.bin) pushed
every ambiguous cell all the way to a 10m floor and classified it by
center-point sampling. That turned out to scale badly: Dutch woonplaats
boundaries are not simple curves -- they follow canals, have enclaves and
many small neighbouring localities -- so "ambiguous" cells are common well
below 1km, and forcing every one of them down to 10m produced 17.7M leaf
records (135MB, *larger* than the 112MB budget we're trying to beat).

This version instead caps recursion at a much shallower MAX_DEPTH and marks
any cell that's still ambiguous at the cap as BOUNDARY. A BOUNDARY leaf
carries no geometry at all -- at query time the caller falls back to an
exact point-in-polygon lookup (approach B) only for the minority of queries
that land in one. This gives *exact* (not 10m-quantized) results for
boundary queries, a tiny flat file for the common case, and no need to
tune MAX_DEPTH against the precision requirement at all -- it only trades
off file size against how often the (still-correct) slow path is taken.

GRID_BOUNDARY_FILL controls how an ambiguous cap-depth cell is resolved:
  sentinel (default) -- store BOUNDARY, defer to a real polygon lookup at
                         query time (approach C). Needs the fallback
                         polygon dataset shipped alongside the grid.
  random             -- pick uniformly at random *among the candidates
                         that actually touch this cell* (`cand`, not the
                         whole city table) and bake that city id into the
                         record at build time. Approach D: self-contained,
                         no polygon data needed at query time at all, at
                         the cost of being wrong in a border-width band.
  nearest            -- like `random` but deterministic: pick whichever
                         candidate's polygon is closest to the cell
                         center (same idea as approach A, just scoped to
                         real local candidates instead of the whole
                         country).
Both `random` and `nearest` write to a different output file so they never
clobber the sentinel/approach-C build.
"""
import json
import random
import struct
import sys
import time
from pathlib import Path

from shapely.geometry import shape, box
from shapely.strtree import STRtree
from shapely.prepared import prep

CITIES_PATH = Path("data/nl_cities.geojson")

import os
MAX_DEPTH = int(os.environ.get("GRID_MAX_DEPTH", "18"))
BOUNDARY_FILL = os.environ.get("GRID_BOUNDARY_FILL", "sentinel")
assert BOUNDARY_FILL in ("sentinel", "random", "nearest"), BOUNDARY_FILL
OUT_PATH = Path("data/nl_grid.bin") if BOUNDARY_FILL == "sentinel" else Path(f"data/nl_grid_d_{BOUNDARY_FILL}.bin")

NO_CITY = (1 << 15) - 1    # 32767, reserved sentinel: confirmed outside any city
BOUNDARY = (1 << 15) - 2   # 32766, reserved sentinel: ambiguous at cap depth, needs exact fallback

random.seed(42)  # reproducible builds


def interleave(ix, iy, bits):
    """Interleave the low `bits` bits of ix and iy: iy is the odd bits, ix the even bits."""
    code = 0
    for i in range(bits - 1, -1, -1):
        code = (code << 1) | ((iy >> i) & 1)
        code = (code << 1) | ((ix >> i) & 1)
    return code


def make_record(ix, iy, depth, payload):
    """Zero-pad the cell's path to full width: this makes the stored code
    equal the *smallest* full-precision code any point inside the cell can
    have, so `stored_code <= Q` holds for every point actually in the cell.
    Combined with a complete (gapless) quadtree partition, that's sufficient
    for `bisect_right(Q) - 1` to always land on the containing cell -- no S2
    sentinel-bit trick needed. (An earlier version padded with a 1-bit at
    the cell's midpoint instead of zeros, which broke this invariant for
    every point in the first half of a cell -- see git history.)
    """
    path_bits = interleave(ix, iy, depth)  # 2*depth bits
    shift = 2 * (MAX_DEPTH - depth)
    code = path_bits << shift
    return (code << 20) | (depth << 15) | payload


def cell_bounds(ix, iy, depth):
    n = 1 << depth
    lon0 = -180.0 + ix * 360.0 / n
    lon1 = -180.0 + (ix + 1) * 360.0 / n
    lat0 = -90.0 + iy * 180.0 / n
    lat1 = -90.0 + (iy + 1) * 180.0 / n
    return lon0, lat0, lon1, lat1


def main():
    t0 = time.time()
    data = json.loads(CITIES_PATH.read_text())
    features = data["features"]
    geoms = [shape(f["geometry"]) for f in features]
    prepared = [prep(g) for g in geoms]
    tree = STRtree(geoms)
    print(f"Loaded {len(geoms)} city polygons", file=sys.stderr)
    print(f"MAX_DEPTH={MAX_DEPTH} BOUNDARY_FILL={BOUNDARY_FILL} -> {OUT_PATH}", file=sys.stderr)

    # NL bounding box, padded slightly
    minx = min(g.bounds[0] for g in geoms) - 0.01
    miny = min(g.bounds[1] for g in geoms) - 0.01
    maxx = max(g.bounds[2] for g in geoms) + 0.01
    maxy = max(g.bounds[3] for g in geoms) + 0.01
    print(f"NL bbox: {minx:.3f},{miny:.3f} .. {maxx:.3f},{maxy:.3f}", file=sys.stderr)

    SEED_DEPTH = 8
    n_seed = 1 << SEED_DEPTH
    ix0 = int((minx + 180.0) / 360.0 * n_seed)
    ix1 = int((maxx + 180.0) / 360.0 * n_seed)
    iy0 = int((miny + 90.0) / 180.0 * n_seed)
    iy1 = int((maxy + 90.0) / 180.0 * n_seed)
    seeds = [(ix, iy) for ix in range(ix0, ix1 + 1) for iy in range(iy0, iy1 + 1)]
    print(f"{len(seeds)} seed cells at depth {SEED_DEPTH}", file=sys.stderr)

    records = []
    stats = {"uniform_city": 0, "uniform_empty": 0, "boundary": 0, "nodes_visited": 0}

    def resolve_ambiguous_cell(cellbox, cand):
        if BOUNDARY_FILL == "random":
            return random.choice(cand)
        # "nearest": deterministic, closest candidate to the cell center
        center = cellbox.centroid
        return min(cand, key=lambda i: geoms[i].distance(center))

    def recurse(ix, iy, depth):
        stats["nodes_visited"] += 1
        lon0, lat0, lon1, lat1 = cell_bounds(ix, iy, depth)
        cellbox = box(lon0, lat0, lon1, lat1)
        cand = [int(i) for i in tree.query(cellbox) if geoms[i].intersects(cellbox)]

        if not cand:
            records.append(make_record(ix, iy, depth, NO_CITY))
            stats["uniform_empty"] += 1
            return

        fully_containing = [i for i in cand if prepared[i].contains(cellbox)]
        if len(fully_containing) >= 1:
            records.append(make_record(ix, iy, depth, fully_containing[0]))
            stats["uniform_city"] += 1
            return

        if depth == MAX_DEPTH:
            if BOUNDARY_FILL == "sentinel":
                records.append(make_record(ix, iy, depth, BOUNDARY))
            else:
                records.append(make_record(ix, iy, depth, resolve_ambiguous_cell(cellbox, cand)))
            stats["boundary"] += 1
            return

        for cix, ciy in ((2 * ix, 2 * iy), (2 * ix + 1, 2 * iy), (2 * ix, 2 * iy + 1), (2 * ix + 1, 2 * iy + 1)):
            recurse(cix, ciy, depth + 1)

    for i, (ix, iy) in enumerate(seeds):
        recurse(ix, iy, SEED_DEPTH)
        if (i + 1) % 4 == 0 or i + 1 == len(seeds):
            elapsed = time.time() - t0
            print(f"  seed {i+1}/{len(seeds)} done, {len(records)} leaves so far, {elapsed:.1f}s elapsed", file=sys.stderr)

    records.sort()
    print(f"Built {len(records)} leaf records in {time.time()-t0:.1f}s", file=sys.stderr)
    print(f"stats: {stats}", file=sys.stderr)

    # ---- write binary file ----
    # header: magic(4s) max_depth(B) n_cities(I) n_records(Q)
    with open(OUT_PATH, "wb") as f:
        f.write(b"LG01")
        f.write(struct.pack("<B", MAX_DEPTH))
        f.write(struct.pack("<I", len(features)))
        f.write(struct.pack("<Q", len(records)))
        for f_ in features:
            p = f_["properties"]
            name = (p["id"] or "").encode()
            city = (p["name"] or "").encode()
            muni = (p["municipality"] or "").encode()
            region = (p["region"] or "").encode()
            f.write(struct.pack("<B", len(name)) + name)
            f.write(struct.pack("<B", len(city)) + city)
            f.write(struct.pack("<B", len(muni)) + muni)
            f.write(struct.pack("<B", len(region)) + region)
        f.write(struct.pack(f"<{len(records)}Q", *records))

    size = OUT_PATH.stat().st_size
    print(f"Wrote {OUT_PATH} ({size/1024/1024:.2f} MiB, {size} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
