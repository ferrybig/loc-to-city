#!/usr/bin/env python3
"""
Europe-wide scaling probe: same idea as extract_boundaries.py (NL), but
across every country in the extract.

v1 of this script used a single hardcoded admin_level=8 ("city") for every
country. That produced real, widespread coverage gaps -- OSM's admin_level
convention for "city/municipality" is NOT uniform across Europe:
  - Germany's "kreisfreie Städte" (independent cities -- Oberhausen,
    Münster, Berlin...) are tagged admin_level=6, not 8, since they're
    simultaneously their own county; only ordinary towns use 8.
  - The UK is inconsistent; some areas only have a matching boundary at
    admin_level=10.
  - Latvia's municipalities are admin_level=7.
  - Poland, Bosnia and others mix multiple levels for same-named places
    (a small settlement polygon at one level, its containing municipality
    at another), so even the "right" level isn't always a complete tiling.
A single constant can't be correct for all of that. The natural next idea
-- pick a *set* of admin_levels per country instead of just one, by
including any level whose own area covers a large-enough share of the
country -- turned out to be wrong too: Germany's admin_level=5
("Regierungsbezirk", a *region*) also has high area coverage, simply
because it's the union of everything below it. Area share alone can't
tell a genuine standalone leaf (a kreisfreie Stadt, which has no
admin_level=8 child at all) apart from a coarse parent container (an
ordinary Kreis, whose area share is high purely because it's the sum of
its own admin_level=8 children).

So this version uses three passes instead:
  pass 1: for every candidate-level relation, resolve its country (against
          Natural Earth, not OSM -- see below) and accumulate area by
          (country, level); geometry is discarded immediately after, so
          peak memory stays bounded regardless of how many candidates
          exist. Region (admin_level=4) geometries are fully kept here
          since there are only ~1,100 of them. This picks one *primary*
          level per country, same as the first version.
  pass 2: re-scan, keep a relation only if its own level is that
          country's primary level. This is the safe, high-coverage
          baseline -- same result as always choosing a single level, e.g.
          admin_level=8 for Germany.
  pass 3: re-scan once more, this time checking every candidate-level
          relation that ISN'T the primary level: is its representative
          point already resolved by something kept in pass 2? If yes,
          it's redundant (an ordinary Kreis's point falls inside one of
          its own child Gemeinden -- exactly the "coarse container"
          case). If no, nothing else covers this location at all, so
          it's a genuine gap -- exactly the "kreisfreie Stadt" case --
          and gets added as a supplementary city.

Country resolution uses Natural Earth exclusively (agent-resources/
ne_10m_admin_0_countries.geojson), not OSM's own admin_level=2 boundaries.
Earlier we resolved country from OSM in the first place, with NE only as a
fallback for the handful of countries (France) whose relation doesn't
assemble in a Europe-only extract. Since we now need a robust country
classification for potentially hundreds of thousands of candidate records
regardless of level, and NE covers the whole world reliably with no
assembly-failure risk, it's simpler and just as correct to use NE
throughout instead of maintaining two paths.

Output: data/eu_cities.geojson (FeatureCollection, one feature per city)
"""
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.strtree import STRtree

SRC = Path("data/work-eu/eu-admin.geojson")
OUT = Path("data/eu_cities.geojson")
NE_COUNTRIES = Path("agent-resources/ne_10m_admin_0_countries.geojson")

REGION_LEVEL = "4"
CANDIDATE_CITY_LEVELS = ["11", "10", "9", "8", "7", "6", "5"]  # finest first
COVERAGE_THRESHOLD = 0.6  # min fraction of a country's NE area a level's union must reach to be "complete"

CITY_SIMPLIFY_DEG = 0.0005      # ~55m at NL latitude
REGION_SIMPLIFY_DEG = 0.002     # ~220m
COUNTRY_SIMPLIFY_DEG = 0.01     # ~1.1km -- only used for the coverage/containment test, not stored in output


