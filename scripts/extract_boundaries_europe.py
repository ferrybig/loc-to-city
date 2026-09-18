#!/usr/bin/env python3
"""
Europe-wide scaling probe: same idea as extract_boundaries.py (NL), but
across every country in the extract. This is explicitly NOT trying to
match NL's precision -- NL uses admin_level=10 (BAG-sourced "woonplaats",
sub-municipality granularity) because that convention happens to exist
there. Not every European country has an equivalent fine-grained level
with consistent semantics, so this script uses admin_level=8 uniformly as
a "city/municipality" proxy everywhere, admin_level=4 as "region", and
admin_level=2 (with its ISO3166-1:alpha2 tag) as "country". The point of
this script is to answer "does the pipeline scale to continent-size input"
-- not to ship an accurate multi-country dataset.

Output: data/eu_cities.geojson (FeatureCollection, one feature per city)
"""
import json
import sys
import time
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.strtree import STRtree

SRC = Path("data/work-eu/eu-admin.geojson")
OUT = Path("data/eu_cities.geojson")
NE_COUNTRIES = Path("agent-resources/ne_10m_admin_0_countries.geojson")

COUNTRY_LEVEL = "2"
REGION_LEVEL = "4"
CITY_LEVEL = "8"

# Simplify on load, before anything accumulates in memory. Country-level
# relations can carry extremely detailed coastlines (Norway, Croatia,
# Russia...) -- at full precision, keeping ~123 of those plus 150k+ city
# polygons resident at once is what actually OOM'd the first attempt
# (system-wide, not just this process). These tolerances only affect the
# coarse region/country *containment* test in this scaling probe, not the
# precision-critical NL grid -- acceptable here, not for the real deliverable.
CITY_SIMPLIFY_DEG = 0.0005      # ~55m at NL latitude
REGION_SIMPLIFY_DEG = 0.002     # ~220m
COUNTRY_SIMPLIFY_DEG = 0.01     # ~1.1km

ISO_TAG_CANDIDATES = ("ISO3166-1:alpha2", "ISO3166-1", "country_code_iso3166_1_alpha_2")


def load_records(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def iso_code(props):
    for tag in ISO_TAG_CANDIDATES:
        v = props.get(tag)
        if v:
            return v.upper()
    return None


def main():
    t0 = time.time()
    cities, regions, countries = [], [], []

    n_seen = 0
    for rec in load_records(SRC):
        n_seen += 1
        p = rec["properties"]
        lvl = p.get("admin_level")
        if lvl not in (COUNTRY_LEVEL, REGION_LEVEL, CITY_LEVEL):
            continue
        try:
            geom = shape(rec["geometry"])
        except Exception:
            continue
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty:
            continue
        if lvl == CITY_LEVEL:
            geom = geom.simplify(CITY_SIMPLIFY_DEG, preserve_topology=True)
            cities.append((p, geom))
        elif lvl == REGION_LEVEL:
            geom = geom.simplify(REGION_SIMPLIFY_DEG, preserve_topology=True)
            regions.append((p, geom))
        elif lvl == COUNTRY_LEVEL:
            geom = geom.simplify(COUNTRY_SIMPLIFY_DEG, preserve_topology=True)
            countries.append((p, geom))
        if n_seen % 200_000 == 0:
            print(f"  scanned {n_seen:,} records, {time.time()-t0:.0f}s elapsed "
                  f"(cities={len(cities):,} regions={len(regions):,} countries={len(countries):,})", file=sys.stderr)

    print(f"Loaded: cities(L{CITY_LEVEL})={len(cities):,} regions(L{REGION_LEVEL})={len(regions):,} "
          f"countries(L{COUNTRY_LEVEL})={len(countries):,}  ({time.time()-t0:.0f}s)", file=sys.stderr)

    region_geoms = [g for _, g in regions]
    region_tree = STRtree(region_geoms)
    country_geoms = [g for _, g in countries]
    country_tree = STRtree(country_geoms)

    # Fallback for countries whose OSM admin_level=2 relation doesn't assemble
    # into a valid polygon in this extract (e.g. France: its relation
    # references overseas-department members that a Europe-only geographic
    # extract clips away, breaking multipolygon assembly entirely -- a known
    # OSM-data quirk, not a bug here). Natural Earth's country polygons are
    # self-contained per country and don't have this problem; this is the
    # same fallback dataset (and the same "OSM place primary, coarse country
    # polygon fallback" design) Immich itself uses for naturalearth_countries.
    ne_data = json.loads(NE_COUNTRIES.read_text())
    ne_props = [f["properties"] for f in ne_data["features"]]
    ne_geoms = [shape(f["geometry"]) for f in ne_data["features"]]
    ne_tree = STRtree(ne_geoms)

    def ne_iso(props):
        # ISO_A2 is "-99" for a small set of countries in Natural Earth's
        # 10m admin-0 file (France notably) -- a long-standing, documented
        # NE quirk for disputed/contested cases. ISO_A2_EH ("everywhere,
        # including disputed") has the real code for these.
        for field in ("ISO_A2_EH", "ISO_A2"):
            v = props.get(field)
            if v and v != "-99":
                return v
        return None

    def find_ne_country(pt):
        idxs = ne_tree.query(pt)
        for i in idxs:
            if ne_geoms[i].contains(pt):
                return ne_iso(ne_props[i])
        for i in idxs:
            if ne_geoms[i].intersects(pt):
                return ne_iso(ne_props[i])
        return None

    def find_container(pt, tree, geoms, props_list):
        idxs = tree.query(pt)
        for i in idxs:
            if geoms[i].contains(pt):
                return props_list[i][0]
        for i in idxs:
            if geoms[i].intersects(pt):
                return props_list[i][0]
        return None

    features = []
    missing_region = missing_country = ne_fallback_used = 0
    seen_ids = {}
    next_id = 1
    t1 = time.time()
    for i, (p, geom) in enumerate(cities):
        centroid = geom.representative_point()
        region_p = find_container(centroid, region_tree, region_geoms, regions)
        country_p = find_container(centroid, country_tree, country_geoms, countries)
        if region_p is None:
            missing_region += 1

        country_code = iso_code(country_p) if country_p else None
        if not country_code:
            ne_code = find_ne_country(centroid)
            if ne_code:
                country_code = ne_code
                ne_fallback_used += 1
        if country_code is None:
            missing_country += 1

        osm_id = p.get("@id") or p.get("id")
        city_id = f"eu-{osm_id}" if osm_id else f"eu-gen-{next_id}"
        if city_id in seen_ids:
            city_id = f"{city_id}-{next_id}"
        seen_ids[city_id] = True
        next_id += 1

        features.append({
            "type": "Feature",
            "geometry": mapping(geom),
            "properties": {
                "id": city_id,
                "name": p.get("name"),
                "municipality": None,  # no reliable finer level available uniformly across countries
                "region": region_p.get("name") if region_p else None,
                "country": country_code,
            },
        })
        if (i + 1) % 20_000 == 0:
            print(f"  resolved {i+1:,}/{len(cities):,} cities, {time.time()-t1:.0f}s elapsed", file=sys.stderr)

    print(f"missing_region={missing_region:,} missing_country={missing_country:,} "
          f"ne_fallback_used={ne_fallback_used:,}", file=sys.stderr)

    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False))
    size = OUT.stat().st_size
    print(f"wrote {len(features):,} cities to {OUT} ({size/1024/1024:.1f} MiB) in {time.time()-t0:.0f}s total", file=sys.stderr)


if __name__ == "__main__":
    main()
