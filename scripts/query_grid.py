#!/usr/bin/env python3
"""Load the compact grid index (data/nl_grid.bin) and answer point queries
with a single binary search for the common case -- no polygon math, no
pointer chasing. Falls back to an exact point-in-polygon lookup (approach B)
for the minority of queries landing in a cell that was still ambiguous at
the grid's cap depth."""
import bisect
import hashlib
import struct
import sys
from array import array
from pathlib import Path

import numpy as np

GRID_PATH = Path("data/nl_grid.bin")
NO_CITY = (1 << 15) - 1
BOUNDARY = (1 << 15) - 2


class GridIndex:
    def __init__(self, path=GRID_PATH, polygon_fallback=None):
        self.fallback = polygon_fallback
        self.fallback_hits = 0
        data = Path(path).read_bytes()
        magic = data[0:4]
        assert magic == b"LG01", magic
        self.max_depth = data[4]
        n_cities, = struct.unpack_from("<I", data, 5)
        n_records, = struct.unpack_from("<Q", data, 9)
        off = 17

        self.cities = []
        for _ in range(n_cities):
            def read_str():
                nonlocal off
                ln = data[off]
                off += 1
                s = data[off:off + ln].decode()
                off += ln
                return s
            city_id = read_str()
            name = read_str()
            muni = read_str()
            region = read_str()
            self.cities.append({
                "id": city_id, "name": name, "municipality": muni,
                "region": region, "country": "NL",
            })

        raw = np.frombuffer(data, dtype="<u8", count=n_records, offset=off)
        codes = raw >> np.uint64(20)                                  # padded code
        depths = ((raw >> np.uint64(15)) & np.uint64(0x1F)).astype(np.uint8)
        payloads = (raw & np.uint64(0x7FFF)).astype(np.uint32)
        self.NO_CITY = NO_CITY
        self.BOUNDARY = BOUNDARY
        order = np.argsort(codes, kind="stable")
        # numpy's vectorized searchsorted has enormous fixed per-call
        # overhead for a single scalar lookup (built for bulk queries, not
        # one-at-a-time). A plain array.array + stdlib bisect is ~1000x
        # faster here -- this is what an actual point query does.
        self.codes = array("Q", codes[order].tolist())
        self.depths = depths[order]
        self.payloads = payloads[order]

    def _point_code(self, lat, lon):
        n = 1 << self.max_depth
        ix = int((lon + 180.0) / 360.0 * n)
        iy = int((lat + 90.0) / 180.0 * n)
        ix = min(max(ix, 0), n - 1)
        iy = min(max(iy, 0), n - 1)
        code = 0
        for i in range(self.max_depth - 1, -1, -1):
            code = (code << 1) | ((iy >> i) & 1)
            code = (code << 1) | ((ix >> i) & 1)
        return code, ix, iy

    def _random_city_for_cell(self, cell_code):
        """Approach D: instead of falling back to a real point-in-polygon
        lookup, just pick *some* city for an ambiguous cell -- not even a
        real candidate, literally any city in the table. No polygon data
        needed at all, at the cost of being visibly wrong near every
        border. Hashed from the cell's own code (not truly random) so the
        same cell always renders the same color instead of flickering."""
        h = hashlib.md5(str(cell_code).encode()).digest()
        idx = int.from_bytes(h[:4], "big") % len(self.cities)
        return self.cities[idx]

    def query(self, lat, lon, boundary_mode="exact"):
        """boundary_mode: "exact" (approach C, real polygon fallback) or
        "random" (approach D, arbitrary city, no polygon data needed)."""
        q, ix, iy = self._point_code(lat, lon)
        i = bisect.bisect_right(self.codes, q) - 1
        if i < 0:
            return None
        depth = int(self.depths[i])
        shift = 2 * (self.max_depth - depth)
        # top (2*max_depth - shift) bits of q must match this record's path
        if (q >> shift) != (self.codes[i] >> shift):
            return None
        payload = int(self.payloads[i])
        if payload == self.NO_CITY:
            return None
        if payload == self.BOUNDARY:
            self.fallback_hits += 1
            if boundary_mode == "random":
                return self._random_city_for_cell(self.codes[i])
            if self.fallback is None:
                raise RuntimeError("point falls in a boundary cell but no polygon_fallback was provided")
            return self.fallback.query(lat, lon)
        return self.cities[payload]


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    from approach_b_polygon import PolygonIndex

    idx = GridIndex(polygon_fallback=PolygonIndex.load())
    print(f"Loaded grid: max_depth={idx.max_depth}, {len(idx.codes)} records, {len(idx.cities)} cities", file=sys.stderr)

    tests = [
        ("Wormerveer expected", 52.48878991537549, 4.794346918807473),
        ("Den Haag expected", 52.034656091402674, 4.388124124642494),
    ]
    for label, lat, lon in tests:
        r = idx.query(lat, lon)
        print(f"{label}: got {r}")