def load_records(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def load_ne_countries():
    ne_data = json.loads(NE_COUNTRIES.read_text())
    isos, geoms = [], []
    for f in ne_data["features"]:
        p = f["properties"]
        iso = None
        for field in ("ISO_A2_EH", "ISO_A2"):  # ISO_A2 is "-99" for France etc. -- see README
            v = p.get(field)
            if v and v != "-99":
                iso = v
                break
        if not iso:
            continue
        g = shape(f["geometry"]).simplify(COUNTRY_SIMPLIFY_DEG, preserve_topology=True)
        if g.is_empty:
            continue
        isos.append(iso)
        geoms.append(g)
    tree = STRtree(geoms)
    return isos, geoms, tree


def find_country(pt, isos, geoms, tree):
    idxs = tree.query(pt)
    for i in idxs:
        if geoms[i].contains(pt):
            return isos[i]
    for i in idxs:
        if geoms[i].intersects(pt):
            return isos[i]
    return None


def find_primary_level_per_country(country_areas, country_own_area):
    """Finest admin_level per country that clears COVERAGE_THRESHOLD --
    the safe, granular baseline. Supplementary (non-primary) levels are
    handled separately, in pass 3, by an actual gap test rather than an
    area threshold.

    This deliberately does NOT take the single highest-coverage level
    (argmax): a coarse level's ratio is often *higher* than a fine level's
    purely because it's the union of many fine children (Germany's
    Kreis/admin_level=6 covers 100% of the country for exactly this
    reason -- every location is in some Kreis). Picking that would give
    every ordinary town its whole *county* as its "city", which is worse
    than the fine level's ~96% coverage with a few gaps pass 3 will fill.
    So: walk from finest to coarsest and take the first level that's
    already close to complete on its own; only fall back to a coarser
    (higher-total-coverage) level if nothing finer comes close.
    """
    primary = {}
    for iso, by_level in country_areas.items():
        own_area = country_own_area.get(iso)
        if not own_area or not by_level:
            continue
        ratios = {lvl: area / own_area for lvl, area in by_level.items()}
        chosen = None
        for lvl in CANDIDATE_CITY_LEVELS:  # finest first
            if ratios.get(lvl, 0.0) >= COVERAGE_THRESHOLD:
                chosen = lvl
                break
        if chosen is None:
            chosen = max(ratios, key=ratios.get)
            print(f"  {iso}: no level reached {COVERAGE_THRESHOLD:.0%} coverage, "
                  f"best is level {chosen} ({ratios[chosen]:.0%}) -- using it anyway", file=sys.stderr)
        primary[iso] = chosen
    return primary


def main():
    t0 = time.time()
    isos, ne_geoms, ne_tree = load_ne_countries()
    country_own_area = {}
    for iso, g in zip(isos, ne_geoms):
        country_own_area[iso] = country_own_area.get(iso, 0.0) + g.area
    print(f"Loaded {len(isos)} NE country polygons ({time.time()-t0:.0f}s)", file=sys.stderr)

    # ---- pass 1: region geometries (kept in full) + city-candidate area-by-(country,level) ----
    regions = []  # (props, geom)
    country_level_area = defaultdict(lambda: defaultdict(float))
    n_seen = 0
    for rec in load_records(SRC):
        n_seen += 1
        p = rec["properties"]
        lvl = p.get("admin_level")
        if lvl == REGION_LEVEL:
            try:
                g = shape(rec["geometry"])
            except Exception:
                continue
            if not g.is_valid:
                g = g.buffer(0)
            if g.is_empty:
                continue
            regions.append((p, g.simplify(REGION_SIMPLIFY_DEG, preserve_topology=True)))
        elif lvl in CANDIDATE_CITY_LEVELS:
            try:
                g = shape(rec["geometry"])
            except Exception:
                continue
            if not g.is_valid:
                g = g.buffer(0)
            if g.is_empty:
                continue
            country = find_country(g.representative_point(), isos, ne_geoms, ne_tree)
            if country:
                country_level_area[country][lvl] += g.area
        if n_seen % 200_000 == 0:
            print(f"  pass1: scanned {n_seen:,} records, {time.time()-t0:.0f}s elapsed, "
                  f"regions={len(regions):,}", file=sys.stderr)

    print(f"Pass 1 done: {len(regions):,} regions, {len(country_level_area):,} countries with city candidates "
          f"({time.time()-t0:.0f}s)", file=sys.stderr)

    primary_level = find_primary_level_per_country(country_level_area, country_own_area)
    print("Primary city admin_level per country:", file=sys.stderr)
    for iso in sorted(primary_level):
        print(f"  {iso}: {primary_level[iso]}", file=sys.stderr)

    region_geoms = [g for _, g in regions]
    region_tree = STRtree(region_geoms)

    def find_region(pt):
        idxs = region_tree.query(pt)
        for i in idxs:
            if region_geoms[i].contains(pt):
                return regions[i][0]
        for i in idxs:
            if region_geoms[i].intersects(pt):
                return regions[i][0]
        return None

    def make_feature(p, geom, country, region_p, next_id, seen_ids):
        osm_id = p.get("@id") or p.get("id")
        city_id = f"eu-{osm_id}" if osm_id else f"eu-gen-{next_id}"
        if city_id in seen_ids:
            city_id = f"{city_id}-{next_id}"
        seen_ids[city_id] = True
        return {
            "type": "Feature",
            "geometry": mapping(geom),
            "properties": {
                "id": city_id,
                "name": p.get("name"),
                "municipality": None,
                "region": region_p.get("name") if region_p else None,
                "country": country,
            },
        }

    # ---- pass 2: re-scan, keep only relations whose level is their country's primary level ----
    t1 = time.time()
    features = []
    seen_ids = {}
    next_id = 1
    n_seen = 0
    for rec in load_records(SRC):
        n_seen += 1
        p = rec["properties"]
        lvl = p.get("admin_level")
        if lvl not in CANDIDATE_CITY_LEVELS:
            continue
        try:
            g = shape(rec["geometry"])
        except Exception:
            continue
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty:
            continue
        centroid = g.representative_point()
        country = find_country(centroid, isos, ne_geoms, ne_tree)
        if not country or primary_level.get(country) != lvl:
            continue

        geom = g.simplify(CITY_SIMPLIFY_DEG, preserve_topology=True)
        region_p = find_region(centroid)
        features.append(make_feature(p, geom, country, region_p, next_id, seen_ids))
        next_id += 1
        if n_seen % 200_000 == 0:
            print(f"  pass2: scanned {n_seen:,} records, kept {len(features):,}, {time.time()-t1:.0f}s elapsed", file=sys.stderr)

    print(f"Pass 2 done: {len(features):,} primary-level cities ({time.time()-t1:.0f}s)", file=sys.stderr)

    # ---- pass 3: gap-fill -- add a non-primary relation only if nothing kept so far covers its location ----
    t2 = time.time()
    primary_geoms = [shape(f["geometry"]) for f in features]
    primary_tree = STRtree(primary_geoms)
    n_seen = 0
    n_added = 0
    for rec in load_records(SRC):
        n_seen += 1
        p = rec["properties"]
        lvl = p.get("admin_level")
        if lvl not in CANDIDATE_CITY_LEVELS:
            continue
        try:
            g = shape(rec["geometry"])
        except Exception:
            continue
        if not g.is_valid:
            g = g.buffer(0)
        if g.is_empty:
            continue
        centroid = g.representative_point()
        country = find_country(centroid, isos, ne_geoms, ne_tree)
        if not country or primary_level.get(country) == lvl:
            continue  # already handled in pass 2

        already_covered = False
        for i in primary_tree.query(centroid):
            if primary_geoms[i].contains(centroid) or primary_geoms[i].intersects(centroid):
                already_covered = True
                break
        if already_covered:
            continue  # redundant container (e.g. an ordinary Kreis whose point falls in its own child Gemeinde)

        geom = g.simplify(CITY_SIMPLIFY_DEG, preserve_topology=True)
        region_p = find_region(centroid)
        features.append(make_feature(p, geom, country, region_p, next_id, seen_ids))
        next_id += 1
        n_added += 1
        if n_seen % 200_000 == 0:
            print(f"  pass3: scanned {n_seen:,} records, gap-filled {n_added:,}, {time.time()-t2:.0f}s elapsed", file=sys.stderr)

    print(f"Pass 3 done: gap-filled {n_added:,} supplementary cities ({time.time()-t2:.0f}s)", file=sys.stderr)

    OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False))
    size = OUT.stat().st_size
    print(f"wrote {len(features):,} cities to {OUT} ({size/1024/1024:.1f} MiB) in {time.time()-t0:.0f}s total", file=sys.stderr)


if __name__ == "__main__":
    main()
