#!/usr/bin/env python3
"""
Parse the osmium-exported geojsonseq of NL admin boundaries and build a clean
cities dataset: each city (admin_level=10, "woonplaats") gets its containing
province (admin_level=4) and municipality (admin_level=8) attached.

Output: data/nl_cities.geojson  (FeatureCollection, one feature per city)
"""
import json
import sys
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.strtree import STRtree

SRC = Path("data/work/nl-admin.geojson")
OUT = Path("data/nl_cities.geojson")


def load_records(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def main():
    cities = []       # admin_level 10
    municipalities = []  # admin_level 8
    provinces = []     # admin_level 4

    for rec in load_records(SRC):
        p = rec["properties"]
        lvl = p.get("admin_level")
        geom = shape(rec["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        if lvl == "10":
            cities.append((p, geom))
        elif lvl == "8":
            municipalities.append((p, geom))
        elif lvl == "4":
            provinces.append((p, geom))

    print(f"cities(L10)={len(cities)} municipalities(L8)={len(municipalities)} provinces(L4)={len(provinces)}", file=sys.stderr)

    # Spatial index for containment lookups by centroid
    muni_geoms = [g for _, g in municipalities]
    muni_tree = STRtree(muni_geoms)
    prov_geoms = [g for _, g in provinces]
    prov_tree = STRtree(prov_geoms)

    def find_container(pt, tree, geoms, props_list):
        idxs = tree.query(pt)
        for i in idxs:
            if geoms[i].contains(pt):
                return props_list[i][0]
        # fall back to intersects (point exactly on a shared boundary)
        for i in idxs:
            if geoms[i].intersects(pt):
                return props_list[i][0]
        return None

    features = []
    missing_muni = missing_prov = 0
    seen_codes = {}
    next_id = 1
    for p, geom in cities:
        centroid = geom.representative_point()  # guaranteed inside the polygon
        muni_p = find_container(centroid, muni_tree, muni_geoms, municipalities)
        prov_p = find_container(centroid, prov_tree, prov_geoms, provinces)
        if muni_p is None:
            missing_muni += 1
        if prov_p is None:
            missing_prov += 1

        code = p.get("ref:woonplaatscode")
        if code:
            city_id = f"nl-wp-{code}"
        else:
            city_id = f"nl-gen-{next_id}"
            next_id += 1
        if city_id in seen_codes:
            city_id = f"{city_id}-{next_id}"
            next_id += 1
        seen_codes[city_id] = True

        features.append({
            "type": "Feature",
            "geometry": mapping(geom),
            "properties": {
                "id": city_id,
                "name": p.get("name"),
                "municipality": muni_p.get("name") if muni_p else None,
                "region": prov_p.get("name") if prov_p else None,
                "country": "NL",
                "wikidata": p.get("wikidata"),
            },
        })

    print(f"missing_municipality={missing_muni} missing_province={missing_prov}", file=sys.stderr)

    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False))
    print(f"wrote {len(features)} cities to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
