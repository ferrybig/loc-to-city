#!/usr/bin/env python3
"""Load a compact grid index (data/nl_grid*.bin) and answer point queries
with a single binary search for the common case -- no polygon math, no
pointer chasing.

On-disk format (v3, "LG03"): records are stored pre-sorted by code as three
columnar streams -- delta-varint-encoded codes, 1-byte depths, 2-byte
payloads -- concatenated and zlib-compressed as one blob. Decompressing and
decoding the varints happens once here, at load time; every query after
that is a plain `bisect` over an in-memory array. See build_grid_index.py
and the README's "Compact on-disk format" section for why (delta-varint
alone shrinks the code stream ~8x before compression even starts, because
sorted Morton codes are mostly small deltas -- cut nl_grid.bin from 7.4MB
to ~500KB in testing).

Two flavors of grid file exist, both built by build_grid_index.py and both
loaded by this same class:
  - data/nl_grid.bin (BOUNDARY_FILL=sentinel, approach C): ambiguous cells
    are marked BOUNDARY and resolved at query time via `polygon_fallback`
    (approach B), exactly.
  - data/nl_grid_d_random.bin / _nearest.bin / _coverage.bin (approach D):
    ambiguous cells already have a real (possibly wrong) city id baked in
    at build time -- no BOUNDARY records exist in these files, so no
    fallback is needed at query time at all.
"""
import bisect
import struct
import sys
import zlib
from array import array
from pathlib import Path

GRID_PATH = Path("data/nl_grid.bin")
NO_CITY = (1 << 15) - 1
BOUNDARY = (1 << 15) - 2


def varint_decode_stream(buf):
    """Decode a run of varints back into cumulative (delta-decoded) values."""
    out = []
    pos = 0
    n = len(buf)
    prev = 0
    while pos < n:
        shift = 0
        val = 0
        while True:
            b = buf[pos]
            pos += 1
            val |= (b & 0x7F) << shift
            if not (b & 0x80):
                break
            shift += 7
        prev += val
        out.append(prev)
    return out


class GridIndex:
    def __init__(self, path=GRID_PATH, polygon_fallback=None):
        self.fallback = polygon_fallback
        self.fallback_hits = 0
        data = Path(path).read_bytes()
        magic = data[0:4]
        assert magic == b"LG03", magic
        self.max_depth = data[4]
        n_cities, = struct.unpack_from("<I", data, 5)
        n_records, = struct.unpack_from("<Q", data, 9)
        delta_len, = struct.unpack_from("<Q", data, 17)
        compressed_len, = struct.unpack_from("<Q", data, 25)
        off = 33

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
            country = read_str()
            self.cities.append({
                "id": city_id, "name": name, "municipality": muni,
                "region": region, "country": country,
            })

        self.NO_CITY = NO_CITY
        self.BOUNDARY = BOUNDARY

        compressed = data[off:off + compressed_len]
        blob = zlib.decompress(compressed)
        delta_bytes = blob[:delta_len]
        depth_bytes = blob[delta_len:delta_len + n_records]
        payload_bytes = blob[delta_len + n_records:delta_len + n_records + n_records * 2]

        self.codes = array("Q", varint_decode_stream(delta_bytes))
        self.depths = depth_bytes  # bytes, indexable directly
        self.payloads = array("H")
        self.payloads.frombytes(payload_bytes)

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

    def query(self, lat, lon):
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
