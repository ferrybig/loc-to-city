---
description: Measure a candidate admin_level (region or city) for one or more countries against the already-extracted OSM data, without a full prepare-world.ts run. Use when a countries.md entry's fix is "pick a different level" or before changing COUNTRY_ADMIN_LEVELS.
---

# Checking an admin_level pick for a country

Paths are relative to the repo root. `levels.mjs` next to this file measures, per
`(country, admin_level 3-11)`, how much of the country each level tessellates, from
`data/01-extracted/world/*-admin.geojson` (what Pass 1 reads). Don't guess a level and don't
run all of `prepare-world.ts` for this.

```bash
node .claude/skills/check-admin-level/levels.mjs LA UZ     # any ISO alpha-2 codes
```

It takes ~5.5 min cold (~1.5 min with the file in the page cache), regardless of how many
countries: two streaming passes over the ~10 GB planet file (OSM country borders, then every
relation). Run it in the background and wrap it
in `systemd-run --user --scope -p MemoryMax=10G` as for any heavy job here. Output, one line
per level:

```
LA/4        18 rel  100.7% of NE ໄຊສົມບູນ, ວຽງຈັນ, ...
LA/6       148 rel  100.7% of NE ເມືອງທ່າໂທມ, ...
LA/7         1 rel    0.2% of NE ວຽງຈັນ
```

"% of NE" is the summed relation area over the country's Natural Earth area (it can pass 100%
because OSM outlines include territorial waters). Last run 2026-11-04 on the extract of 2026-10-01
(LA and UZ: LA/4 and LA/6 each ~100%, UZ/6 99.9%).

## Reading the result
1. Detection picks the finest level covering ≥60% (`DEFAULT_COVERAGE_THRESHOLD` in
   `data-ingest/src/lib/adminLevelDetection.ts`), otherwise the level with the largest share.
   Compare that with the country's entry in `data-ingest/src/lib/countryAdminLevels.ts`.
2. **This script sees every level 3-11; Pass 1 doesn't.** `classifyAdminFeature`
   (`lib/adminBoundaryIndex.ts`) drops a relation unless its level is in the country's own
   `COUNTRY_ADMIN_LEVELS` lists (`city`, region overrides, `region`, `regionGapFill`,
   `regionOutside`). So an entry saying `region: [6]` means level 4 was never measured, and
   "6 won" says nothing about 4. Uzbekistan and Laos both had this; here UZ/3 (Karakalpakstan,
   37%) + UZ/4 (14 oblasts, 63%) are a pair that tile the country together, as is LA/4 alone.
3. Coverage is not names. Check the level's names are the ones a lookup should return: rebuild,
   then `npm run reader -- lookup data/03-final/world.bin <lat,lon>` on a few well-known cities
   (the United States and Canada sections of `countries.md` are the examples of coverage and
   names disagreeing).
4. Record the measurement and result in the country's `countries.md` section, including a
   reverted attempt, and cite any source the user linked. Mirror new spot-check coordinates in
   `verify/src/cases.ts` and run `npm test -w verify` (~1 min; it prints assertion errors for
   `todo` cases, read the final `fail` count instead of the log).

## Gotchas
- The script is a `.mjs` importing the repo's `.ts` modules directly (Node ≥26 strips types),
  and gets `@turf/area` through `createRequire` from the repo root, because it can't resolve
  it from outside `node_modules`. Keep it in this directory.
- It resolves countries like Pass 1 (Natural Earth, corrected by `withOsmCountryBorders`) but
  without the `outlineAt` fallback for polygons Natural Earth places nowhere, so coastal
  slivers may be missing. Percentages are good to a point or so, not exact.
- It does not read `data/01-extracted/world/*-census.geojson` relations (skipped), so a
  country using `regionBoundary: "census"` (SI) can't be checked with it.
