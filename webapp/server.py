#!/usr/bin/env python3
"""
Tiny stdlib-only web server for the loc-to-city demo: serves the Leaflet
page and a JSON API that runs all three lookup approaches for a clicked
point.

    python3 webapp/server.py [port]

Loads all three indexes once at startup (a few seconds), then answers
queries against in-memory data -- no per-request rebuilding.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import os
os.chdir(REPO_ROOT)  # every approach module resolves its data paths relative to the repo root

from approach_a_nearest_point import NearestPointIndex
from approach_b_polygon import PolygonIndex
from query_grid import GridIndex

STATIC_DIR = Path(__file__).resolve().parent


def place_to_json(p):
    if p is None:
        return None
    return {
        "id": p.get("id"),
        "name": p.get("name"),
        "municipality": p.get("municipality"),
        "region": p.get("region"),
        "country": p.get("country"),
    }


class Indexes:
    def __init__(self):
        print("Loading approach A (nearest point)...", file=sys.stderr)
        self.a = NearestPointIndex.from_nl_csv()
        print("Loading approach B (exact polygon)...", file=sys.stderr)
        self.b = PolygonIndex.load()
        print("Loading approach C (adaptive grid)...", file=sys.stderr)
        self.c = GridIndex(polygon_fallback=self.b)
        print("All indexes loaded.", file=sys.stderr)

    def query_all(self, lat, lon):
        t0 = time.perf_counter()
        ra = self.a.query(lat, lon)
        t1 = time.perf_counter()
        rb = self.b.query(lat, lon)
        t2 = time.perf_counter()
        hits_before = self.c.fallback_hits
        rc = self.c.query(lat, lon)
        t3 = time.perf_counter()
        fallback_used = self.c.fallback_hits > hits_before

        return {
            "a": place_to_json(ra),
            "b": place_to_json(rb),
            "c": place_to_json(rc),
            "a_time_us": (t1 - t0) * 1e6,
            "b_time_us": (t2 - t1) * 1e6,
            "c_time_us": (t3 - t2) * 1e6,
            "c_fallback": fallback_used,
        }


INDEXES = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep stdout quiet; errors still raise

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, content_type):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/index.html":
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return

        if parsed.path == "/api/query":
            qs = parse_qs(parsed.query)
            try:
                lat = float(qs["lat"][0])
                lon = float(qs["lon"][0])
            except (KeyError, ValueError, IndexError):
                self._send_json({"error": "missing or invalid lat/lon"}, status=400)
                return
            result = INDEXES.query_all(lat, lon)
            self._send_json(result)
            return

        self._send_json({"error": "not found"}, status=404)


def main():
    global INDEXES
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    INDEXES = Indexes()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Serving on http://127.0.0.1:{port}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
