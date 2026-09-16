#!/usr/bin/env python3
"""
Approach A: nearest-point lookup (replicates the existing production system).

The existing DB stores one (lat, lon) point per named place and answers
"what city is this?" with a nearest-neighbor search (GiST index on
ll_to_earth). No polygons involved -- a location is "in" whichever city's
recorded point happens to be geographically closest, which is wrong whenever
the true border runs closer to the query point than the nearest label point.

This script rebuilds that behaviour from existing_data.csv, filtered to NL,
using a 3D unit-sphere KD-tree (great-circle nearest neighbor via chord
distance -- equivalent ordering to ll_to_earth).
"""
import csv
import math
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

CSV_PATH = Path("existing_data.csv")


def to_xyz(lat, lon):
    lat_r, lon_r = math.radians(lat), math.radians(lon)
    return (
        math.cos(lat_r) * math.cos(lon_r),
        math.cos(lat_r) * math.sin(lon_r),
        math.sin(lat_r),
    )


class NearestPointIndex:
    def __init__(self, rows):
        self.rows = rows
        pts = np.array([to_xyz(r["latitude"], r["longitude"]) for r in rows])
        self.tree = cKDTree(pts)

    @classmethod
    def from_nl_csv(cls, path=CSV_PATH):
        rows = []
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                if r["countryCode"] != "NL":
                    continue
                rows.append({
                    "name": r["name"],
                    "latitude": float(r["latitude"]),
                    "longitude": float(r["longitude"]),
                    "region": r["admin1Name"],
                    "municipality": r["admin2Name"],
                })
        return cls(rows)

    def query(self, lat, lon):
        xyz = to_xyz(lat, lon)
        _, idx = self.tree.query(xyz)
        return self.rows[idx]

    def size_bytes(self):
        # 2 doubles (lat,lon) + name/region strings, matching the existing schema's core cost
        return sum(16 + len(r["name"].encode()) + len(str(r["region"]).encode()) for r in self.rows)


if __name__ == "__main__":
    idx = NearestPointIndex.from_nl_csv()
    print(f"Loaded {len(idx.rows)} NL points, approx payload size={idx.size_bytes()/1024:.1f} KiB", file=sys.stderr)

    tests = [
        ("Wormerveer expected", 52.48878991537549, 4.794346918807473),
        ("Den Haag expected", 52.034656091402674, 4.388124124642494),
    ]
    for label, lat, lon in tests:
        r = idx.query(lat, lon)
        print(f"{label}: got {r['name']!r} (region={r['region']}, municipality={r['municipality']})")
