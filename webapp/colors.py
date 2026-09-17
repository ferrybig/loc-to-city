"""Deterministic city -> color mapping for the tile overlay.

A city's id is hashed to an integer, which becomes a hue (0-360). Lightness
and chroma/saturation are fixed so only the hue varies -- adjacent cities
end up visibly different colors, and the same city always renders the same
color across tiles/zoom levels/requests (no per-process random seed
involved, unlike Python's builtin hash()).
"""
import hashlib
import math


def city_hue(city_id: str) -> float:
    h = hashlib.md5(city_id.encode()).digest()
    val = int.from_bytes(h[:4], "big")
    return val % 360


def _clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def hsl_to_rgb(hue):
    """hsl(hue 70.2% 46.52%) -> (r, g, b) in 0..255."""
    h = (hue % 360) / 360.0
    s, l = 0.702, 0.4652
    # standard HSL->RGB (colorsys uses HLS ordering, same math)
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h * 6) % 2 - 1))
    m = l - c / 2
    if h < 1 / 6:
        r, g, b = c, x, 0
    elif h < 2 / 6:
        r, g, b = x, c, 0
    elif h < 3 / 6:
        r, g, b = 0, c, x
    elif h < 4 / 6:
        r, g, b = 0, x, c
    elif h < 5 / 6:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    return (round((r + m) * 255), round((g + m) * 255), round((b + m) * 255))


# OKLCH -> sRGB, following Björn Ottosson's reference formulas
# (https://bottosson.github.io/posts/oklab/). Fixed L=0.7463, C=0.1213;
# hue is the only variable.
def _oklab_to_linear_srgb(L, a, b):
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b

    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3

    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return r, g, b


def _linear_to_srgb(c):
    c = _clamp01(c)
    if c <= 0.0031308:
        v = 12.92 * c
    else:
        v = 1.055 * (c ** (1 / 2.4)) - 0.055
    return _clamp01(v)


def oklch_to_rgb(hue):
    """oklch(0.7463 0.1213 hue) -> (r, g, b) in 0..255."""
    L, C = 0.7463, 0.1213
    h_rad = math.radians(hue)
    a, b = C * math.cos(h_rad), C * math.sin(h_rad)
    lr, lg, lb = _oklab_to_linear_srgb(L, a, b)
    r, g, b = _linear_to_srgb(lr), _linear_to_srgb(lg), _linear_to_srgb(lb)
    return (round(r * 255), round(g * 255), round(b * 255))


def city_to_rgb(city_id, color_space="oklch"):
    hue = city_hue(city_id)
    if color_space == "hsl":
        return hsl_to_rgb(hue)
    return oklch_to_rgb(hue)
