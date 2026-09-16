#!/usr/bin/env python3
"""
Approach B: exact point-in-polygon lookup against real city (woonplaats)
boundaries, using an STRtree for candidate pruning.

This is the accuracy ground truth: a location resolves to whichever city's
official BAG-sourced polygon actually contains it. We also measure the
storage cost of keeping full-precision vs. simplified geometry, since that
cost is what approach C (the compact grid) is trying to avoid paying at
query time while still avoiding at rest.
"""
import json
import sys
from pathlib import Path

from shapely.geometry import shape, Point
from shapely.strtree import STRtree

CITIES_PATH = Path("data/nl_cities.geojson")


class PolygonIndex:
    def __init__(self, features):
        self.features = features
        self.geoms = [shape(f["geometry"]) for f in features]
        self.tree = STRtree(self.geoms)

    @classmethod
    def load(cls, path=CITIES_PATH):
        data = json.loads(Path(path).read_text())
        return cls(data["features"])

    def query(self, lat, lon):
        pt = Point(lon, lat)
        for i in self.tree.query(pt):
            if self.geoms[i].contains(pt) or self.geoms[i].intersects(pt):
                return self.features[i]["properties"]
        return None

    def simplified_geojson_size(self, tolerance_deg):
        total = 0
        for geom in self.geoms:
            simplified = geom.simplify(tolerance_deg, preserve_topology=True)
            total += len(json.dumps(shape(simplified).__geo_interface__))
        return total


if __name__ == "__main__":
    idx = PolygonIndex.load()
    raw_size = Path(CITIES_PATH).stat().st_size
    print(f"Loaded {len(idx.features)} city polygons, raw GeoJSON size={raw_size/1024/1024:.1f} MiB", file=sys.stderr)

    # 0.0001 deg ~= 11m at NL latitude (worst axis); a reasonable simplify
    # tolerance given our 10m precision requirement.
    for tol_m, tol_deg in [(1, 0.0000090), (5, 0.0000450), (10, 0.0000900)]:
        size = idx.simplified_geojson_size(tol_deg)
        print(f"simplify tolerance ~{tol_m}m -> {size/1024/1024:.2f} MiB (geojson, uncompressed)", file=sys.stderr)

    tests = [
        ("Wormerveer expected", 52.48878991537549, 4.794346918807473),
        ("Den Haag expected", 52.034656091402674, 4.388124124642494),
    ]
    for label, lat, lon in tests:
        r = idx.query(lat, lon)
        print(f"{label}: got {r}")
