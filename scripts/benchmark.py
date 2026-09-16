#!/usr/bin/env python3
"""
Compare all three techniques on:
  - accuracy vs. ground truth (exact point-in-polygon, approach B)
  - on-disk size
  - query throughput

Ground truth for "boundary" and "random" samples both come from approach B
(the real polygons), since that's the only approach with no approximation.
"""
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from approach_a_nearest_point import NearestPointIndex
from approach_b_polygon import PolygonIndex
from query_grid import GridIndex


def sample_points(poly_idx, n_random, n_border, seed=42):
    rng = random.Random(seed)
    minx = min(g.bounds[0] for g in poly_idx.geoms)
    miny = min(g.bounds[1] for g in poly_idx.geoms)
    maxx = max(g.bounds[2] for g in poly_idx.geoms)
    maxy = max(g.bounds[3] for g in poly_idx.geoms)

    random_pts = []
    while len(random_pts) < n_random:
        lon = rng.uniform(minx, maxx)
        lat = rng.uniform(miny, maxy)
        if poly_idx.query(lat, lon) is not None:
            random_pts.append((lat, lon))

    # border-hugging points: pick a random city, jitter a point on its boundary
    # by ~1-8m either side (the regime where nearest-point and floor-resolved
    # grid approximations are most likely to disagree with ground truth)
    border_pts = []
    feats = poly_idx.features
    geoms = poly_idx.geoms
    attempts = 0
    while len(border_pts) < n_border and attempts < n_border * 50:
        attempts += 1
        i = rng.randrange(len(geoms))
        boundary = geoms[i].boundary
        if boundary.length == 0:
            continue
        d = rng.uniform(0, boundary.length)
        pt = boundary.interpolate(d)
        jitter_deg = rng.uniform(-7, 7) * 1e-6  # ~ +/-0.7m in degrees lat, small
        lat, lon = pt.y + jitter_deg, pt.x + jitter_deg
        if poly_idx.query(lat, lon) is not None:
            border_pts.append((lat, lon))

    return random_pts, border_pts


def eval_accuracy(label, points, poly_idx, other_idx, query_fn):
    agree = 0
    for lat, lon in points:
        truth = poly_idx.query(lat, lon)
        got = query_fn(other_idx, lat, lon)
        truth_name = truth["name"] if truth else None
        got_name = got["name"] if got else None
        if truth_name == got_name:
            agree += 1
    print(f"  {label}: {agree}/{len(points)} agree with ground truth ({100*agree/len(points):.1f}%)")


def bench_speed(label, points, fn):
    t0 = time.perf_counter()
    for lat, lon in points:
        fn(lat, lon)
    dt = time.perf_counter() - t0
    print(f"  {label}: {len(points)} queries in {dt*1000:.1f}ms -> {dt/len(points)*1e6:.1f}us/query")


def main():
    print("Loading indexes...", file=sys.stderr)
    a = NearestPointIndex.from_nl_csv()
    b = PolygonIndex.load()
    try:
        c = GridIndex(polygon_fallback=b)
        have_c = True
    except FileNotFoundError:
        have_c = False
        print("(grid index not built yet, skipping approach C)", file=sys.stderr)

    print("\n=== On-disk size ===")
    print(f"  A (nearest-point, existing-style):          {a.size_bytes()/1024:.1f} KiB")
    print(f"  B (full-precision polygons, geojson):        {Path('data/nl_cities.geojson').stat().st_size/1024/1024:.2f} MiB")
    if have_c:
        grid_size = Path('data/nl_grid.bin').stat().st_size
        print(f"  C (adaptive Morton grid, binary):            {grid_size/1024/1024:.2f} MiB")
        print(f"    + fallback polygons needed for boundary cells (reuses B's {Path('data/nl_cities.geojson').stat().st_size/1024/1024:.2f} MiB, or a simplified subset)")
    print(f"  (existing production system, worldwide):     112 MiB")

    print("\nSampling test points...", file=sys.stderr)
    random_pts, border_pts = sample_points(b, n_random=300, n_border=300)

    print(f"\n=== Accuracy: random interior points (n={len(random_pts)}) ===")
    eval_accuracy("A nearest-point", random_pts, b, a, lambda idx, lat, lon: idx.query(lat, lon))
    if have_c:
        c.fallback_hits = 0
        eval_accuracy("C adaptive grid ", random_pts, b, c, lambda idx, lat, lon: idx.query(lat, lon))
        print(f"    (grid needed exact fallback for {c.fallback_hits}/{len(random_pts)} of these)")

    print(f"\n=== Accuracy: points within ~1m of a city border (n={len(border_pts)}) ===")
    eval_accuracy("A nearest-point", border_pts, b, a, lambda idx, lat, lon: idx.query(lat, lon))
    if have_c:
        c.fallback_hits = 0
        eval_accuracy("C adaptive grid ", border_pts, b, c, lambda idx, lat, lon: idx.query(lat, lon))
        print(f"    (grid needed exact fallback for {c.fallback_hits}/{len(border_pts)} of these)")

    all_pts = random_pts + border_pts
    print(f"\n=== Query throughput: realistic mix, mostly interior (n={len(random_pts)}) ===")
    bench_speed("A nearest-point", random_pts, a.query)
    bench_speed("B exact polygon ", random_pts, b.query)
    if have_c:
        bench_speed("C adaptive grid ", random_pts, c.query)

    print(f"\n=== Query throughput: adversarial, all within ~1m of a border (n={len(border_pts)}) ===")
    bench_speed("A nearest-point", border_pts, a.query)
    bench_speed("B exact polygon ", border_pts, b.query)
    if have_c:
        bench_speed("C adaptive grid ", border_pts, c.query)

    print(f"\n=== Sample resolutions ===")
    for label, lat, lon in [
        ("Wormerveer expected", 52.48878991537549, 4.794346918807473),
        ("Den Haag expected", 52.034656091402674, 4.388124124642494),
    ]:
        ra = a.query(lat, lon)
        rb = b.query(lat, lon)
        rc = c.query(lat, lon) if have_c else None
        print(f"  {label}:")
        print(f"    A nearest-point -> {ra['name']}")
        print(f"    B exact polygon -> {rb['name'] if rb else None}")
        if have_c:
            print(f"    C adaptive grid -> {rc['name'] if rc else None}")


if __name__ == "__main__":
    main()
