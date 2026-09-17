"""Render a single Leaflet XYZ tile as a PNG: query one of the four
approaches for the (sub-sampled) grid of pixel centers in the tile, and
color each cell by a hash of the resolved city's id.

`resolution` is the pixel block size sampled at -- one query per block,
the whole block filled with that color (rendered small then upscaled with
nearest-neighbor, since a per-pixel query would mean up to 65536 lookups
for one 256x256 tile). Lower resolution = fewer queries = faster tiles,
but coarser/blockier borders. This is also a nice side effect: it makes
the underlying cell structure of approach C/D visible on the map.
"""
import io
import math

from PIL import Image

from colors import city_to_rgb

TILE_SIZE = 256
TRANSPARENT = (0, 0, 0, 0)


def tile_pixel_to_lonlat(z, x, y, px, py, tile_size=TILE_SIZE):
    n = 2 ** z
    lon = (x + px / tile_size) / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + py / tile_size) / n)))
    lat = math.degrees(lat_rad)
    return lat, lon


def city_color_id(result):
    """A stable-ish key to color by. Approach A's rows (from the geonames
    CSV) don't carry the same 'id' the OSM-derived approaches do, so fall
    back to name+region -- good enough for a color key."""
    if result is None:
        return None
    cid = result.get("id")
    if cid:
        return cid
    return f"{result.get('name')}|{result.get('region')}"


def query_for_method(indexes, method, lat, lon):
    if method == "a":
        return indexes.a.query(lat, lon)
    if method == "b":
        return indexes.b.query(lat, lon)
    if method == "c":
        return indexes.c.query(lat, lon, boundary_mode="exact")
    if method == "d":
        return indexes.c.query(lat, lon, boundary_mode="random")
    raise ValueError(f"unknown method {method!r}")


def render_tile_png(indexes, method, z, x, y, resolution=8, color_space="oklch"):
    resolution = max(1, min(resolution, TILE_SIZE))
    grid_size = max(1, TILE_SIZE // resolution)

    small = Image.new("RGBA", (grid_size, grid_size), TRANSPARENT)
    px = small.load()

    for gy in range(grid_size):
        cy = gy * resolution + resolution / 2
        for gx in range(grid_size):
            cx = gx * resolution + resolution / 2
            lat, lon = tile_pixel_to_lonlat(z, x, y, cx, cy)
            result = query_for_method(indexes, method, lat, lon)
            cid = city_color_id(result)
            if cid is None:
                px[gx, gy] = TRANSPARENT
            else:
                r, g, b = city_to_rgb(cid, color_space)
                px[gx, gy] = (r, g, b, 255)

    img = small.resize((TILE_SIZE, TILE_SIZE), Image.NEAREST)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
