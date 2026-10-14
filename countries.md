# Countries

The per-country status of the worldwide build: which OSM `admin_level`
each country's region and city tier resolves at, which exceptions exist
(`overrides`, `wholeUnits`, Voronoi fallbacks), what was measured when they
were chosen, and what is still wrong. Every change to
`data-ingest/src/lib/countryAdminLevels.ts` (or to how a country is
resolved) should be recorded in the country's section here, including the
dead ends: a reverted attempt is the cheapest thing to write down and the
most expensive to rediscover.

The README keeps the pipeline and format story; this file keeps the
country story. The code's own doc comments in `countryAdminLevels.ts` carry
the mechanics of each knob; this file carries the reasoning and the
evidence.

## Reading this file

Every entry is a bullet starting with a bold title. Titles of entries that
need attention end with a marker, so `grep -n '\*(open)\*' countries.md`
lists the work:

- *(open)*: wrong today and fixable, or not yet understood. The entry says
  what is known and what to try next.
- *(unsolvable)*: wrong today and nothing in this pipeline can fix it (the
  data does not exist, or the format cannot express it). Say why, so nobody
  re-investigates.
- *(human error)*: the source data (OSM, Natural Earth, GeoNames) is wrong
  or inconsistent, as opposed to this pipeline mishandling correct data.
  Worth reporting upstream; works around it only if cheap.
- *(false positive)*: looked wrong on the map, is right. Kept so the next
  person who spots it does not spend an afternoon on it.

An entry without a marker is resolved or purely informational (a config
choice and why). Resolved entries stay, with the measurement that justified
them, because the same mistake gets proposed again.

Spot-check coordinates are `lat, lon` and were looked up on
`data/03-final/world-high-res.bin` (built 2026-10-10) unless stated
otherwise. `verify/test/world-queries.test.ts` turns the coordinates in
this file into a test against the worldwide `.bin` (`world-high-res.bin`, or
`world.bin` when that is all there is; `CGEODATA_WORLD_BIN` picks one, e.g.
the faster `world.bin` for rough work, where small places and borders will
differ): places that
resolve correctly (including *(false positive)* ones) are plain tests,
*(open)*, *(unsolvable)* and *(human error)* places with a known expected
answer are `todo` tests (they run, a failure is reported as todo, and one
that starts passing prints `NOW PASSING`: close the entry). Keep the two in
step: the cases are in `verify/src/cases.ts`, each with the entry's marker as
its `status` and the entry's title as its `entry`, and
`verify/test/ledger.test.ts` fails when they disagree with this file, so
**do not rename an entry's title or change its marker without updating the
case.** The same results, as `<name>.checks.json`, are drawn as markers on the
demo's map (green check: verified; orange: open; purple: report upstream), so
people can see which places are covered and which artifacts need reporting.

Section order is alphabetical by English country name, with the ISO code
and the current config in the first line of each. Coverage percentages come
from the generated table's comments and are the share of the country's
Natural Earth area that level's polygons add up to, so over 100% means
overlapping candidates.

## What each tier is for

The three tiers feed three pickers in a consumer such as Immich, and an
answer is judged by whether it belongs in the picker for its tier:

- **Country** is shown in a country list.
- **Region** is shown in a state / province / region list.
- **City** is shown in a city / village list.

Every answer serves two questions: "where was this photo taken" and the
reverse, "show me all photos in the city of Beijing". The reverse question
only works if the place is listed where a person looks for it. So:

- The city tier names the city or village a person would say (Beijing, not
  "Dongcheng District"; Tokyo, not "Shinjuku"; London, not "City of
  Westminster"). The project does not go deeper than city / village / rural
  level, so a sub-district is not a better answer than the city around it.
- A city must not exist only as a region. Berlin, Prague and Kyiv listed in
  the state / province / region picker and absent from the city picker is
  wrong, even though the name shown for a photo is the same.
- A region list should hold regions: a city, district or parish that fills
  the region tier because the country has no level between country and
  town is a symptom to record, not an answer.
- A rule that would pass a district, or a region named for the city, to
  make a number look better is the wrong rule.

When deciding whether a lookup "resolves correctly", or whether a new
`COUNTRY_ADMIN_LEVELS` choice is an improvement, apply this and not "the
name looks plausible". The capitals benchmark in
`verify/test/world-queries.test.ts` is this rule applied to every
country (see "Capitals" under Cross-cutting patterns).

## How a place gets its country, region and city

- **Country** list and names come from Natural Earth's 10m `admin_0`
  countries (`data/00-raw/natural-earth/ne_10m_admin_0_countries.geojson`),
  keyed by `ISO_A2_EH`. Cities and regions are assigned to a country by
  sampling a point against Natural Earth's outlines, corrected by OSM's own
  `admin_level=2` borders where the two disagree (`osmCountryBorders.ts`;
  fixed Baarle-Hertog's Belgian enclaves). A polygon Natural Earth places
  nowhere at all (every sample at sea) gets the country whose drawn outline
  is there instead (`resolvePolygonCountry`'s `outlineAt`; see "Places
  Natural Earth puts at sea were dropped"). The country *polygons* the
  compressor draws are OSM's (`loadOsmCountryRelations`): each code's
  `admin_level=2` relation, or a dependency's own ISO-tagged relation
  (Hong Kong at level 3, Puerto Rico at 4), territorial waters included,
  with overlaps between them cut by `countryOutlines.ts`. Natural Earth's
  outline is used only for the three codes OSM has no relation for:
  Palestine, Antarctica, U.S. Minor Outlying Islands. See "Natural Earth's
  outlines are too coarse".
- **Region** and **city** are OSM `admin_level` tiers chosen per country in
  `COUNTRY_ADMIN_LEVELS` (`{ region: [...], city: [...] }`). The 3-pass
  detection in `adminLevelDetection.ts` picks the finest level that covers
  at least 60% of the country as the *primary* city tier and gap-fills any
  later-listed level wherever no primary covers a candidate's representative
  point. The generated table was then hand-reviewed; the notes below are
  that review.
- **`overrides`** (region name -> `[primary, ...gapFill]`) replaces a
  country's city levels inside one region (the New York way). **`wholeUnits`**
  promotes named whole cities and drops their sub-units (Wales).
- **Voronoi fallbacks** synthesize polygons from GeoNames `cities500.txt`
  points where OSM has none: `VORONOI_CITY_FALLBACK` (whole country),
  `VORONOI_CITY_FALLBACK_WITHIN_REGIONS` (clipped to a region's district
  polygons), `VORONOI_REGION_FALLBACK` (Slovenia), and
  `VORONOI_CITY_FALLBACK_HOLES` (only the land no real city covers, 21
  countries, see "Countries with a thin city tier").
- A **city whose region cannot be determined is dropped**, not kept
  region-less (`emitCity` in `prepare-world.ts`).
- Anything no polygon covers falls back one tier: a point with no city
  shows the region, a point with no region shows the country.

## Finding more of these

Most of what is in this file was found by looking at the demo's tile
overlay and then asking "why does that look wrong". Patterns that have
paid off:

1. **Unusually shaped or sized records.** One record far larger than its
   neighbours, or a record whose bounding box swallows another's. Lelystad
   is the canonical false positive (below), but it is also how the Polish
   rings were spotted. Mechanically:
   `node reader/src/cli.ts list <bin> --level city --country <name> --json`
   gives ids, and `locate <bin> <id>... --json` gives each place's `area`
   (square degrees) and `boundingBox`; sort by area, or look for a bounding
   box that contains a smaller place's.
2. **Matching names across tiers.** A city that equals its region, or two
   cities in one region whose names differ by an administrative prefix
   (`gmina Lubin` / `Lubin`). Usually the rural unit around a town (see
   "Surrounding rural unit" below).
3. **A region with no city, or a country with no region.** Look the point up;
   a `-` in the middle of a country is a hole in the candidates, not the
   ocean. `lookup` at the capital and the five largest cities of a country
   is a five-minute audit.
4. **Names that GeoNames knows and we do not.** `search` for a name from
   `cities500.txt` (`Izbica`) and see which polygon, if any, carries it.
5. **A border that only ever bends one way.** If the artifacts always push
   the same country into its neighbours, it is an outline problem, not a
   tier problem.
6. **Low city coverage in the generated table.** The comments next to each
   `COUNTRY_ADMIN_LEVELS` entry list the share of the country that tier
   covers. Under about 20% (Angola 9.1, Azerbaijan 4.2, Georgia 4.3,
   Montenegro 9.6, Namibia 0.1, Uganda 6.4, Uruguay 1.3, Qatar 1.2, ... and
   a tail of islands) means most of that country answers with its region.
   Check those by hand before trusting any of them.
7. **Cities drawn twice.** `data/02-resolved/world/duplicate-cities.tsv`,
   written by every `prepare-world.ts` run, lists cities whose geometry is
   byte-identical to another's (see "Cities drawn twice" below), with
   links to fix them in OSM.

Confirming a hypothesis about the OSM data does not need a world rebuild:
scratch-script the extracted GeoJSON directly. `data-ingest`'s own
`report-place-tag-mismatches.ts` is the template (see the tie-break tool
below).

## Cross-cutting patterns

- **Natural Earth's outlines are too coarse for small territories and for
  borders.** Jersey (9 km across) is a 47-vertex ring and Guernsey 59 in
  `ne_10m_admin_0_countries.geojson`; the Vatican is a 7-vertex polygon of
  about 110 m by 130 m, and Monaco a 12-vertex shape shifted west over
  French land. At `--max-depth 8` this mostly hid behind the max-depth
  tie-break; at `--max-depth 11` (an earlier `world_high_res.bin`)
  subdivision reached cells the real boundary never touches, which looked
  like data loss. Fixed (2026-10-12) by drawing OSM's own country relations
  instead (`loadOsmCountryRelations`, see "How a place gets its country"):
  215 countries from their `admin_level=2` relation, 21 dependencies from
  their own ISO-tagged relation at level 3 or 4 (Hong Kong, Puerto Rico,
  Aruba, Åland, New Caledonia, ...), Natural Earth only for Palestine,
  Antarctica and the U.S. Minor Outlying Islands. They include territorial
  waters, so a photo from a boat near a coast answers that country (5 km off
  Scheveningen: Netherlands).

  Two things had to come with it, each measured as a regression without it:
  - **Overlapping outlines get one owner** (`resolveCountryOverlaps`). OSM
    draws a dependency inside its parent (Puerto Rico inside the United
    States), and both sides claim a disputed area. Left overlapping, the
    compressor's max-depth "largest share" rule gives every cell a
    dependency's small cities split to the parent: on `world.bin`, 543
    cities500 points changed country, 195 of them Puerto Rico's and 184 Hong
    Kong's. Each of the 39 overlaps now goes to the country the city/region
    lookup names there (so Crimea stays Russia, Western Sahara Morocco,
    Abyei Sudan, as before; Kafia Kingi, which Natural Earth's outline gave
    to South Sudan, now answers Sudan, which administers it), at sea to the smaller country, and a Natural
    Earth outline loses every overlap with an OSM one (Palestine's
    overshoot took Bāqa el Gharbīya and Zemer from Israel, and Egyptian
    Rafah from Egypt). The U.S. Minor Outlying Islands now answer United
    States: OSM's US relation includes them and their own outline is
    Natural Earth's.
  - **A country is cut out of a foreign region that covers its land**
    (`cutCountriesOutOfForeignRegions`). Region polygons were simplified
    (~1.1 km) until 2026-10-13 (see "Simplified region polygons"), which
    dropped a small hole: Lazio covered the Vatican,
    Provence-Alpes-Côte d'Azur Monaco (Mareterra, outside Monaco's older
    city polygon, answered France), Guangdong Macau, Noord-Brabant the
    Baarle-Hertog enclaves. 304 regions were cut, most by a sliver where a
    simplified region overshot a land border; at full precision 10 are.

  Cost: the outline step takes about 45 s and 3 GB in `prepare-world.ts`,
  the region cut about 2.5 minutes. `country-polygons.geojson` grows from
  12 MB to 136 MB (5.7M vertices). The compressor took 56 s -> 58 s wall
  (367 s -> 432 s CPU) for `world.bin`, 3:44 -> 4:21 for
  `world-high-res.bin`, and both files grew about 1.5-2% (more of the sea
  is a country now).

  Measured against the Natural Earth build on `world-high-res.bin`, over
  every cities500 point: 284 went from no country to one (small islands
  Natural Earth misses: Micronesia, the Maldives, the Marshall Islands,
  Kiribati, ...) and about 40 changed country, nearly all to the right one
  (San Marino, Andorra's Pas de la Casa, Campione, Gibraltar, Monaco,
  Vatican City, Taba, Neu-Moresnet, St-Martin/Sint Maarten). The wrong-
  looking ones are false positives: Liberland (see Croatia), Lake Malawi
  (see Tanzania). About 40 points flip between two overlapping duplicate
  city polygons ("Village of Alix" / "Alix"), because the candidate order
  the compressor's tie-break follows changed; neither name is wrong.
- **Places Natural Earth puts at sea were dropped.** A city or region
  candidate is assigned to a country by sampling points against Natural
  Earth, and a polygon with no sample on Natural Earth's land was dropped
  as "no country" in Pass 1 (8,027 of them). Natural Earth's 10m coastline
  runs inland of whole coastal villages (Ter Heijde, see Netherlands),
  misses small islands and atolls, and puts reclaimed land (Cotai) at sea.
  Its `-99` features are discarded, so South Nicosia's municipality, whose
  samples fell in Natural Earth's buffer zone and Northern Cyprus, went
  too. Fixed (2026-10-12): such a polygon is sampled again against the
  country outlines `prepare-world.ts` draws (overlaps already resolved, so
  the Tuamotus are French Polynesia's and not France's, Åland not
  Finland's), leaving 7 without a country. Only then: Natural Earth's land
  still decides every polygon that has any, so a coastal region's sea
  samples can't outvote its land near a border.

  It came with one filter: an admin relation also tagged `natural=coastline`
  is an island's coastline multipolygon with admin tags added, never a real
  unit, and is no longer a candidate. Worldwide that was 143 named region
  candidates and 1,103 city candidates, all islands, islets or skerries by
  name. As regions they were provinces of their country: Taiwan's 中央嶼, 牛母件嶼,
  草嶼 and 雞籠嶼 are gone, and without the filter the fallback would have
  added 127 more in Penghu alone. `place=island` is no such signal: it is on
  Tobago, Tristan da Cunha, East and Middle Caicos and Kerkennah too.

  Measured on `world-high-res.bin` over every cities500 point (235,895):
  174 gained a city and 155 a region (Micronesia 48 regions, the Maldives
  26, Somaliland 20, Palau 17, Tonga 10, Lakshadweep, French Polynesia's
  Tuamotu-Gambier, Kuwait; cities in the Philippines, Japan, Norway,
  Australia, Croatia), 1 changed country, 3 lost their city, and 133
  changed city or region. The city layer gains 728 cities and loses 61:
  57 are the coastline-tagged islets, 4 are gap-fill places on Corn Island
  (Nicaragua), now inside the island's own municipality, which Natural
  Earth placed nowhere. Of the changes, Ter Heijde (Monster ->
  Ter Heijde), Rab, Atrani and Keansburg are newly kept cities, and
  Kabupaten Kepulauan Talaud wins where two islets were removed by the
  filter. The rest is "A city inside two
  overlapping regions gets whichever the R-tree returns first" below: the
  region set changed, so the tree's order did. That moved 63 points between
  regions, both ways (Fujimi to Nagano, Alfaro to La Rioja, Koshekhabl to
  Adygea are right now; Beşiri to Siirt, Villa Dolores to San Luis,
  Calimete to Cienfuegos, gmina Tarnów to the city of Tarnów are wrong
  now). It cost Taipa (Macau) and Trachóni (Akrotiri) their city, and
  flipped 38 Crimean points and 21 in An Giang between two duplicate
  polygons for the same area. The country change is Loyada, on the
  Djibouti border: Somalia's newly kept Awdal region, simplified to
  ~1.1 km, overshoots into Djibouti by a sliver `cutCountriesOutOfForeignRegions`
  samples too rarely to cut. Verify: 142 pass, 0 fail; Ter Heijde and
  Nicosia now pass. Cost: `prepare-world.ts` took 32.5 min against 17.7 min
  in the last recorded run; the fallback samples only the ~8,000 polygons
  Natural Earth drops, so most of that gap is probably not this change, but
  no baseline was rerun on the same machine state to show it.
- **Islets tagged as admin regions.** *(human error)* Some islets and rocks
  carry `boundary=administrative` + `admin_level=4` without
  `natural=coastline`, so the filter above keeps them, and the fallback now
  keeps them too when Natural Earth has them at sea. On `world-high-res.bin`:
  Mexico's region list has Isla Cerro Blanco, Isla Choyita, Isla San Cosme,
  Isla San Damian, Islote el Raicito, Islote la Lobera and Islote Montalvá
  (`place=islet`), Taiwan's has 香爐礁 (`natural=stone`). The fix is in OSM:
  the admin tags don't belong on these relations.
- **Border artifacts.** The same 10m outline problem on ordinary borders,
  always seen as one country's outline overshooting its neighbour's
  (resolved with `region -`, `city -`, since the overshooting country had
  no candidates there). Reported on `world-high-res.bin`:
  - 52.441101, 6.848860: expected Netherlands, got Germany.
  - 50.710482, 6.090031: expected Belgium, got Germany.
  - 49.947409, 6.159039: expected Luxembourg, got Germany.
  - 49.446226, 5.977764: expected France, got Luxembourg.
  - 49.533439, 5.691605: expected France, got Belgium.
  - 50.264491, 12.187872: expected Czechia, got Germany.

  The hypothesis held: the OSM correction only changed which country a
  candidate city or region was assigned to, never the country polygons,
  which were Natural Earth's. All six are fixed by the OSM outlines (item
  above), on `world-high-res.bin` and on `world.bin`.
- **Simplified region polygons dropped and misplaced cities.** Region
  polygons were simplified to 0.01° (~1.1 km) in Pass 1
  (`REGION_SIMPLIFY_TOLERANCE`, `adminBoundaryIndex.ts`), and a city gets
  its region by testing its representative point against them. Campione
  d'Italia (45.96944, 8.97361), Lombardy's ~2 km exclave inside Ticino,
  answered `Italy`, region `-`, city `-`: its part of Lombardy came out a
  10-vertex sliver that missed the comune's representative point, so the
  comune was dropped ("skipped (no region)"). The same happened on
  coastlines (Cannes, Hyères, Lipari, Valparaíso answered their region
  with no city), and simplified neighbours overlapped by up to the
  tolerance, so a border town could get the neighbour (Dordrecht answered
  Noord-Brabant). Baarle-Hertog was dropped too: 51.436574, 4.928302, in
  its largest enclave, answered `Belgium`, `Vlaanderen`, city `-`, and the
  municipality was missing from the place table. Fixed by keeping regions
  at full precision, like the country outlines (2026-10-13). That exposed a second cause: when a
  polygon's bbox midpoint is outside it, the representative point is
  turf's fallback, the nearest *vertex*, and for a border town that vertex
  is on the border, inside both regions (Trenton, NJ went to Pennsylvania,
  Lotte to Lower Saxony, Weikersheim to Bavaria). Region assignment now
  uses a point strictly inside the city instead (`interiorPoint`,
  `pointOnFeature.ts`; the representative point itself is unchanged, since
  gap-fill and country resolution use it), falling back to the vertex when
  that point is in no region of the country (Zmajevac's lands in the Danube
  strip cut out of its county for Serbia, Iligan in a hole of Lanao del
  Norte).

  Measured against the simplified build: 487 cities more and 6 fewer
  (255,233 kept; "skipped (no region)" 3,150 -> 2,642), and 328 cities
  changed region. Every one of a 45-city random sample of those moves
  that could be checked went to the right region (Manendragarh to
  Chhattisgarh, Nhamundá to Amazonas, Caniapiscau to Québec, Deglur to
  Maharashtra, ...); the rest are Bosnian villages crossing the
  inter-entity line, named `(RS)`/`(FBiH)` after the side they are on. The
  6 lost are northern Cyprus (see Cyprus). `cutCountriesOutOfForeignRegions`
  now cuts 10 regions instead of 302, the rest having been simplification
  overshoot. Cost: `regions.geojson` (27.8 MB) became `regions.geojsonseq`
  (763 MB, written and read as a sequence since it no longer fits in one
  string), and `prepare-world.ts` took 6:54 wall / 12.5 GB peak RSS on a
  busy machine, against ~2:22 unloaded before. The compressor got cheaper,
  not dearer: `world-high-res.bin` went from 75.7 MB / 166.8M records to
  73.0 MB / 159.4M (overlapping simplified regions made mixed cells that
  needed refining), and `make world-high-res` took 6:10 wall / 11.7 GB
  peak, sidecars included.
- **A city inside two overlapping regions gets whichever the R-tree returns
  first.** Fixed 2026-10-14. `assignCityRegion` (`regionPolygons.ts`) used
  to return the first region in `regionIndex`'s R-tree order whose polygon
  contains the city's point, and that order depends on the whole tree: adding
  Monaco's and the Vatican's regions moved 593 cities500 points to another
  region (Ninghe District from Tianjin to Hebei) and cost Taipa (Macau) its
  city; the city-states were kept out of the tree for that reason. It bit
  again when Slovakia's regions changed from districts to kraje: 63 places
  outside Slovakia changed region (the Crimean cities between the two
  Crimea relations, Abkhazia, New Caledonia's provinces, Shan State, where
  Kēng Tung even lost its city, and Bamako). Now of the regions of the
  city's country that contain its point the smaller bbox wins, then the
  name, so no region set elsewhere can move a city. Measured on 69,235
  cities500 places of 5,000+ against the build before the rebuilds of
  2026-10-14: outside the four countries whose levels changed, 78 changed
  region and none lost a city or changed country. Vietnam 21 (Yên Bình and
  Yên Bái moved from Lào Cai to Yên Bái province, where they are),
  Russia 44 (Crimea: the Ukrainian-named relation `Автономна Республіка
  Крим` now holds the cities of Russian Crimea, where `Республика Крым` did
  before, the smaller bbox being the Ukrainian one: both are Russian
  regions in this build and the choice between two overlapping
  relations of one place is arbitrary), New Caledonia 11 (the "(terres)"
  variants of the provinces), Myanmar 2.
- **Surrounding rural unit named after its town** *(open)*. Poland, Belarus,
  Canada, the US (Michigan), Russia (Crimea): a town or city polygon sits as
  a hole in a larger rural unit that carries the same name (`Kościan` inside
  `gmina Kościan`, `Portage la Prairie` inside `Rural Municipality of
  Portage la Prairie`). Administratively this is usually correct: the town
  is a separate municipality from the rural one around it, which is named
  after its seat. The open question is the *label*: a point in a farm field
  around Kościan answers `gmina Kościan` as its "city", which is accurate
  but reads as a different place from the town. Options, none tried: strip
  the administrative prefix for display (then the two names are identical,
  and the polygon-in-polygon suspicion above looks like a bug), keep the
  names and live with it, or let the rural unit fall back to the region
  (as the US does for unincorporated land). Needs a decision from whoever
  uses the answer (Immich shows one string). Detection by name alone is
  easy, but some pairs do not share a name: Simferopol's two units, and
  Krasnystaw's, were spotted by eye.
- **Capitals that are their own region** *(open)*. The capital is an OSM
  `admin_level` of the *region* tier, so the only polygons below it are its
  districts, or nothing. The levels cannot express this: there is no tier
  where the city appears as a city. Two shapes:
  - **Nothing below it.** Fixed 2026-10-13 by `REGION_CITIES`
    (`countryAdminLevels.ts`): a hand-reviewed list of regions that are
    legally one city and hold no other city, whose polygon
    `prepare-world.ts` also emits as a city, named after the region
    (District of Columbia as `Washington`). Listed: Wien; Minsk; Kinshasa;
    Praha; Berlin and Hamburg; Conakry; Rīga and Latvia's six other
    republic cities; Port Louis; Kuala Lumpur and Putrajaya; București;
    Moscow, Saint Petersburg and Sevastopol; Dushanbe; Kyiv; District of
    Columbia. The resolve changed by exactly those 24 cities (255,233 ->
    255,257 kept; no other region gained or lost one), and 14 capitals
    resolve now (see "Capitals."). A listed region that already holds a
    city is skipped with a warning: a region-sized city next to real ones
    wins their shared border cells (the regressions `overrides` exists
    for). Deliberately not listed: a province or district named after its
    seat (Lilongwe, Maseru, Thimphu, Gitega, Bratislava's `okres`es);
    Delhi and Dubai (a territory or emirate holding more than one town).
    Not checked yet, and likely candidates: Honiara, Port of Spain and
    Trinidad's other city and borough corporations, Banjul, Bangui,
    Djibouti, Osh, Sejong, and Botswana's city and town councils
    (Gaborone, Francistown, ...); Lithuania's city municipalities
    (`Vilniaus miesto savivaldybė`) too, with a `city` name given, since
    the region's name is not the city's.

    Measured by querying every cities500 point (235,895) on the build
    before and after: 791 answers changed. 730 are the listed regions'
    points going from `city -` to the city. The other 61, at 28 places
    elsewhere, switched between two overlapping polygons, mostly two of
    the same place: Alix -> Village of Alix (Alberta), Yalta's
    Ukrainian-era `Ялтинский городской совет` -> the Russian
    `муниципальный округ Ялта` (30 points over four Crimean councils),
    `شهر X` <-> `X` in Iran, Bamako - Koulikoro (region only) -> Bamako
    (Mali's capital, now resolving); a few between different units
    (Multan city tehsil -> Gulshan, Tamatam -> Pulap). Cause: the
    compressor takes a cell's candidates from an R-tree search
    (`candidateIndex.ts`), and on a tie (two containing polygons of equal
    area, or a max-depth cell they score the same on) the first returned
    wins (`quadtree.ts`). Adding candidates rebuilds the tree, so any such
    tie anywhere can flip. Fixed the same day by a tie-break that does not
    depend on order; see "Cities drawn twice".
    300,000 uniform random points (100,260 on land) did not change at
    all.
  - **Districts below it, under other names.** Still open: Astana
    (Kazakhstan), Sana'a and Aden (Yemen), Tashkent (Uzbekistan) and
    Yerevan (Armenia) answer one of their districts (Ashgabat was fixed by
    a duplicate relation). The districts tile the capital, so a gap-fill
    city never wins; the region would have to replace them (an
    `overrides` entry with no city level plus `REGION_CITIES`, untried).
    A city that has finer districts under a *different* name than itself
    at the city tier (Tallinn, Mexico City, Lisbon, below) is the same
    shape one tier down.
- **Cities drawn twice, with identical geometry.** *(human error)* Two OSM
  objects with the same outline, both becoming a city: 226 geometries
  shared by 453 cities, all within one region (US 80, CA 67, IR 28, RU 9,
  NA 8, HR 7, KE 5, ...). The kinds: an admin relation and a closed way
  drawn on the same line (Windhoek, Wellington CO and most US ones);
  `X` and `Village of X` / `Town of X` (Alberta: Alix, Bassano, Ponoka);
  `X` and `شهر X` in Iran; `X City Limits` (Maynardville TN), `Duplicate
  of X` (Yemen); Crimea's Ukrainian-era city councils and the Russian
  okrugs drawn over them (Yalta, Sudak, Feodosia, Simferopol), which is
  deliberate dual mapping rather than a mistake; and two differently
  named units sharing one outline (Pulap and Tamatam, Multan city tehsil
  and Gulshan).

  Only one of a pair can get the cells; the other is a place with no
  cells (`search` finds it, `locate` says `no geometry found`). Which one
  used to be the first the compressor's R-tree search returned, and any
  added candidate reshuffles that, so builds differed at these places for
  no reason (61 cities500 points when `REGION_CITIES` added 24 cities).
  Since 2026-10-13 `quadtree.ts`'s `preferred` decides: smaller area,
  then the finer tier (a city over a region drawn the same: Bamako, Mong
  La), then the lower global id, which within a region is the order of
  the `id` property (osmium's area id), so the older OSM object. That
  changed 71 cities500 points once, all at identically drawn pairs (Crimea back to
  the councils, `Duplicate of X` and `City Limits` losing to the real
  one), and made the choice independent of candidate order
  (`compressor/test/quadtree.test.ts`). No measurable cost: the four
  slowest `world-high-res` chunks took 15.2/15.2/14.1 s before and
  15.1/13.8/13.7 s after, alternated.

  `prepare-world.ts` lists every group in
  `data/02-resolved/world/duplicate-cities.tsv` (one row per city, with
  its group, region and openstreetmap.org link; osmium's area id `a<n>`
  is relation `(n-1)/2` for odd `n`, way `n/2` for even). Reporting them
  upstream, or a rule that drops the loser before the compressor (prefer
  a `place=*` tag, or the relation over the way), would remove the
  placeless records; not done. Only byte-identical geometry is found: the
  same outline written from another starting vertex is not.
- **Towns mapped only as place nodes cannot be returned.** *(unsolvable)*
  Shire (14.083301, 38.281860) and Yebokile (10.447974, 37.896309) in
  Ethiopia have no boundary relation in OSM (the whole of Ethiopia has two
  polygons finer than level 6), so the best a polygon lookup can give is
  the zone (`Semien Mi'irabawi Zone`, `East Gojjam`). A fix would mean
  adding `place=*` nodes as a nearest-point fallback, which is a design
  change, not a level pick. The same shape explains Angola and Namibia
  below, where the Voronoi fallback is the lever instead.
- **Countries without an ISO code in Natural Earth are dropped.**
  *(open)* Natural Earth's features whose `ISO_A2_EH` is `-99` (Northern
  Cyprus `CYN`, Somaliland `SOL`, the Cyprus UN buffer zone `CNM`) are not
  in the hierarchy. Their *country* answer is fixed: the outlines are OSM's
  now, and OSM draws Northern Cyprus inside Cyprus and Somaliland inside
  Somalia (the internationally recognised borders; see Cyprus and Somalia).
  Their candidates now get their country from those outlines too (see
  "Places Natural Earth puts at sea were dropped"), which fixed Somaliland
  outright: its regions and cities resolve. Northern Cyprus still answers
  the country only: its 247 municipalities now get Cyprus, but no Cyprus
  region polygon (level 6) covers the north, so `emitCity` drops each one
  for having no region.
- **Countries with a thin city tier.** The generated table lists every
  country whose chosen city level covers under 20% of it:
  AO 9.1, AZ 4.2, BB 19.6, BH 0.6, BW 18.1, BZ 5.3, CF 0.2, CV 6.3, DM 0.9,
  GE 4.3, LR 0.2, ME 9.6, MP 3.1, MV 9.7, MW 10.2, NA 0.1, QA 1.2, SX 11.7,
  TT 0.1, UG 6.4, UY 1.3, WS 0.3 (and empty city lists: BM, ER, FJ, GD, GL,
  GW, HM, KN, LC, LS, LY, MR, MS, NE, NR, PW, SC, SH, SZ, TC, VC, VG, VU).
  Egypt, Chad, Eritrea and Libya were handled with the Voronoi fallback.
  **A Voronoi hole fill** (`VORONOI_CITY_FALLBACK_HOLES`, `holeFill.ts`),
  added 2026-10-14, handles 21 more: AO, AZ, BF, BI, BW, CD, CF, GE, LR, LS,
  MR, MW, NA, NE, PH, QA, SD, SZ, TG, TT, UG. What it found: in each of
  them OSM has no relation at all for most towns (Angola's Benguela; the
  Philippines' Pagadian; Cebu province has about 20 of its 50 municipalities;
  an Overpass search for Pagadian finds schools and a fish port), so no
  `admin_level` choice can name them. The fill leaves every real city alone
  and gives each cities500 point no real city polygon contains a Voronoi
  cell, clipped to its region (a cell never crosses a region border, since
  the city's region is the one a lookup then reports) and with the real
  cities cut out. A region with no point keeps answering with the region.
  Unlike `VORONOI_CITY_FALLBACK` nothing real is replaced, and unlike a
  level choice the result is nearest-populated-place inside its region, not a
  boundary: a point is named after the nearest cities500 place that has no
  polygon (Benguela's own point, 2.8 km from the GeoNames centre, lands in
  Navegantes' cell). It needs regions that do not overlap, so Fiji and
  Bahrain (region coverage 516% and 844%) are left out; a `regionGapFill`
  region is cut down to the land its provinces leave first (PH, GE). A region
  in `REGION_CITIES` is skipped (Tbilisi is one city already). Measured
  against cities500 places of 50,000+ (named for the point's city / no city,
  before → after): AO 8/50 → 58/0, AZ 1/12 → 13/0, BF 8/7 → 15/0, BI 1/4 →
  5/0, BW 0/9 → 9/0, CD 32/28 → 60/0, CF 0/9 → 9/0, GE 0/5 → 5/0, LR 0/3 →
  3/0, LS 0/2 → 2/0, MR 1/6 → 7/0, MW 0/7 → 7/0, NA 1/3 → 4/0, NE 1/12 →
  13/0, PH 204/49 → 253/0, QA 2/3 → 5/0, SD 17/16 → 33/0, SZ 0/2 → 2/0,
  TG 1/4 → 5/0, TT 0/3 → 3/0, UG 2/39 → 40/1. No other country changed.
  Also checked: 5,000+ places and random points within half a degree of
  every cities500 point of these countries (about 40,000) kept their
  region except 38 on a region border (22 in PH, 16 in GE, cell edges).
  Fifteen capitals resolve now (see "Capitals."). Remaining open in the
  group: Togo and Liberia keep their real level-6/8 polygons (prefectures,
  "Zone 3"), which the fill does not override, so Sokodé answers
  "Tchaoudjo"; Guinea-Bissau's Bissau has no region at all, so the fill
  has no region to put a cell in; BB, BH, BZ, CV, DM, ME, MP, MV, SX, UY, WS,
  the other empty lists and the countries not in the table (the 5-20% ones)
  are not examined. *(open)*
- **Capitals.** *(open)* `verify/test/world-queries.test.ts` looks up
  the capital of every country and dependency GeoNames lists one for
  (232; `verify/src/cases.ts`'s `CAPITALS` and `OPEN_CAPITALS` tables carry the
  coordinates and the exact rule) and measured 81 resolving and 151
  not, on `world-high-res.bin` (built 2026-10-12); 96 and 136 since
  `REGION_CITIES` (2026-10-13). A capital resolves when
  the country is right and the **city** tier is named for the capital. The
  goal is a city answer: "all photos in the city of Beijing" is a city
  query, so a capital must not answer with a district inside it (Beijing
  as "Dongcheng District", Tokyo as "Shinjuku", London as "City of
  Westminster") nor only as a region (Berlin, Prague and Kyiv are in the
  region selector and never in the city one; see "What each tier is for"
  above). Each miss is one of four shapes, which are different work. (A
  fifth, **no country or the wrong one**, is gone since the OSM country
  outlines: Vatican City and Monaco resolve, and Gibraltar and the three
  atolls get their country; see "Natural Earth's outlines are too coarse".)
  - **Country only** (23): neither a region nor a city covers the point.
    Microstates and small territories (Skopje, Manila and Tbilisi left on
    2026-10-14). `CITY_STATES` (Monaco, Vatican) is the mechanism for the
    microstates among them (Andorra, Malta and San Marino were added
    2026-10-13 and are out of this list).
    The Valley (Anguilla); Oranjestad (Aruba);
    Nassau (Bahamas); George Town (Cayman Is.); Willemstad (Curaçao);
    Stanley (Falkland Is.); Port-aux-Français (Fr. S. Antarctic Lands);
    Gibraltar (Gibraltar); Bissau (Guinea-Bissau); Saint
    Helier (Jersey); Tarawa (Kiribati); Majuro (Marshall Is.); Alofi (Niue);
    Adamstown (Pitcairn Is.); Grytviken (S. Geo. and
    the Is.); Jamestown (Saint Helena); Philipsburg
    (Sint Maarten); Gustavia (St-Barthélemy); Marigot (St-Martin);
    Saint-Pierre (St. Pierre and Miquelon); Funafuti (Tuvalu); Mata-Utu
    (Wallis and Futuna Is.)
  - **The capital is only a region** (16; nine left on 2026-10-14, see "Countries with a thin city tier"): the region carries the
    capital's name and no city covers the point. This is the previous
    entry ("Capitals that are their own region"). Its `REGION_CITIES`
    took 13 capitals off this list on 2026-10-13 (Vienna, Minsk, Prague,
    Kinshasa, Berlin, Conakry, Riga, Kuala Lumpur, Port Louis, Bucharest,
    Moscow, Dushanbe, Kyiv). Bamako resolves since the same day: its city
    is drawn exactly like a second region (`Bamako - Koulikoro`), and a
    city now beats a region drawn the same (see "Cities drawn twice").
    The rest are either a province named after its seat or not checked
    yet (that entry says which).
    Hamilton (Bermuda); Thimphu (Bhutan); Praia (Cabo Verde); Yamoussoukro
    (Côte d'Ivoire); Djibouti (Djibouti); Banjul (Gambia); Vilnius
    (Lithuania); Male (Maldives); Saipan (N. Mariana Is.); Yaren (Nauru);
    Castries (Saint Lucia); Ljubljana (Slovenia); Honiara (Solomon Is.);
    Basseterre (St. Kitts and Nevis)
  - **A region around it, no city** (20; Khartoum and Lomé left on 2026-10-14; Brasília moved on 2026-10-14, see Brazil; Guernsey left on 2026-10-14, it has a city and only the spelling differed): the region is a province,
    parish or federal district (New Delhi is "Delhi"), and no city covers the point. Washington
    ("District of Columbia") was one and resolves since 2026-10-13
    (`REGION_CITIES` with a `city` name). New Delhi is not
    that simple: Delhi holds New Delhi and more.
    Manama (Bahrain); Bridgetown (Barbados); Belmopan (Belize); Road Town (British Virgin Is.); Quito (Ecuador); Suva
    (Fiji); Nuuk (Greenland); Saint George's (Grenada); New Delhi (India); Macau (Macao); Antananarivo
    (Madagascar); Plymouth (Montserrat); Ngerulmud (Palau); Kigali
    (Rwanda); Apia (Samoa); Victoria (Seychelles); Kingstown (St. Vin. and
    Gren.); Tunis
    (Tunisia); Cockburn Town (Turks and Caicos Is.); Port-Vila (Vanuatu)
  - **A district, ward or parish instead of the capital** (62; Brussels left on 2026-10-14, see Belgium): the
    country's city tier is finer than its capital (Beijing, Tokyo, Seoul,
    Bangkok, Lisbon, London and many more). The capital's own boundary
    exists in OSM for most of these, usually a level above the one the
    country is configured at; check the country's `admin_level` before
    assuming a data gap. Where the district polygons tile the capital, a
    whole-city gap-fill never wins (see Tallinn, Mexico City, Lisbon).
    Algiers (Algeria); Saint John’s (Antigua and Barb.); Buenos Aires
    (Argentina); Yerevan (Armenia); Canberra (Australia); Porto-Novo (Benin); Brasília (Brazil); Bandar Seri Begawan (Brunei); Phnom
    Penh (Cambodia); Beijing (China); Brazzaville (Congo); San José (Costa
    Rica); Havana (Cuba); Tallinn (Estonia); Accra (Ghana); Port-au-Prince
    (Haiti); Tegucigalpa (Honduras); Hong Kong (Hong Kong); Baghdad
    (Iraq); Kingston (Jamaica); Tokyo (Japan); Amman (Jordan); Astana
    (Kazakhstan); Nairobi (Kenya); Kuwait City (Kuwait); Bishkek (Kyrgyzstan); Vientiane (Laos);
    Beirut (Lebanon); Nouakchott (Mauritania); Mexico City (Mexico);
    Palikir (Micronesia); Ulan Bator (Mongolia); Maputo (Mozambique); Nay
    Pyi Taw (Myanmar); Abuja (Nigeria); Kingston (Norfolk Island);
    Pyongyang (North Korea); Muscat (Oman); Islamabad (Pakistan); Panama
    City (Panama); Port Moresby (Papua New Guinea); Lima (Peru); Lisbon
    (Portugal); Dakar (Senegal); Freetown (Sierra Leone); Singapore
    (Singapore); Mogadishu (Somalia); Pretoria (South Africa); Seoul
    (South Korea); Paramaribo (Suriname); Taipei (Taiwan); Bangkok
    (Thailand); Dili (Timor-Leste); Nuku‘alofa (Tonga); Ankara (Turkey); Charlotte Amalie
    (U.S. Virgin Is.); Abu Dhabi (United Arab Emirates); London (United
    Kingdom); Tashkent (Uzbekistan); Caracas (Venezuela); Hanoi (Vietnam);
    Sanaa (Yemen)
  - Work it from the test: `node --test verify/test/world-queries.test.ts`
    lists every miss with what it answered. When a country's config is
    fixed, move its row from `OPEN_CAPITALS` to `CAPITALS` and edit the lists
    here. The rule is deliberately strict and is not to be relaxed to make
    numbers look better: accepting a district, or a region named for the
    capital, would pass 76 more capitals and say nothing about whether the
    answer is what a user expects.

### The `place=city/town/village` tie-break tool

`place=city/town/village` was evaluated as an alternative to `admin_level`
matching and rejected for geometry (tested on the Netherlands extract: 98.5%
of matches are bare label nodes with no polygon, the same nearest-labeled-
point approach this project exists to replace; the rest are informal
`boundary=place` outlines). The tag survives as a disambiguation signal:
Bremen's original fix was found exactly this way (its `admin_level=6`
relation carries `place=city`, the `admin_level=4` Land does not).

`data-ingest/src/report-place-tag-mismatches.ts` (library
`data-ingest/src/lib/placeTagSignal.ts`) automates finding more of them. Its
own corpus scan (independent of `COUNTRY_ADMIN_LEVELS`, since filtering by
the current config would hide exactly the missing levels) groups same-
`(country, name)` relations across admin levels and flags any whose `place`
tag names a level the country's config does not already treat as a city.
Read-only: it prints candidates for hand review and a
`countryAdminLevels.ts` edit. A worldwide run found 814 candidates; 773 were
false positives of one shape (a same-named entity already resolving
correctly through a different configured level; Brazil's small
municipalities are nearly all single-district, so the district carries the
municipality's name), which `findPlaceTagMismatches` now excludes
(`alreadyResolvedAtLevel`), leaving 41 real candidates. Ten countries got a
real gap-fill fix, listed in their own sections: Cuba, Moldova, Nicaragua,
El Salvador, Luxembourg, Belarus, Canada, Latvia, Turkmenistan, Venezuela
(partial). Nine were investigated and deliberately left alone (Armenia,
Argentina, Indonesia, Burkina Faso, Czechia, Iran, and the
Estonia/Mexico/Portugal group), also in their sections. None of the fixes
were findable by the area vote alone: every one's configured level already
tessellates its country, so the bug was always grain, not coverage.

---

## Afghanistan (AF)

`region [4]`, `city [5]`.

- **Region was the district tier and city a Kabul-only tier.** Region was
  districts (384 of them) and city the Kabul-only nahia tier (0.6%). Now
  region 4 (provinces) / city 5 (districts, ~100%): Kunduz resolves to
  `Kunduz Province / Kunduz District`, Kabul to `Kabul Province / Kabul
  Municipality` (the local name `کابل ښاروالۍ`).

## Algeria (DZ)

`region [4]` (100.2%), `city [8]` (99.9%).

- **Algiers answers with a commune.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 36.73225, 3.08746 returns
  `region Algiers`, `city Kouba`. The region tier looks like the city (the
  wilaya of Algiers *is* the city), so the user suggests both tiers sit one
  level too deep (region 4 → 5, city 8 → 9 or lower). Not checked against
  the levels OSM actually has there; see "Capitals" for the shape.

## Andorra (AD)

`region []`, `city [7]` (103.5%).

- **Andorra had no region, so none of its parishes resolved.** Andorra la
  Vella answered `Andorra` with no region or city: OSM has the seven
  parishes at `admin_level=7`, but a city needs a region to sit in and
  Andorra has no region tier. Fixed by `CITY_STATES` (`countryAdminLevels.ts`,
  as for Monaco): one region, `Andorra`, covering the outline. The parishes
  became the cities (measured on `world-high-res.bin`, built 2026-10-13:
  42.50779, 1.52109 is `Andorra la Vella`, 42.54, 1.51 is `La Massana`).

## Angola (AO)

`region [4]`, `city [6]` (9.1% coverage).

`VORONOI_CITY_FALLBACK_HOLES` fills the land no real city covers.

- **Huambo resolved to its province only.** Fixed 2026-10-14.
  -12.775308, 15.732937 returned `Huambo Province` with `city -`. OSM has
  no municipality or commune relation for Huambo or Benguela (only the
  provinces at level 4, 70 relations at level 6 and few at 8), so no level
  helps; the Voronoi hole fill names the land the real cities leave
  (cities500 places of 50,000+ named 8 → 58 of 77, no city 50 → 0).
- **Benguela answers with the neighbouring cell.** *(open)* -12.600135,
  13.393707 (expected Benguela) returns `Navegantes`: the point is 2.8 km
  from the GeoNames centre of Benguela, in the cell of the nearer place
  Navegantes. That is what a Voronoi cell is, nearest populated place
  with no boundary behind it; fixing it needs the town's real outline.

## Argentina (AR)

`region [4]`, `city [5]`.

- **Place-tagged level 8 deliberately not gap-filled.** Acevedo's
  place-tagged level (8) sits three tiers below the configured level 5, and
  nationally only ~268 of 3,292 level-8 features carry a real settlement
  `place` tag (~8%, mostly `place=municipality`): the same sparse,
  inconsistent tagging as Indonesia, and the only Argentine candidate to
  survive the false-positive filter, suggesting an isolated gap.

## Armenia (AM)

`region [4]`, `city [5]`.

- **Abovyan "gap" is a display-name variant.** The tie-break tool reported
  Աբովյան (Abovyan) but it already resolves, as "Աբովյան համայնք"
  ("Abovyan community"), the real level-5 entity. The tool's exact-string
  grouping does not normalize away an administrative suffix. No change.
- **Yerevan is a level-4 region with no lower duplicate.** *(open)* Checked
  the same way as Ashgabat and Minsk; no level fixes it. See "Capitals that
  are their own region".

- **Yerevan answers with a district.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 40.17765, 44.5126
  returns `region Yerevan`, `city Kentron`. Suspected: the region slot holds
  what is really a city, so both tiers are one level too high (region 4 →
  5, city 5 → 6). The existing Yerevan entry above (no lower duplicate) is
  the evidence to re-check first.

## Austria (AT)

`region [4]`, `city [8, 6]` (98.0% at 8, gap-fill 6), `REGION_CITIES` for Wien.

- **Vienna was a region with no city.** 48.20849, 16.37208 returned `Wien /
  Vienna`, `city -`: Wien is a Land (level 4) and a municipality in one,
  with only its districts (level 9) below it. Fixed 2026-10-13 by
  `REGION_CITIES`, which emits the Land polygon as the city too (see
  "Capitals that are their own region").

- **Graz resolves to its Land only.** Fixed 2026-10-14 with `city [8, 6]`.
  47.072109, 15.436306 returned `region Steiermark / Styria`, `city -`. Not
  the England pattern: the statutory cities (Statutarstädte: Graz, Linz,
  Salzburg, Innsbruck, Klagenfurt, St. Pölten, Wels, Villach, Wiener
  Neustadt, Steyr, Krems, Eisenstadt, Waidhofen an der Ybbs) are one level-6
  relation each and have no level-8 municipality, so they are the 2.0% hole
  in the level-8 coverage (98.0%). Level 6 is also the Bezirke, which the
  point rule never adds (a Bezirk's representative point lies inside one of
  its municipalities). Of 4,000 random points in Austria, 29 changed
  against the old build, every one a statutory city that had no city before
  (Linz 4, Waidhofen 4, Villach 3, Graz 3, ...); nothing else moved. Linz,
  Salzburg, Innsbruck, Klagenfurt and St. Pölten are cases of their own.

## Azerbaijan (AZ)

`region [6]` (112.7%), `city [8]` (4.2%).

- **Baku was a region with no city.** Fixed 2026-10-14. Reported while
  improving capitals: 40.37767, 49.89201 returned `region Baku`, `city -`.
  The guess was that region and city sit one level too low. They do not:
  OSM has no level 4 for Azerbaijan, level 6 holds the 66 rayons and the
  cities of republic subordination ("Bakı İnzibati Ərazisi" and 10 more,
  137 relations in all), level 7 the Iranian-style quarters, level 8 a few
  towns (Sumqayıt), and level 9 Baku's `siəd` blocks. So the regions are
  right and the city tier is simply not mapped. The Voronoi hole fill
  (`VORONOI_CITY_FALLBACK_HOLES`) names the land the 217 level-8 relations
  leave: places of 50,000+ named 1 → 13 of 14, no city 12 → 0, Baku
  resolves.

## Belarus (BY)

`region [4]`, `city [8, 6]` (99.5% at 8, gap-fill 6), `REGION_CITIES` for Minsk.

- **Level 6 gap-fill for Baranavichy.** Level 6 holds 9 `place=city`
  relations (Belarus's major cities below the level-4 ones); 8 of them
  already resolved through an identically-named level-8 entry. Only
  Baranavichy (Баранавічы, 7th-largest city) lacked one; confirmed by
  `world.bin` resolving it to nothing before the fix.
- **Minsk is a level-4 region.** 53.9006, 27.5590 returned `Мінск /
  Minsk`, `city -`. Fixed 2026-10-13 by `REGION_CITIES`, which emits the
  region polygon as the city too (see "Capitals that are their own
  region").
- **A village council surrounds Mikashevichy.** *(open)* 52.225276,
  27.468910 resolves to `Мікашэвічы / Mikashevichy` and 52.212235,
  27.444878 to `Сінкевіцкі сельскі Савет` (Sinkevichy rural council), whose
  polygon wraps the town. Here the names do *not* match, so this is the
  "Surrounding rural unit" pattern with a differently named rural unit
  (the council is named after a village, not after the town).

## Belgium (BE)

`region [4]` (100.1%), `city [9]` (99.9%), `nameEnFromWikidata`.

- **Brussels is `Bruxelles - Brussel`, not Brussels.** Fixed 2026-10-14 by
  `nameEnFromWikidata: true`. 50.85045, 4.34878 returned
  `Bruxelles - Brussel` alone, so the capital check ("named for Brussels")
  could not match. The city is OSM relation `a40226383` at level 9, which
  was "added for completeness with a minimal set of tags": no `name:en`, no
  `int_name`. The City of Brussels at level 8 (`a116549`) has
  `name:en=Brussels`, and shares its `wikidata` tag (`Q239`) with it, but
  Belgium is not configured at level 8. With the option, Pass 1 keeps a
  small `wikidata -> name:en` record for every relation of the country that
  has both tags (candidate or not), and `finish()` gives each candidate
  without a `name:en` the one with its `wikidata`. It now answers
  `Bruxelles - Brussel | Brussels`. Opt-in per country (the borrowing is a
  data-wide change nobody measured elsewhere); only Belgium uses it. A
  `name:en` an element has itself is never replaced.

## Belize (BZ)

`region [4]` (115.9%), `city [8]` (5.3%).

- **Belmopan is a district with no city.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 17.25376,
  -88.76401 returns `region Cayo`, `city -`. City coverage is 5.3%
  nationally. The user suspects the city level is too *high* (too coarse a
  number, the places sit at a finer level). Not checked.

## Botswana (BW)

`region [4]`, `city [6]` (18.1%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city polygons for the towns.** Fixed 2026-10-14. All 9 places of
  50,000+ had a region and no city, Gaborone included (level 4 holds Gaborone
  and Francistown as regions; the 35 level-6 relations are not towns). The
  Voronoi hole fill names the land they leave: named 0 → 9 of 9, no city 9
  → 0. Gaborone resolves. Places of 5,000+: 3 → 63 of 63 named.

## Brazil (BR)

`region [4]`, `city [8]` (municipalities).

- **Major cities missing despite 66.6% city coverage.** Fixed 2026-10-14.
  Neither São Paulo nor Rio de Janeiro (the city, not the state) resolved:
  `lookup` at each city's own coordinates returned `city -`, or `Sé`, a
  distrito of São Paulo. OSM's levels in Brazil: 4 = the 27 states, 8 = the
  municípios (all of them, ~5,570), 9 = distritos, which exist only where a
  municipality has real subdivisions (10,213 relations, and the small
  municipalities' single district just carries the municipality's name).
  The old config had `city [9]`, so the metros resolved at district grain
  and every municipality without a level-9 district had no city: Teresina,
  São Luís, Timon, Imperatriz and most of Maranhão, Ceará and Piauí.
  Now `city [8]`. Measured against cities500 places of 50,000+ (765): named
  for the point's city 507 → 674 (66.3% → 88.1%), no city 232 → 0; of
  places of 5,000+ (4,423): 2,494 → 4,254 named, 1,866 → 0 without a
  city. No other country's score changed. The remaining 91 "misses" are
  GeoNames places that are districts or neighbourhoods inside a
  municipality (Vila Mariana, Copacabana, Botafogo answer "São Paulo" and
  "Rio de Janeiro"), correct at the city tier. The cost is that the
  districts of a big municipality (São Paulo's Sé, Rio's Zona Oeste) no
  longer show as the city; they are not city-grain places either.
- **Brasília answers with a district.** *(open)* -15.77972, -47.92972
  returns `region Distrito Federal`, `city Plano Piloto`. The Federal
  District has no municipalities: its level-8 relations are the
  administrative regions (regiões administrativas), Plano Piloto among
  them, and Brasília itself is not a polygon of its own. A `REGION_CITIES`
  entry is refused because the region already holds city polygons.

## Bulgaria (BG)

`region [4]` (provinces), `city [8, 5]` (settlements, municipalities fill the gaps), `primaryLevel: 8`, `coverageGapFill: [5]`.

- **Pazardzhik is a province with no city.** Fixed 2026-10-14. 42.192662,
  24.334030 returned `region Pazardzik`, `city -`. OSM's levels in Bulgaria:
  4 = the 28 provinces (oblasti), 5 = the 265 municipalities (obshtini,
  each named for its seat), 6 = the districts of Sofia, Plovdiv and Varna,
  8 = settlements (towns and villages, 2,239 relations, 46.5% of the area
  because only some settlements have a boundary), 9 and 10 = quarters. The
  old config had the municipalities as the *region* and the settlements as
  the city, so Plovdiv, Pazardzhik, Stara Zagora, Pleven and 6 more of the
  17 cities with 50,000+ people (GeoNames cities500) had no city. Now the
  provinces are the regions, the settlements stay the city where they exist
  (`primaryLevel: 8` pins them as primary: the vote would pick the
  municipalities, which cover everything, and hide Sofia, a level-8
  settlement whose municipality is "Столична"), and a municipality is added
  wherever the settlements leave at least 3 km² of it uncovered
  (`coverageGapFill: [5]`, see "United Kingdom"). Measured against
  cities500 places of 50,000+: named for the point's city 7 → 17 of 17, no
  city 10 → 0.

## Burkina Faso (BF)

`region [4]`, `city [6]` (67.2%).

- **Level-8 place-tagged candidates already resolve.** Koudougou,
  Tenkodogo, Bagaré, Lankoué and Toéni share their name with the level-6
  department containing them (departments are named after their chief
  town), so all five already resolve under their own plain name. Gap-filling
  8 in would only put a finer level in contention for cells its container
  already names correctly (the New York / Arkansas risk). Not applied.
- **Towns without a department polygon.** Fixed 2026-10-14. Of 16
  places of 50,000+ only 8 were named for their city and 7 had none: OSM's
  level-6 departments (67.2% of the country) leave towns uncovered.
  `VORONOI_CITY_FALLBACK_HOLES` names the land they leave: 15 of 16 named,
  no city 7 → 0.

## Burundi (BI)

`region [4]`, `city [6]` (25.3%), `VORONOI_CITY_FALLBACK_HOLES`.

- **Communes cover a quarter of the country.** Fixed 2026-10-14. Of 5
  places of 50,000+ one was named and 4 had none, Gitega among them. Hole
  fill: 5 of 5 named, none without a city. Gitega resolves.

## Cambodia (KH)

`region [4]` (112.3%), `city [6]` (93.2%).

- **Phnom Penh answers with a khan.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 11.56245, 104.91601
  returns `region Phnom Penh`, `city Khan Prampir Makara`. Suspected: the
  region slot already holds what is really a city, so both tiers move down
  one level (region 4 → 5? city 6 → 7?). Not checked.

## Canada (CA)

`region [4]`, `city [8, 6]` (31.4% at 8, gap-fill 6).

- **Resolved at regional-district grain, not city.** Terrace, BC used to
  resolve to `Regional District of Kitimat-Stikine`: level 6 (regional
  districts, 66.2%) auto-won the area vote over level 8 (real municipalities,
  31.4%). Overridden to level 8; measured against cities500's 3,298 Canadian
  places on a North-America-only build: level 8 name-matches 31.3%
  (1,032/3,298) against level 6's 14.8% (487), about 2.1x better, though far
  below the US's equivalent 64.0% because incorporated-place coverage is
  thinner nationally. Most remaining "misses" are not wrong (GeoNames lists
  neighbourhoods such as Abbottsfield, Aberdeen, Agincourt North, which
  correctly resolve to Beverly, Kamloops, Scarborough).
- **Guelph gap-fill.** Guelph, Ontario is `place=city` at level 6 (Ontario's
  regional-municipality tier), a single-tier city distinct from the
  level-8 municipalities. Gap-filled at 6; `search` found no Guelph before.
- **Terrace does not resolve on the current builds.** *(open)* 54.5164,
  -128.6003 returns `Regional District of Kitimat-Stikine`, although the
  entry above was verified fixed. `data/02-resolved/world/cities-filtered.geojsonseq`
  (built 2026-10-09 13:00) has no Canadian feature named `Terrace` at all
  (Toronto and Guelph are there), and both `world-high-res.bin` and
  `world-e8-d9.bin` agree, so the loss is upstream of the compressor. Not
  established whether this is a regression in data-ingest, a resolved input
  built before the relevant code, or the 2026-09-29 planet extract lacking
  the relation: see the Bremen entry under Germany for how to tell.
- **Surrounding rural municipality.** *(open)* 49.952987, -98.299484 is
  `Portage la Prairie` (the city); 49.888884, -98.170395 is `Rural
  Municipality of Portage la Prairie`. See "Surrounding rural unit".

## Central African Republic (CF)

`region [4]`, `city [8]` (0.2%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. 9 of 10 places of 50,000+ had a
  region and no city, Bangui among them (Bangui is a level-4 region with no
  city inside it). Hole fill: 9 of 10 named, none without a city. Bangui
  resolves.

## Chad (TD)

`region [4]`, `city [8]` (0.7%), in `VORONOI_CITY_FALLBACK`.

- **No city tier in OSM; synthesized from GeoNames.** See "Libya, Egypt,
  Chad and Eritrea" under Libya. N'Djamena now resolves to its own name.
- **Regions with no cities were dropped.** Chad had kept only `Ouaddaï` (the
  one region holding its 5 cities) before the region-seeding fix in the
  README; all 23 regions are there now.

## Croatia (HR)

- **Liberpolis resolves to no country.** *(false positive)* 45.77468,
  18.88007 (GeoNames' `Liberpolis`, the "capital" of Liberland) answered
  `Croatia` with Natural Earth's outline. It is Gornja Siga, a strip on the
  west bank of the Danube that neither Croatia nor Serbia claims: OSM's
  `admin_level=2` relations leave it out of both, so with OSM outlines it
  is in no country. Same shape as Bir Tawil (Egypt).

## Cuba (CU)

`region [4]`, `city [6, 8]` (97.7% at 6, gap-fill 8).

- **Santiago de Cuba gap-fill.** Santiago carries its own `place=city`
  relation at level 8, nested inside its level-6 `place=municipality` (the
  big rural municipality the unmodified config would name it). Found by the
  tie-break tool. The configured level already tessellates the country, so
  the bug was grain, not coverage.

- **Havana answers with a municipality.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 23.13302, -82.38304
  returns `region La Habana / Havana`, `city Plaza de la Revolución`. The
  user suspects region and city sit one level too high.

## Cyprus (CY)

`region [6]`, `city [8]`.

- **Northern Cyprus resolves to no country.** 35.257394, 33.731461 returned
  `country -`: Natural Earth's `N. Cyprus` (`CYN`) and the UN buffer zone
  (`CNM`) have `ISO_A2_EH` `-99`, so they were dropped. Fixed by the OSM
  country outlines (see "Natural Earth's outlines are too coarse"), whose
  Cyprus relation covers the whole island: it now answers `Cyprus`, with no
  region or city yet (see "Countries without an ISO code"). Its
  municipalities now get Cyprus, and are dropped for having no region
  instead. Six of them (Kokkina/Erenköy, Mansur, Mosfili, Pano Zodia,
  Petra, İksilodimbu) still had a region while regions were simplified,
  only because a simplified Republic-side region overshot onto them; with
  full-precision regions they are dropped like the rest (2026-10-13).

## Czechia (CZ)

`region [4]`, `city [8]` (99.3%), `REGION_CITIES` for Praha.

- **Prague is a region with no city.** 50.087382, 14.421787 returned
  `region Praha / Prague`, `city -`. Same shape as Berlin: the capital is a
  level-4 region. Fixed 2026-10-13 by `REGION_CITIES`, which emits the
  region polygon as the city too (see "Capitals that are their own
  region").
- **Place-tagged level-10 villages deliberately not gap-filled.** Level 8
  (`place=municipality`/`city` where tagged) already resolves every sampled
  case, including Brno and all 6 same-named "Babice" municipalities. The
  1,065 of 3,307 level-10 features that are `place=village` look like
  cadastral villages nested inside an already-correct municipality (the
  New York / Arkansas risk: a finer level contesting its container's cells
  for no naming benefit). The one survivor of the strict filter, Petřkovice,
  is a `place=borough` at level 9 inside Ostrava, not a standalone
  settlement.

## Democratic Republic of the Congo (CD)

`region [4]`, `city [6]` (42.6%), `REGION_CITIES` for Kinshasa.

- **Kinshasa was a region with no city.** -4.32758, 15.31357 returned
  `Kinshasa`, `city -`: Kinshasa is a city-province, with nothing at level
  6 inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits the
  province polygon as the city too (see "Capitals that are their own
  region"). The polygon includes the rural Maluku commune in the east,
  which is legally part of the city.
- **Cities outside the 42.6% of level-6 polygons.** Fixed 2026-10-14. 81
  places of 50,000+: named 32 → 60, no city 28 → 0 by
  `VORONOI_CITY_FALLBACK_HOLES`.

## Egypt (EG)

`region [4]`, `city [6]` (0.1%), in `VORONOI_CITY_FALLBACK`.

- **No city tier in OSM; synthesized from GeoNames.** See Libya. Cairo's
  exact GeoNames coordinate resolved to `Cairo`, but central Cairo
  (30.0444, 31.2357) resolves to the district `Būlāq Abū al ‘Ilā`, a real,
  separate Cairo district also in cities500: expected Voronoi nearest-site
  behaviour, not a bug.
- **Regions with no cities were dropped** (Egypt had 27 region polygons and
  lost them all; fixed, see the README).
- **21.869146, 33.739014 resolves to no country.** *(false positive)* That
  is Bir Tawil, the disputed strip that neither Egypt nor Sudan claims
  (its coordinates are 21°52′N 33°44′E). "No country" is correct. Natural
  Earth leaves it unassigned and so do we. The case in `verify/src/cases.ts`
  expects no country (`NONE`); it used to expect Egypt or Sudan as an open
  `todo`, which contradicted this entry.

## El Salvador (SV)

`region [5]`, `city [6, 7]` (101.3% at 6, gap-fill 7).

- **Gap-fill 7 for the `place=city/town` tier.** Level 6 is
  `place=district`/`municipality` (the real admin tier; Santa Ana, the
  second city, is `place=district`), and a separate same-named level-7
  relation is `place=city`/`town` (Santa Ana itself, Acajutla, and 38 of
  the 40 the tool found).
- **San Salvador has no level-7 relation.** *(open)* Only levels 6 and 4
  exist, so no level fixes it; same shape as Berlin. See "Capitals that are
  their own region".

## Eritrea (ER)

`region [4]`, `city []` (0%), in `VORONOI_CITY_FALLBACK`.

- **No city tier in OSM; synthesized from GeoNames.** See Libya. Asmara
  resolves to its own name.

## Estonia (EE)

`region [6]`, `city [9]` (94.6%).

- **Tallinn is not a city.** *(open)* Tallinn is `place=city` at level 8,
  distinct from the configured level 9's ~4,821-feature tessellation
  (asustusüksus settlement units). It looked like a clean small-set fix (59
  level-8 features: 48 `place=civil_parish` plus Tallinn) and was applied as
  `city: [9, 8]`; a real rebuild showed no effect and it was reverted.
  Tallinn's linnaosad (districts) are themselves tagged at level 9, already
  primary, so Tallinn's area is covered by its own already-primary children
  before the gap-fill runs; `createGapFillTracker` only promotes a candidate
  whose representative point is not already covered by a primary. `search`
  for "Tallinn" finds nothing; only `Põhja-Tallinna linnaosa` and its siblings
  resolve. The same shape as Mexico and Portugal below (a settlement whose
  finer subdivisions already tile it under different names). It would need a
  mechanism the primary/gap-fill model lacks: a named polygon overriding the
  label for cells its own primary children cover.

## Eswatini (SZ)

`region [6]`, `city []`, `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. Both places of 50,000+ had no city
  (Mbabane is a region named after its seat); hole fill: 2 of 2 named.
  Mbabane resolves.

## Ethiopia (ET)

`region [4]`, `city [5]`.

- **Wrong tiers.** Region was the zone tier and city the woreda tier (12.6%
  coverage), so most of the country had no city. Now region 4 (regional
  states) / city 5 (zones, ~100%): Shire -> `Tigray / Semien Mi'irabawi
  Zone`, Yebokile -> `Amhara / East Gojjam`, Addis Ababa -> `Addis Ababa /
  Addis Ababa`.
- **Shire and Yebokile are place nodes only.** *(unsolvable)* See
  "Towns mapped only as place nodes".

## France (FR)

- **Suburbs do not beat their city.** 43.745057, 7.214584 (Bellet, a
  quarter of Nice) resolves to `Nice`, not `Bellet`, on
  `world-high-res.bin`. Spot-check in `verify/src/cases.ts`.

## Georgia (GE)

`region [6]` (municipalities), `regionGapFill: [4]`, `city [8]` (4.3%), `REGION_CITIES` for Tbilisi, `VORONOI_CITY_FALLBACK_HOLES`.

- **Khobi Municipality had no city.** Fixed 2026-10-14. 42.316670,
  41.903229 returned `Khobi Municipality`, `city -`. OSM's levels in
  Georgia: 4 = the mkhare (regions, and Tbilisi, tagged `place=city`), 6 =
  the municipalities (172 relations, the big cities Kutaisi and Batumi
  among them), 8 = a few towns (4.3%). So the municipalities are the
  right region tier and the towns have no polygons; the Voronoi hole fill
  names the land they leave (places of 50,000+ named 0 → 5 of 5).
- **Tbilisi had no region or city.** Fixed 2026-10-14. 41.69143, 44.83412
  returned the country only. Tbilisi is a level-4 relation and no
  municipality (level 6) holds it, so a city there had no region and was
  dropped. `regionGapFill: [4]` makes the mkhare regions too (where they
  overlap the municipalities the municipality wins), which gives Tbilisi
  its region, and `REGION_CITIES` emits the region polygon as its city (the
  fill skips a `REGION_CITIES` region). 16 of about 1,200 random points
  near Georgian places changed region: cells on municipality borders and
  the Abkhazia relations.

## Germany (DE)

`region [4]`, `city [8, 6]` (97.8% at 8, gap-fill 6), `REGION_CITIES` for Berlin and Hamburg.

- **A city-state exclave is its own state.** Neuwerk, 53.948004, 8.404541,
  is Hamburg's, 100 km from Hamburg in the Wadden Sea off Cuxhaven, and
  resolves `Germany / Hamburg / Hamburg`, which a fixed case now pins.
  Hamburg, Berlin and Bremen are states and cities at once (see "Capitals
  that are their own region").

- **Bremen is a city-state with a second relation.** Germany's three
  city-states are `admin_level=4`, the same level as every other Land, so
  they lost the city slot to the region tier. Bremen has a separate
  `place=city` relation at level 6 for the city itself, and `DE: { city:
  [8, 6] }` gap-fills it. Verified at the time that it leaked no Landkreis
  name into normal cities (Munich, Cologne, Frankfurt, Hannover unchanged).
- **Suburbs do not beat their town.** Saarburg (not Kahren), Merzkirchen
  (not Körrig, not Südlingen), Wadern (not Lockweiler) and Morbach (not
  Morscheid-Riedenburg) resolve to the town on `world-high-res.bin`;
  spot-checks in `verify/src/cases.ts`.
- **Bremen does not resolve on the current builds.** *(open)* 53.079296,
  8.801694 returns `region Bremen`, `city -`, and
  `data/02-resolved/world/cities-filtered.geojsonseq` (built 2026-10-09
  13:00) has no German feature named `Bremen`. `world-high-res.bin`
  (2026-10-10) and `world-e8-d9.bin` agree because both were compressed from
  that input; `world.bin` is not present in this checkout (the other
  worktree's, from 2026-09-28, predates the fix). Same symptom as Reading,
  Brighton, Bristol and Terrace, all gap-fill or otherwise missing entries;
  Guelph (level-6 gap-fill) and Westminster (level-8 gap-fill) are present.

  **Not established:** whether this is a regression, or just a resolved
  input built before the code that fixes it. The input is only one minute
  older than the last merge touching `data-ingest` (`337f74e`), which is not
  conclusive. To tell: re-run `prepare-world.ts` with the current code and
  check whether `Bremen` appears (a full run, see PIPELINE-STAGES.md), or
  scratch-script the extract for the level-6 relation first. If it is a
  regression, candidates to bisect are `20eba2c` (stream primaries instead
  of batching), `9c6a89a` (OSM country borders) and `15fb005` (UK/Ireland
  grain). Rebuild before trusting any "regressed" label here.
- **Berlin and Hamburg are regions with no city.** 52.520008,
  13.404954 and 53.551086, 9.993682. Confirmed: neither has a second,
  lower-level relation anywhere in the German extract, unlike Bremen.
  Fixed 2026-10-13 by `REGION_CITIES`, which emits the Land polygon as the
  city too (see "Capitals that are their own region"). Bremen is not
  listed: the Land holds Bremerhaven, and the city of Bremen has a
  relation of its own (see the entry above).
- **Border artifacts** on the Dutch, Belgian, Luxembourg and Czech borders.
  Fixed by the OSM country outlines: see "Border artifacts".

## Guinea (GN)

`region [4]`, `city [6]` (100.4%), `REGION_CITIES` for Conakry.

- **Conakry was a region with no city.** 9.53795, -13.67729 returned
  `Conakry`, `city -`: the capital is its own region, with nothing at level
  6 inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits the region
  polygon as the city too (see "Capitals that are their own region").

## India (IN)

`region [4]` (100.2%), `city [6]` (97.4%).

- **New Delhi resolves to Delhi only.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 28.62137, 77.2148
  returns `region Delhi`, `city -`. The user reads it as another London:
  only the capital is affected. See "A region around it, no city" under
  "Capitals".

## Indonesia (ID)

`region [4]`, `city [5]`.

- **Place-tagged level 7 deliberately not gap-filled.** The place-tagged
  level sits two tiers below the configured level 5 via an untagged level-6
  district, and covers ~696 of Indonesia's ~75,000 villages (6,859 level-7
  features, most untagged or `neighbourhood`/`subdistrict`). Gap-filling
  would promote an arbitrary subset to city grain while leaving the rest at
  regency level, a patchier result than the consistent level 5.

## Iran (IR)

`region [4]`, `city [7]` (104.4%).

- **Place-tagged candidates are Tehran neighbourhoods.** The configured
  level already resolves every sampled case; the tagged ones nest inside an
  already-correct level-7 entity (the CZ noise shape, same contested-cells
  risk). Not applied.

## Ireland (IE)

`region [6]`, `city [8, 7]`.

- **Level 10 was 51,414 townlands.** Galway resolved to `Townparks`. Now the
  98 municipal districts at level 8 are primary (97% of the land) and the
  level-7 `place=city` relations (Dublin, Cork) gap-fill, since no district
  covers them. Names are OSM's: `The Municipal District of Kilkenny City`,
  `The Municipal District of Clane — Maynooth`.

## Japan (JP)

`region [4]` (204.2%), `city [7]` (185.5%).

- **Tokyo answers with a ward.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 35.6895, 139.69171 returns
  `region Tokyo`, `city Shinjuku`. Suspected: what is in the region slot
  looks like cities, so region and city need to move down a level. Coverage
  is over 180% at both levels, which means overlapping candidates; worth
  checking that before changing a level.

## Jersey and Guernsey (JE, GG)

- **Natural Earth's outlines are 47 and 59 vertices.** Fixed: the country
  outlines are OSM's now (see "Natural Earth's outlines are too coarse").
  Saint Helier still answers `Jersey` with no region or city, one of the
  "Country only" capitals.

- **`St Peter Port` is not `Saint Peter Port`.** Fixed 2026-10-14, in the
  matcher. 49.45981, -2.53527 returns `city St Peter Port`, which *is* the
  capital, but the capital check wanted the word `Saint`. `verify/src/evaluate.ts`
  now folds `St`, `St.` and `Saint` to one word before comparing, so Guernsey
  passes (it was listed under "A region around it, no city" but already had
  a city) and so will Jersey's `Saint Helier` (`St Helier`) once that
  resolves a city at all (it is "Country only", see "Capitals"). The data
  keeps the names OSM gives; only the check treats them as equal.

## Kazakhstan (KZ)

`region [4]`, `city [6]`.

- **Astana resolves to a city district.** *(open)* 51.142310, 71.433792
  returns `region Астана / Astana`, `city Есіл ауданы / Esil district`. The
  republican cities are level-4 regions, so the only thing below is the
  city's own districts. See "Capitals that are their own region".

- **Region and city may sit one level too high.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. The user
  suspects what is in the region slot is already cities; the Astana entry
  above is the visible symptom (51.1801, 71.44598 returns `region Astana`,
  `city Bayqoñır district`). Not checked against OSM's levels.

## Kosovo (XK)

`region [5]` (the 7 districts), `city [6]` (the 38 municipalities).

- **Cities are missing.** Fixed 2026-10-14 by swapping the two tiers. 42.67272,
  21.16688 returned `region Municipality of Pristina`, `city -`. The config
  had the municipalities (level 6, 38 of them, "Komuna e Prishtinës /
  Opština Priština") as the region and the 7 districts (level 5, "Rajoni i
  Prishtinës") as the city, and since the city is never finer than its
  region, most places got no city. Measured against cities500 places of
  50,000+: named for the point's city 4 → 9 of 9, no city 5 → 0.

## Laos (LA)

`region [4]`, `city [6]`.

- **Region was a district tier, not a province tier.** See Uzbekistan,
  which has the identical story. The generated `region: [6]` was only
  considered because level 6 was the only level listed for the country. Level
  4 is Laos's 18 provinces (100.7%); freed level 6 (148 muang, 100.8%) as a
  real city tier (Pakse resolves to `ເມືອງປາກເຊ`, Pak Sé District), where the
  city had previously been forced onto a 0.2%-coverage level 7.

- **Vientiane answers with a district.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 17.96667, 102.6
  returns `region Vientiane Prefecture`, `city Chanthabuly District`.
  Suspected: both tiers a level too high (what is in the region slot looks
  like cities). Not checked.

## Latvia (LV)

`region [5]`, `city [8, 7]` (98.0% at 8, gap-fill 7), `REGION_CITIES` for the seven republic cities.

- **Real towns are at level 7, not 8.** Latvia tags its town tier with
  `border_type=town` (72 of 75 level-7 features) and no `place` value, so
  the tie-break tool's `place`-only filter could not see it; found by manual
  investigation. The configured level 8 is `place=civil_parish`/`parish` (511
  of 1,678 level-8 features), the rural tier, so Aizkraukle and Koknese
  resolved to "Aizkraukles pagasts" / "Kokneses pagasts". Level 7 gap-fills
  the real towns (Aizkraukle's level-9 village bbox sits inside its level-7
  town polygon).
- **Rīga and the other six republic cities.** They are
  `border_type=city` at level 5, the country's own region level, so no
  level choice fixes it. Fixed 2026-10-13 by `REGION_CITIES` for all seven
  (Rīga, Daugavpils, Jelgava, Jūrmala, Liepāja, Rēzekne, Ventspils), which
  emits each region polygon as the city too (see "Capitals that are their
  own region").

## Lesotho (LS)

`region [5]`, `city [10]` (0.0%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. Both places of 50,000+ had no
  city (Maseru is a district named after its seat). Hole fill: 2 of 2 named.
  Maseru resolves.

## Liberia (LR)

`region [6]`, `city [8]` (0.2%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. Hole fill: places of 50,000+ named
  0 → 3 of 5, no city 3 → 0. Monrovia resolves. *(open)* The other two are
  Gbarnga and Ganta, which answer `Zone 3` and `Zone 4`: real level-8
  relations (zones of a town, 0.2% of the country) win the land, and the
  fill never overrides a real polygon.

## Libya (LY)

`region [4]`, `city []` (0%), in `VORONOI_CITY_FALLBACK`.

- **Libya, Egypt, Chad and Eritrea had no city tier, fixed with a Voronoi
  fallback synthesized from GeoNames.** Tripoli, Cairo, N'Djamena and
  Asmara all resolved to `city -`: a genuine, confirmed absence of city-tier
  OSM administrative polygons (0 to 0.7% coverage), not a wrong level, so
  no `admin_level` choice could fix it. `voronoiFallback.ts`'s
  `buildCityFallback` takes the country's `cities500.txt` points as sites
  (`d3-delaunay`, clipped to a bbox, then to the real outline with
  `@turf/intersect`), giving every point in the country a city that follows
  local point density. A synthesized city still resolves to its real region
  (`prepare-world.ts` routes it through `assignCityRegion`/`emitCity`).
  Deliberately a real tessellation rather than a fixed-radius buffer: buffers
  overlap in dense areas and leave gaps in sparse ones, so a point between
  two buffers would fall through to the region (the nearest-labeled-point
  failure mode this project exists to fix). Every cities500 point is a
  site, unfiltered by population, matching the granularity of real OSM city
  polygons. Opt-in only, same philosophy as `COUNTRY_ADMIN_LEVELS`. Verified
  on a scoped Africa build.
- **Libya's regions were dropped** before region-seeding (23 polygons);
  fixed, see the README.

## Luxembourg (LU)

`region [6]`, `city [8, 9]` (100.8% at 8, gap-fill 9).

- **Level 9 `place=village` gap-fill.** 409 level-8 communes against 271
  level-9 features nationally, 84 of which are `place=village` (the rest
  suburb/hamlet/neighbourhood). Each of the 14 the tool found is a clean
  same-name pair (Beckerich, Dippach, Mamer have an untagged level-8 commune
  and a `place=village` level-9 relation nested inside it), unlike
  Indonesia/Czechia where it would help an arbitrary subset.
- **Border artifact against Germany and France.** *(open)* See "Border
  artifacts": 49.947409, 6.159039 resolves to Germany instead of
  Luxembourg; 49.446226, 5.977764 resolves to Luxembourg instead of France.

## Malawi (MW)

`region [4]`, `city [5]` (10.2%), `VORONOI_CITY_FALLBACK_HOLES`.

- **Few city polygons.** Fixed 2026-10-14. All 7 places of 50,000+ had a
  region and no city, Lilongwe among them. Hole fill: 7 of 7 named. Places of
  5,000+: 4 → 33 of 34. Lilongwe resolves.

## Malaysia (MY)

`region [4]`, `city [6]` (100.8%), `REGION_CITIES` for Kuala Lumpur and
Putrajaya.

- **The federal territories had no city.** Kuala Lumpur (3.1412,
  101.68653) returned `Kuala Lumpur`, `city -`, and so did Putrajaya: each
  is a federal territory at the region level with nothing at level 6
  inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits each
  territory polygon as the city too (see "Capitals that are their own
  region"). Labuan, the third, is an island territory whose town
  (Victoria) is not the whole of it, and is not listed.

## Malta (MT)

`region []`, `city [8]` (97.0%).

- **Malta had no region, so none of its local councils resolved.** Valletta
  answered `Malta` with no region or city. Same cause and fix as Andorra:
  `CITY_STATES` gives it one region, `Malta`, and the `admin_level=8` local
  councils become the cities (measured on `world-high-res.bin`, built
  2026-10-13: 35.89968, 14.5148 is `Il-Belt Valletta | Valletta`, 36.044,
  14.2397 `Ir-Rabat | Victoria`, on Gozo).

## Mauritania (MR)

`region [4]`, `city [6]` (0.0%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. Places of 50,000+: named 1 → 7 of 9,
  no city 6 → 0. (Nouakchott, a region of its own, is still a district in
  the capital list.)

## Mauritius (MU)

`region [4]`, `city [8]` (95.7%), `REGION_CITIES` for Port Louis.

- **Port Louis was a region with no city.** -20.16194, 57.49889 returned
  `Port Louis`, `city -`: the capital is its own district, with nothing at
  level 8 inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits the
  district polygon as the city too (see "Capitals that are their own
  region").

## Mexico (MX)

`region [4]`, `city [6]`.

- **Ciudad de México is not a city.** *(open)* The federal entity is
  `place=state` at level 4, the country's region level, and has a second
  whole-city `place=city` relation at level 8 (population 9,209,944). It
  looked fixable as `city: [6, 8]` (the Ashgabat shape) and was applied, but
  the capital's alcaldías (Iztacalco, Xochimilco, Milpa Alta, Tláhuac, ...)
  are tagged at level 6, already primary, so the gap-fill candidate is
  rejected every time. Reverted. See Estonia for the same shape.
- Conkal, Espinal, Piedras Negras and Tulum (the other four candidates)
  already resolve through identically-named level-6 entries.

## Moldova (MD)

`region [4]`, `city [8, 9]`.

- **Bălți.** It is `place=city` at level 9 inside an unnamed level-8
  container; Chișinău is `place=city` at level 8 and unaffected. Gap-fill 9.
  Level 8 communes tessellate at 100.4%, so the area vote never surfaced it.

## Monaco (MC)

`region []`, `city [8]` (78.2%).

- **Monaco resolves to France.** 43.730840, 7.421372 (inside the
  principality) returned `France / Provence-Alpes-Côte d'Azur`, `city -`.
  Natural Earth's Monaco is a 12-vertex shape shifted west: it covered
  French land around Cap-d'Ail and La Turbie and missed this point, which
  no country polygon contained at all. Fixed in two steps. The OSM country
  outlines (see "Natural Earth's outlines are too coarse") draw Monaco
  where it is, and Cap-d'Ail and La Turbie went back to France. Monaco is
  then in `CITY_STATES` (`countryAdminLevels.ts`): a city-state gets a
  region covering its whole outline, so the point reads `Monaco / Monaco /
  Monaco` -- someone filtering on the city field looks for Monaco there.
  The city is OSM's own `admin_level=8` "Monaco" relation (`place=city`),
  which was dropped before for having no region to sit in. All of that is on
  `world-high-res.bin`; on `world.bin` a leaf cell (about 1.8 km by 1.2 km)
  is the size of Monaco, and the capital's point answers Beausoleil, whose
  city polygon covers more of that cell (the Vatican answers Rome there for
  the same reason).

## Mongolia (MN)

`region [4]` (100.0%), `city [6]` (100.1%).

- **Ulaanbaatar answers with a district.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 47.90771,
  106.88324 returns `region Ulaanbaatar`, `city Bayangol`. The user is not
  sure, but thinks the region and city levels need to be lower. Not
  checked.

## Namibia (NA)

`region [4]`, `city [8]` (0.1%).

- **Okahandja resolved to its region only.** Fixed 2026-10-14.
  -21.979981, 16.910706 returned `Otjozondjupa Region`, `city -`. City
  coverage is 0.1%, so Namibia has no real city tier; the Voronoi hole fill
  (`VORONOI_CITY_FALLBACK_HOLES`) names every cities500 place's land
  (places of 50,000+ named 1 → 4 of 4).

## Netherlands (NL)

`region [4]`, `city [10]` (110.8%).

The reference country: `data/03-final/zuid-holland.bin` is filtered from the
worldwide resolved data (`make netherlands`) and
`compressor/test/zuid-holland-queries.test.ts` pins the known cases:

- 52.488789, 4.794346: Wormerveer, not Zaandijk.
- 52.034656, 4.388124: Den Haag, not Nootdorp.
- 51.970738, 4.123725: Europoort, not Hoek van Holland.
- 52.333399, 5.237517: Almere, not Huizen.
- 52.131565, 5.277514: Soest, not Soesterberg.

- **A German region covered the Dutch Dollart.** Fixed 2026-10-14.
  53.653388, 6.440220 and 53.653363, 6.486011 are in the Netherlands'
  outline only (the final outlines are disjoint; OSM's `admin_level=2`
  relations of both countries overlap there) but answered `Germany /
  Niedersachsen`, in a string of cells between 6.44 and 6.49 that flipped
  between the two countries (tile 11/1060/660). Not the compressor's
  crossing rule (the same answer with the older quadtree, checked on chunk
  13122): the Niedersachsen *region* polygon reaches into the water, and
  where it and the Dutch country polygon both contain a cell, the smaller
  one (the region) wins. `cutCountriesOutOfForeignRegions` already cut a
  country out of a foreign region where `ownerAt` (Natural Earth) names the
  country; at sea it names nobody, and those overlaps were deliberately left
  alone. They no longer are: a sampled point is counted for the outline it
  was sampled from. 13 regions are cut now (10 before): Niedersachsen by the
  Netherlands, Santa Cruz (AR) by Chile, Osječko-baranjska by Serbia, a
  Myanmar district by Thailand, three Slovenian Voronoi regions by Italy,
  Croatia and Austria, and a South Sudan state by Sudan. 30,000 random world
  points: no change.

- **Lelystad is huge.** *(false positive)* 52.683459, 5.295410 (open water
  off Enkhuizen, near the Houtribdijk) genuinely resolves to Lelystad, not
  Enkhuizen or generic Flevoland. Lelystad's official municipal boundary is
  765 km² but only about 230 km² is land; the rest is IJsselmeer and
  Markermeer water under its jurisdiction. Any lookup that tests which polygon contains the point agrees on this;
  only a nearest-labeled-point lookup (Immich's current one) disagrees,
  because it picks the physically closest label. Shows up
  in the "unusually sized records" search, and is not a bug.
- **Baarle-Hertog's Belgian enclaves resolved to NL and were dropped.**
  Fixed by `withOsmCountryBorders` (Natural Earth's 10m outline has no
  enclaves). The country polygons are OSM's now, enclaves included, and
  the enclaves are cut out of Noord-Brabant's simplified region polygon
  (and Baarle-Nassau's out of Vlaanderen); see "Natural Earth's outlines
  are too coarse". The enclaves then answered Belgium and Vlaanderen but
  no city until regions were kept at full precision (see "Simplified
  region polygons").
- **Border artifact against Germany.** 52.441101, 6.848860 returned
  Germany. Fixed by the OSM country outlines: see "Border artifacts".
- **A village that crosses a municipal border is two places.**
  *(false positive)* `search ansen` lists Ansen (Drenthe) twice, as ids
  179687 and 179692; Alteveer (Drenthe) too, 52.6829, 6.4778 (De Wolden,
  179701) and 52.6842, 6.4998 (Hoogeveen, 179714), which Google Maps also
  draws as two polygons. Kept as is, decided 2026-10-11: a place here is an
  administrative unit, and these are two units that happen to share a name.
  Measured on `world-high-res.bin` and the `planet-latest-admin.geojson`
  it was built from:
  - Each village is two `admin_level=10` relations, both `source=BAG` with
    the same `name`. Ansen is 3104 (Westerveld) and 3161 (De Wolden),
    `ref:woonplaatscode`. The BAG's municipal woonplaats regulations make
    woonplaats boundaries coincide with municipal ones, so a village
    straddling the border is two woonplaatsen by design.
  - They are separate places in the source too. Alteveer's halves are in
    different municipalities and carry different `wikidata` (`Q2473000`,
    `Q2289052`); Ansen's carry the same one (`Q1766685`), so shared
    wikidata is no rule either way.
  - Merging was considered and rejected. There is no safe rule: the same
    shape occurs across region and country borders (Texarkana TX/AR,
    Karesuando/Karesuvanto, Baarle-Nassau/Baarle-Hertog, the two
    Rheinfeldens), where merging would be wrong, and any rule loose enough
    to catch Alteveer needs exceptions. The visible cost is one extra row in
    a search; a lookup shows the same "Ansen, Drenthe, Netherlands" for
    both ids, and a consumer can dedupe on the displayed name, region and
    country.
  - The Dutch city tier has 39 `(name, region)` pairs that occur more than
    once; 28 are adjacent polygons (polygons sharing border vertices) of
    this kind: Ansen, Alteveer, Ruinen, Pesse, Spier, Stuifzand,
    Tiendeveen, Hoogersmilde, Nieuweroord, Koedijk, Oudkarspel, Ursem,
    Purmer, Biervliet, Kloetinge, Buurmalsen, Zennewijnen, Hoenderloo,
    Klarenbeek, Loo Gld, Mastenbroek, Kloosterhaar, Sibculo,
    Borgercompagnie, Startenhuizen, Vinkel, Zevenbergschen Hoek,
    Deurningen. The other 11 are different villages that share a name
    (Beek, Nes, Oudega, Heusden, ...; 9 km to 70 km apart).
  - Worldwide, over `cities-filtered.geojsonseq` (252,735 cities), 4,408
    groups share country, region and name; in 424 at least two polygons
    share a border vertex (United States 147, Canada 72, Puerto Rico 32,
    Netherlands 28, Brazil 9, Indonesia 9). Not looked through; an upper
    bound for how common this is, which is the point.
  - Spot-check: 52.795652, 6.367950 (inside 3104, Westerveld) resolves to
    179687 and 52.782611, 6.333693 (inside 3161, De Wolden) to 179692, as
    the polygons say.
  - Related but not the same thing: 52.797867, 6.353445 is geometrically
    inside De Wolden's Ansen (3161) but resolves to Westerveld's (3104),
    because its ~300 m cell is mostly 3104 and a cell holds one answer.
    That is ordinary border resolution, and harmless here since the names
    are identical.
- **Ter Heijde was missing; its coast resolved to Monster.**
  52.030172, 4.168013 resolved to Monster (Westland, Zuid-Holland) instead
  of Ter Heijde. Found 2026-10-12; it was missing from every build still
  around (the oldest 2026-09-22). Ter Heijde is an enclave: in
  `planet-latest-admin.geojson` it is `a2721331` (`admin_level=10`,
  `source=BAG`, woonplaatscode 2663), one ring that is exactly the only hole
  in Monster's `a2721333`. That was not the problem, though. It never
  reached the compressor: Natural Earth's coastline runs inland of the
  whole village, so all 20 interior samples were at sea and Pass 1 dropped
  it as "no country". Fixed by sampling such polygons against the drawn
  country outlines (see "Places Natural Earth puts at sea were dropped").
  Resolves on `world-high-res.bin` and `zuid-holland.bin`; on `world.bin`,
  whose ~1.8 x 1.2 km cells are larger than the village (0.12 km²), it
  still answers Monster, like Monaco and the Vatican there.

## Nicaragua (NI)

`region [4]`, `city [6, 10]` (128.1% at 6, gap-fill 10).

- **León, Matagalpa and Jinotepe.** Each has a real `place=city`/`town`
  relation at level 10 nested inside its level-6 `place=municipality`,
  distinct from the far more numerous non-settlement level-10 features
  (hamlets, isolated dwellings, neighbourhoods), which the tie-break
  signal's own `place` filter excludes by tag rather than by level.

## Niger (NE)

`region [6]`, `city [8]` (0.0%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. Places of 50,000+: named 1 → 13 of
  13, no city 12 → 0.

## North Macedonia (MK)

`region [7]` (municipalities), `city [8]` (settlements).

- **Region tier removed by hand.** Reverted 2026-10-14. The only level
  4/5/6 candidate was "Град Скопје" (City of Skopje, 2.3%), one
  municipality's boundary that happens to carry a lower admin level, not a
  region tier, so the region list was set to `[]`. That was the bug: a city
  with no region is dropped (`emitCity`'s "no region, no city" rule, the
  reason Slovenia has a Voronoi region fallback), so *no* North Macedonian
  city resolved (0 of 9 cities500 places of 50,000+), however good the
  level-8 settlements were. The municipalities (level 7, "Општина …", about
  80) are the region tier; level 8 stays the city. 0 → 7 of 9 named, no
  city 9 → 1.
- **41.432573, 22.011393 returns only the country.** Fixed 2026-10-14 by the
  region tier above (the reported cell had a level-8 settlement all along).

- **Skopje has neither region nor city.** Fixed 2026-10-14 by the region tier
  above. 41.99646, 21.43141 returned the country only.

## Pakistan (PK)

`region [4]` (103.6%), `city [7]` (102.0%).

- **Islamabad answers with a zone.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 33.72148, 73.04329
  returns `region Islamabad Capital Territory`, `city Zone 1`. The user
  says it is not clear what is going on. Not investigated.

## Philippines (PH)

`region [4]` (provinces), `regionGapFill: [3]`, `city [6]` (municipalities and cities, 113.8%).

- **Metro Manila and the independent cities had no city.** Fixed
  2026-10-14. Manila, Quezon City, Taguig, Zamboanga City, Tacloban, Olongapo
  and 45 more of the 284 GeoNames places (cities500) of 50,000+ answered with
  no region and no city. OSM's levels: 3 = the 17 regions (Metro Manila
  among them), 4 = the 81 provinces, 5 = Metro Manila's four districts, 6 =
  municipalities and cities, 10 = barangays. Metro Manila and the highly
  urbanized and independent cities are not in any province, so the level-4
  polygons have holes there, no region contained those cities and a city
  with no region is dropped. New option `regionGapFill: [3]`: the level-3
  regions are regions too, and a province, being smaller, wins wherever
  both cover the cell, so a region name shows only on land no province
  covers (Metro Manila, the holes of Zamboanga City, Tacloban, Iligan, Baguio).
  Measured against cities500 places of 50,000+: named for the point's city
  170 → 204, no city 100 → 49. No other country changed. Manila (the
  capital) resolves. All 17 level-3 regions enter the hierarchy; one with
  no bare land never wins a cell.
- **Municipalities with no OSM polygon.** Fixed 2026-10-14 by
  `VORONOI_CITY_FALLBACK_HOLES`. The 49 places left with no city (Toledo,
  Talisay and Naga in Cebu, Pagadian, Sorsogon, Santiago, Laoag, Jolo,
  Surigao, Borongan, ...) had a province and no city: OSM has no
  administrative relation for them. Level 6 holds 908 relations for the
  Philippines' ~1,640 municipalities and cities (Cebu province: 20 of about
  50), and an Overpass search for Pagadian finds only schools and a fish
  port. Not fixable by an `admin_level` choice. The hole fill (see "Countries
  with a thin city tier"; the level-3 regions are cut down to the land the
  provinces leave first) gives each cities500 point no real municipality
  covers a cell inside its province: named 204 → 253 of 284, no city 49 → 0.
  A point is named after the nearest such place, so a town without a polygon
  next to a municipality that has one gets the land the polygon does not.
- Places named with a district (Santa Cruz, Paco and Port Area answer
  "Manila"; Tunasan and Putatan "Muntinlupa") are correct at the city tier.

## Poland (PL)

`region [6]` (powiat), `city [7]` (gmina), 100.1%.

- **City records named `gmina X`.** *(open)* 2,108 of Poland's 2,403 city
  records are named `gmina …`, which is OSM's name for a rural or mixed
  gmina; the urban gmina of a town is just `Kościan`. GeoNames (Immich's
  current source) says `Izbica`, not `gmina Izbica`. So what the user
  usually sees is the administrative label. Stripping the prefix for
  display is the cheapest fix, but see the next item before doing it.
- **Town inside its own rural gmina.** *(open)* Six reported pairs; both
  places are the same `region`, the outer is a `gmina X` and the inner
  is `X`:

  | inner (`X`) | outer (`gmina X`) |
  |---|---|
  | 52.086468, 16.644287 Kościan | 52.058190, 16.668835 |
  | 51.398777, 16.217194 Lubin | 51.362778, 16.249809 |
  | 50.526087, 22.721100 Biłgoraj | 50.538745, 22.751999 |
  | 50.988260, 23.169994 Krasnystaw | 50.969562, 23.214798 |
  | 50.720373, 23.259945 Zamość (also a region of its own) | 50.763608, 23.254623 |

  (Biała Podlaska, 193016 `gmina Biała Podlaska` and 193017 `Biała Podlaska`,
  is a seventh.) Measured on `world-high-res.bin`: 148 `gmina X` records
  have a plain `X` twin in the same powiat, so this is systematic, not a
  data glitch. Hypothesis (unverified against the extract): the polygons
  are right. In Poland the urban gmina of a town (`gmina miejska`) and the
  rural gmina around it (`gmina wiejska`, seat in the town) are separate
  level-7 relations, so the town is a hole in its rural gmina. The names
  are then correct, and the open question is the "Surrounding rural unit"
  label policy. Zamość is the variant where the town is a city county
  (`powiat grodzki`), hence its region is also `Zamość`. The reported
  suspicion that the polygon-in-polygon is a mistake is worth one check
  against the OSM extract before choosing a policy. The reporter also
  saw several OSM city names inside a single block of these.

  **Needs more investigation before any change:** whether someone living
  there would consider `gmina X` to be "their city/village" at all. A rural
  gmina is an administrative unit made of many villages; its residents
  usually name their own village (or the town they belong to), not the
  gmina, so `gmina Izbica` may be the right polygon with the wrong *kind* of
  answer for a "city" field. The alternatives are to strip the prefix, to
  fall back to the region for rural gminas, or to find a finer tier (sołectwo
  or village relations, if OSM has them for Poland). Do not strip
  `gmina ` blindly: it would also hide the 148 town/gmina twins behind
  identical names. Same question for the other "Surrounding rural unit"
  countries.
- **Whole blocks with a country but no region or city.** *(open)* Seven
  reported points, all in central/eastern Poland, all returning `Poland`,
  `region -`, `city -`:
  51.638902, 17.824631; 51.602666, 20.083008; 52.229377, 17.273254;
  52.107138, 20.628204; 52.431106, 20.714550; 51.147479, 21.968193;
  51.137894, 22.846928. The reporter sees city names for these areas on the
  OSM map, so the polygons exist, which points at a whole region (or a
  group of powiat/gmina relations) being dropped or mis-assigned before the
  compressor: either the powiat does not get picked up as a region
  (and its gminas are dropped by `emitCity`'s "no region, no city" rule), or
  the relations lack a usable `name`. Untested; first step is to
  scratch-script the extract at one of these points and read the
  `admin_level=6` and `7` relations covering it.

  Likely cause (2026-10-13, from names only): regions are keyed by
  country and name, and Poland repeats powiat names across voivodeships.
  `regions.geojsonseq` has one `powiat ostrowski` (Ostrów Mazowiecka), and
  the first point is Ostrów Wielkopolski, whose powiat of the same name is
  missing; gmina Nowe Skalmierzyce, inside it, has no region. The other
  points look like powiaty with namesakes too (średzki, tomaszowski,
  grodziski, nowodworski, opolski, świdnicki). Check that, then key
  regions by relation id instead of name.
  (The `world-queries` todo tests encode all seven.)

- **Poland may be another England.** *(open)* The user's note, with no
  coordinate: the gmina tier probably misses cities that are their own
  county-level relation. See "United Kingdom" for the mechanism and
  "Town inside its own rural gmina" above for the six pairs already found.

## Portugal (PT)

`region [6]`, `city [8]` (100.7%).

- **Lisboa is not a city.** *(open)* Lisboa is `place=city` at level 7
  (the concelho tier, 292 nationally), but Lisbon's freguesias (Alvalade,
  Belém, Benfica, Carnide, ...) are tagged at level 8, already primary.
  Applied as `city: [8, 7]`, verified no effect, reverted. The other 291
  concelhos already resolve through an identically-named level-8 entry. See
  Estonia.

## Qatar (QA)

`region [4]`, `city [10]` (1.2%), `VORONOI_CITY_FALLBACK_HOLES`.

- **Thin city tier.** Fixed 2026-10-14. Places of 50,000+: named 2 → 5 of
  6, no city 3 → 0. The sixth is Old Airport (`المطار القديم`), a real
  level-10 polygon around a place GeoNames calls differently.

## Romania (RO)

`region [4]`, `city [8]` (100.5%), `REGION_CITIES` for București.

- **Bucharest was a region with no city.** 44.43225, 26.10626 returned
  `București / Bucharest`, `city -`: the municipality is at the county
  level, with only its sectors below it. Fixed 2026-10-13 by
  `REGION_CITIES`, which emits the region polygon as the city too (see
  "Capitals that are their own region").

## Russia (RU)

`region [4]`, `city [6]` (104.0%), `REGION_CITIES` for the three federal cities.

- **Moscow has a region and no city.** 55.7558, 37.6173 returned
  `Москва / Moscow`, `city -`; so did Saint Petersburg (59.9386, 30.3141)
  and Sevastopol (44.6167, 33.5254), the other two federal cities. Fixed
  2026-10-13 by `REGION_CITIES`, which emits each region polygon as the
  city too (see "Capitals that are their own region"). Moscow's polygon
  includes New Moscow, whose settlements have no polygon at level 6, so
  they answer `Москва` as well, which is what they legally are.
- **Simferopol municipality council inside Simferopol district.** *(open)*
  44.949006, 34.118385 is `Симферопольский городской совет / Simferopol
  municipality council`; 44.959454, 33.983116 is `Симферопольский район /
  Simferopol District`. Another "Surrounding rural unit" case, harder to
  detect by name or geometry because there is an irregular border strip
  between the two. The country answer for Crimea is `Russia`, from Natural
  Earth.
- **Russia and Turkey span several continent files.** Moscow,
  Yekaterinburg, Novosibirsk and Istanbul each resolve to their region
  exactly once. Fixed by deduplicating relations by id across files.

## San Marino (SM)

`region []`, `city [8]` (84.2%).

- **San Marino had no region, so none of its castelli resolved.** The
  capital answered `San Marino` with no region or city. Same cause and fix
  as Andorra: `CITY_STATES` gives it one region, `San Marino`, and the nine
  `admin_level=8` castelli become the cities (measured on
  `world-high-res.bin`, built 2026-10-13: 43.93667, 12.44639 is `Città di
  San Marino`, 43.964, 12.48 `Serravalle`). The Italian land east of the
  San Marino river that enclaves list (`List of enclaves and exclaves`) is
  a few metres wide and not tested.

## Saudi Arabia (SA)

`region [4]`, `city [6]` (99.8%).

- **City was level 10, splitting Riyadh into neighbourhoods.** Now region 4
  (13 provinces) / city 6 (governorates): Riyadh -> `Riyadh Region / Riyadh
  Governorate`, Jeddah -> `Makkah Region / Jeddah Governorate`. Level 10 was
  1.5% coverage and urban neighbourhoods (Thulaim).

## Slovakia (SK)

`region [4]` (the 8 kraje), `city [8, 5]`, `coverageGapFill: [5]`.

- **Bratislava is a district with no city.** Fixed 2026-10-14. 48.14816,
  17.10674 returned `region okres Bratislava I`, `city -`. Slovakia's two
  statutory cities, Bratislava and Košice, are single relations at level 5
  (`place=city`; the other level-5 relations in the corpus are Czech or
  Hungarian), with their boroughs at 9 and no level-8 relation at all, so
  they were the hole in the level-8 municipalities (the Graz pattern, see
  Austria). The representative-point gap-fill did not add them (tried
  first: no change), so level 5 is a coverage gap-fill level
  (`coverageGapFill: [5]`).
  That was still not enough with the districts (okres, level 6) as the
  regions: a city is assigned to one region, and Bratislava spans five
  okresy, so in the other four the smaller okres polygon beat the city in
  every cell both contain (the compressor takes the smaller). The regions
  are now the 8 kraje (level 4), each containing its cities. Measured
  against cities500 places of 50,000+: named 7 → 10 of 10, no city 3 → 0.
  The region tier is coarser than before; `okres` names are no longer
  anywhere in the result.

## Slovenia (SI)

`region []` plus `VORONOI_REGION_FALLBACK`, `city [8]` (101.9%).

- **Zero regions, hence zero cities, fixed with the Voronoi machinery.**
  City coverage was already fine (real municipalities: Bled, Solčava,
  Mežica), but there was no usable region candidate, so `emitCity`'s "no
  region, drop the city" rule dropped every Slovenian city (Bled and Maribor
  both absent from `world.bin`). The nearest regional tier, OSM
  `admin_level=7` ("Upravna Enota"), covers 17.6%, not a tessellation.
  `buildRegionFallback` groups cities500 points by GeoNames admin1 code,
  computes one Voronoi diagram over all points together (per-group diagrams
  would leave gaps at group borders), then `@turf/union`s each group's cells.
  602 points fall into exactly 212 admin1 codes, matching
  `admin1CodesASCII.txt`'s 212 municipalities; the 212 polygons' combined
  area matches the country's (~20,277 km²), so no gaps or overlaps. It runs
  before `finalRegions`/`regionIndex` are built.
- **A handful of cities land in the wrong synthesized region.** *(open)*
  `assignCityRegion` places a real OSM city by its `repPoint`
  (`pointOnFeature`, roughly a bbox midpoint), and a large or off-centre
  polygon's `repPoint` can land closer to a neighbour's Voronoi site.
  Confirmed on Ljubljana (polygon spans 14.41-14.76 lon; its `repPoint` lands
  in the "Dol pri Ljubljani" cell) and Puconci (lands in "Grad"). Of 271
  Slovenian cities 2 look like real misassignments; the ~95 whose city and
  region names differ are legitimate. On `world-high-res.bin`, 46.0569,
  14.5058 returns `region Ljubljana`, `city -`: the same residue. A fix would
  use each city's own centroid, or bias the sites by extent. Not attempted.

- **The Voronoi fake cities may land on the wrong layer.** *(open)* The
  user, looking at the map, reads the region layer as holding both cities
  and regions and the city layer as holding nothing, and suspects the
  synthesized polygons are generated at the wrong layer. Ljubljana
  (46.05108, 14.50513) returns `region Ljubljana`, `city -`. Not checked;
  the entry above ("A handful of cities land in the wrong synthesized
  region") is the same code path.

## Somalia (SO)

- **Somaliland resolves to no country.** 10.611344, 47.369614 returned
  `country -`: Natural Earth's `Somaliland` (`SOL`) has `ISO_A2_EH` `-99`
  and is dropped. Fixed by the OSM country outlines, whose Somalia relation
  includes Somaliland: it now answers `Somalia`. Its regions and cities
  resolve since candidates Natural Earth places nowhere get their country
  from the outlines: 10.611344, 47.369614 is `Sanaag` / `Ceerigaabo` (see
  "Places Natural Earth puts at sea were dropped").

## Sudan (SD)

`region [4]`, `city [6]` (72.2%).

- **No city tier.** Fixed 2026-10-14. Khartoum resolved to a region and no
  city (the earlier note that it had neither was stale: the capital check
  showed the region). Sudan has a patchy city tier (72.2% by area, 17 of 35
  places of 50,000+ named); `VORONOI_CITY_FALLBACK_HOLES` names the land
  the real polygons leave: named 17 → 33, no city 16 → 0, Khartoum
  resolves. The earlier worry that a fallback would hide an unexplained
  zero-region drop did not hold: the region is there. Coverage is patchy
  across this class of country (Niamey and Nouakchott resolved to city
  before despite low national percentages).

## Taiwan (TW)

`region [4]`, `city [7, 8]`.

- **Villages instead of townships.** City was level 9 (7,545 villages).
  Now `[7, 8]`: townships (level 8) are primary, and the level-7 districts
  (inside special municipalities) gap-fill: Taipei -> `Taipei City / Xinyi
  District`, Kaohsiung -> `Kaohsiung City / Xinxing District`.

## Tajikistan (TJ)

`region [4]`, `city [6]` (99.3%), `REGION_CITIES` for Dushanbe.

- **Dushanbe was a region with no city.** 38.53575, 68.77905 returned
  `Душанбе / Dushanbe`, `city -`: the capital is its own region, with
  nothing at level 6 inside it. Fixed 2026-10-13 by `REGION_CITIES`, which
  emits the region polygon as the city too (see "Capitals that are their
  own region").

## Tanzania (TZ)

- **Mbamba Bay and Liuli resolve to Malawi.** *(false positive)* Their
  GeoNames points (-11.28333, 34.76667 and -11.08333, 34.63333) answered
  Tanzania with Natural Earth's outline and Malawi with OSM's. The points
  are given to the whole minute (11°17′S 34°46′E), so up to about a
  kilometre off. OSM's Tanzanian shore at Mbamba Bay's latitude is at
  34.81°E, about 4 km east of that point, so the point is in the lake; Liuli's is on
  the shoreline. OSM draws all of Lake Malawi in Malawi, as it is
  administered (Tanzania claims the median line). A photo taken on
  Tanzanian land answers Tanzania; one from a boat on the lake answers
  Malawi, the same rule as territorial waters elsewhere.

## Thailand (TH)

`region [4]` (121.8%), `city [6]` (100.1%).

- **Bangkok answers with a khet.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 13.75398, 100.50144
  returns `region Bangkok`, `city Phra Nakhon District`. The user thinks
  the city slot is too specific: either Bangkok is a city and a province in
  one, or it is the England case.

## Togo (TG)

`region [4]`, `city [6]` (58.6%), `VORONOI_CITY_FALLBACK_HOLES`.

- **Prefecture-grain cities.** Partly fixed 2026-10-14. Places of 50,000+:
  named 1 → 5 of 8, no city 4 → 0, Lomé resolves. *(open)* The other three
  (Sokodé, Kara, Dapaong) answer the prefecture (`Tchaoudjo`, `Kozah`, `Préfecture
  de Kpendjal`): the configured level 6 is prefectures, not towns, and the
  fill does not override a real polygon.

## Trinidad and Tobago (TT)

`region [4]`, `city [9]` (0.1%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14. All 3 places of 50,000+ had no
  city; hole fill: 3 of 3 named. Port of Spain resolves.

## Turkey (TR)

`region [4]` (109.8%), `city [6]` (100.0%).

- **Ankara answers with a district.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 39.91987, 32.85427
  returns `region Ankara`, `city Çankaya`. The regions are mapped correctly;
  the user thinks the city tier needs to be one level lower.

## Turkmenistan (TM)

`region [4]`, `city [5, 8]`.

- **Ashgabat has a duplicate.** The capital is `place=city` at level 4 (the
  region level) *and* has an identical second relation (same Wikidata id,
  Q23438) at level 8, a genuine duplicate of the same boundary at two levels
  (all tags compared), unlike Astana's districts. The one capital-is-region
  case that turned out fixable. Minsk and Yerevan were checked the same way
  and have no duplicate.

## Uganda (UG)

`region [4]`, `city [6]` (6.4%), `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier below the districts.** Fixed 2026-10-14. The level-4
  relations are the districts (and the new city councils, Mbale City,
  Mbarara City), which overlap each other; 41 places of 50,000+ were
  named 2, with no city 39. Hole fill: 40 of 41 named, no city 1. The
  remaining miss is Mbale: its point is in the overlap of `Mbale` and
  `Mbale City`, and a few sites there end up with no cell.

## Ukraine (UA)

`region [4]`, `city [7]` (99.7%), `REGION_CITIES` for Kyiv.

- **Kyiv has a region and no city.** 50.441108, 30.527229 returned
  `Київ / Kyiv`, `city -`; the expected city is `Kyiv`. Fixed 2026-10-13 by
  `REGION_CITIES`, which emits the region polygon as the city too (see
  "Capitals that are their own region").

## United Kingdom (GB)

`region [4]`, `city [6, 8, 10]`, with `overrides` for England, Wales, Northern
Ireland and Scotland, `coverageGapFill: [6, 8]`, `wholeUnits` for Wales, and
`VORONOI_CITY_FALLBACK_WITHIN_REGIONS` for Scotland and Northern Ireland.

- **The country-wide pick.** City was level 10 (civil parishes) only, leaving
  London (51.507674, -0.130119), unitary towns and nearly all of Scotland
  without a city. Now `[6, 8, 10]`: parishes primary, districts/boroughs
  (8) and unitary authorities/Scottish council areas (6) gap-filled. London
  -> `City of Westminster`, Reading -> `Reading`, Brighton -> `Brighton and
  Hove`, Kinross -> `Fife`, Edinburgh -> `City of Edinburgh` (the Reading,
  Brighton and Kinross results no longer hold, see below). Parished towns
  are unchanged (Guildford, Cambridge, Malvern). A two-tier county whose
  representative point is unparished (Worcestershire) is added but loses to
  the smaller district or parish wherever one exists.
- **England has cities above its parishes.** Fixed 2026-10-14. England's
  city tier is level 10 (civil parishes), with districts (8) and unitary
  authorities (6) gap-filled where the parishes leave land uncovered. Two
  things kept that from working, found by scanning
  `planet-latest-admin.geojson` for the failing points (the polygons all
  exist: Portsmouth and Southampton are level 6, Winchester, Norwich and
  Great Yarmouth level 8):
  - **Level 6 was unavailable in England.** Wales and Scotland list 6 in
    their `overrides`, and a level that is an override level of any region is
    skipped for every region whose own list lacks it, so Portsmouth,
    Southampton, Reading, Brighton and Bristol were never candidates (this
    is the "Level-6 gap-fill does not show up" item below). England now has
    its own `[10, 8, 6]`; Wales, Scotland and Northern Ireland got 8 added,
    so they gap-fill exactly what they did before.
  - **A district was dropped as soon as one parish covered its
    representative point.** Norwich's point is in the parish Kirby Bedon,
    Winchester's in Owslebury, Great Yarmouth's in Mautby, Basingstoke and
    Deane's in Deane: none was a candidate, however much unparished town
    they hold. `coverageGapFill` replaces the point test for those levels
    with a grid (`coverageGrid.ts`, up to 128 x 128 cells over the bbox, one
    byte each) that every primary clears where it contains the cell's
    centre; a candidate with at least `MIN_UNCOVERED_KM2` (3) left is added.
    A level-6 county that level-8 candidates tile (Hampshire, Norfolk) is
    skipped: its leftover land is its districts' already.
  - **Gap-fill candidates took the borders of the parishes they contain.**
    At a max-depth cell a candidate containing the whole cell scores 100%,
    so a district beat both parishes on every border cell between them
    (`Heath Charnock` -> `Chorley`; on 4,000 random points of England, 142
    changed against the old build, about 20 of them a parish turned into a
    county or district). `quadtree.ts` now gives such a cell to a candidate
    crossing it that holds at least a quarter of it. 30,000 random points
    worldwide: 4 answers differ from the old build (border cells of Chad,
    Vietnam, Cameroon and one in the UK).

  Result on `world-high-res.bin` (2026-10-14), against the 9 cases that
  were failing: Portsmouth, Southampton, Winchester centre, Norwich and Great
  Yarmouth resolve to themselves; Basingstoke and Maidenhead resolve to their
  districts `Basingstoke and Deane` and `Windsor and Maidenhead` (the checks
  use `namedFor`: OSM has no polygon for the towns themselves). City of
  London, Potters Bar, Bristol, Reading and Brighton, open below until now,
  resolve too. 56 more GB cities in the build, none fewer.
- **A parish that is a suburb of a town names the parish.** *(open)*
  51.050352, -1.331964 returns `Badger Farm` (Winchester). It is a civil
  parish with no `place` tag or anything else telling it from a village
  parish like Salhouse (52.677189, 1.409984), which must stay a parish; the
  only difference is that a town has grown over it. Researched 2026-10-14, no
  fix: for each of the 10,450 English parishes, the share of points 300-450
  m outside its border that fall in no parish at all (sampled every ~60th
  vertex, four directions). Badger Farm scores 0.64 (rank 147) and Salhouse
  0.00, but the top of the list is mostly coastal parishes (Zennor, Sennen,
  Portland: sea counts as unparished), so a threshold that catches Badger
  Farm also needs a land mask. Untried: GeoNames population of the parish's
  name against the town's.
- **Old Basing and Lychpit is not a mistake.** *(false positive)*
  51.269890, -1.044946 returns `Old Basing and Lychpit`, where Basingstoke
  was expected. The parish is a village (Old Basing) joined to a Basingstoke
  suburb (Lychpit), so the parish name is a legitimate answer; the same
  research as above scores it 0.12, level with ordinary parishes such as
  Sprowston, so no geometric rule would single it out anyway. Postal
  addresses there say Basingstoke, which is the town to show when the
  question is "which town would a letter go to"; that is not what this tier
  records (the civil parish is), so it stays as it is.
- **Level-6 gap-fill does not show up on the current builds.** Fixed
  2026-10-14, see "England has cities above its parishes". On the 2026-10-10 builds Reading (51.4556, -0.9693), Brighton (50.8225, -0.1372) and Bristol
  (51.453900, -2.595348) all return `England`, `city -`, and
  `cities-filtered.geojsonseq` has no GB feature named `Reading`, `Bristol`
  or `Brighton and Hove`. Level-8 gap-fill still works (`City of Westminster`
  is there and resolves). Same symptom as Bremen and Terrace; whether it is a
  regression or a stale input is undetermined, see Germany. (Kinross, 56.128332, -3.306370, now resolves to
  `Lochgelly` through the Scottish Voronoi cells, not to `Fife`.)
- **London and Potters Bar.** Fixed 2026-10-14 by the same change (City of London and Potters Bar now have a city). 51.515046, -0.093212 (City of London)
  and 51.695597, -0.187626 (Potters Bar) return `England`, `city -`. London
  is the quirk: there is no "London" polygon, only its boroughs, and the City
  of London is not a borough. Potters Bar is in Hertfordshire (an
  unparished or parished district area, not checked), so it may or may not be
  the same cause as the level-6 item above. Both not investigated.
- **Northern Ireland `[7, 10]`.** Belfast lost its cell to a level-10
  townland ("Town Parks"); now `Belfast City District` (the 11 districts
  primary). Level 10 is townlands, never towns.
- **Scotland `[6, 10]`.** Level 10 is ~150 islands plus city-centre areas
  ("Old Town", "City Centre") beating the real unit, so Glasgow and Dundee
  had no city. The 32 council areas (79,814 km², 47.5% of an outline that
  includes territorial waters, i.e. all its land) are primary: `City of
  Edinburgh`, `Glasgow City`.
- **Wales `[10, 6]` + `wholeUnits`.** Level 10 is 878 communities
  tessellating the country (Pontypridd is a `place=town` community). The
  first fix, `[6, 10]`, put the 22 principal areas first and Pontypridd
  became `Rhondda Cynon Taf`. Communities are primary now, and `wholeUnits`
  promotes Cardiff, Swansea and Newport (cities whose communities are
  neighbourhoods like "Castle") and drops their communities
  (`findSuppressedByWholeUnits`, 106 suppressed). Tradeoff: Swansea's rural
  Gower also resolves to `Swansea`.
- **Towns in Northern Ireland and Scotland.** OSM has no polygon for towns
  like Lisburn, Bangor or Melrose: the only containing polygons are the
  council area/district and, in NI, a townland. Each primary district in
  those two regions is replaced by a Voronoi tessellation of the cities500
  points inside it, clipped to the district (`buildContainerFallback`; 792
  cells; a container with no point stays as itself). Checked: Melrose,
  Lisburn, Bangor, Belfast, Edinburgh, Glasgow, Aberdeen, Inverness, Dundee,
  Fort William. Found on the way: the container must *not* also be emitted
  as a backstop, because at max depth a border leaf between two cells is
  won by the largest share, always the container (~5% of random Highland
  lookups returned `Highland`). The cells use GeoNames' own names and
  points, so a rural cell is named after the nearest village (`Strathpeffer`
  at 57.6, -4.5), and Derry is GeoNames' `Londonderry County Borough`.
- **Maghaberry is not in cities500.** *(open)* It resolves to `Moira`; it
  would need OSM `place` nodes as the point source.

## United States of America (US)

`region [4]`, `city [8]` (10.7%), with `overrides: { "New York": [8, 7] }`, `REGION_CITIES` for
District of Columbia.

- **County grain, not city.** Seattle (47.602922, -122.331390) used to
  resolve to `King County`: county (level 6, 103.0%) auto-won the >=60% vote
  over incorporated places (level 8, 10.7%, since unincorporated land is
  common). Overridden to level 8; measured against cities500's 21,785 US
  places, level 8 name-matches 64.0% against the county's 4.3% (a county's
  name is almost never what GeoNames calls a place). Uncovered
  (unincorporated) points fall back to the region instead of showing a
  wrong county name.
- **New York: a per-region override.** Manhattan, Brooklyn, the Bronx and
  Albany still returned `city null`: New York's real municipal tier is
  `admin_level=7` (towns, 92.8% of the state), not 8 (villages, 2.1%
  there). Fixed with `overrides` (region name -> `[primary, ...gapFill]`).
  Two flatter designs were tried first and both regressed:
  - A country-wide `US: { city: [7, 8] }` fixed NY but lost 399 correct
    cities500 matches nationally (63.95% -> 62.12%). A large level-7
    township out-votes a real, smaller level-8 town it contains at their
    shared boundary cells: `buildChunkRecords`' max-depth tie-break takes
    the candidate with the larger *share* of an ambiguous leaf cell, and
    `pruneAncestors` does not treat geometric nesting as exclusive the way
    the hierarchy's own city-in-region ancestry is. Confirmed on
    Wrightsville, AR (5.5 km²), which lost a boundary cell to the 1,120 km²
    Big Rock Township.
  - A single-level `overrides: { "New York": [7] }` fixed Arkansas (a
    candidate at an override level, but not its own region's, is excluded
    from `detectGapFill`) but broke NY internally: villages (level 8) lost to
    their containing town by the same share mechanism (Village of Akron ->
    Town of Newstead, Ardsley -> Greenburgh), still -80 against the baseline.

  `[8, 7]` fixes both: villages are NY's primary and never compete with
  towns for cells they cover; towns only gap-fill where no village covers
  them (Manhattan, Brooklyn, the Bronx, Albany). Net on the same run: 63.88%
  (13,917) against the plain-8 baseline's 63.95% (13,931), a wash on count
  but a real quality gain. A few NY villages (Akron, Ardsley) still lose
  edge cells to their town: the same finite-resolution imprecision as the
  Natural Earth item (each village's own representative point resolves
  correctly), and it would need a real containment relationship between
  same-tier candidates or higher `--max-depth`.
- **Parkman, Ohio has no city.** *(open)* 41.370754, -81.064682 returns
  `Ohio`, `city -`, though Parkman is a label in OSM. With level 8 at 10.7%
  coverage, most of the US is the "unincorporated -> region" fallback by
  design; Ohio township names are typically level 9 (civil townships) and not
  in the city tier. Not checked whether the polygon exists.
- **Township around a village.** *(open)* 43.710199, -82.935448 is `Ubly`;
  43.702009, -82.904034 is `Bingham Township`. In Michigan villages sit
  inside townships and both are tagged at level 8, so the smaller wins where
  it exists and the township answers around it. Another "Surrounding rural
  unit" instance, with the US-wide twist that a township is not really a
  city either.
- **Washington, D.C. had no city.** 38.89511, -77.03637 returned `District
  of Columbia`, `city -`: the district is a level-4 region with nothing at
  level 8 inside it. Fixed 2026-10-13 by `REGION_CITIES`, with the city
  named `Washington` (see "Capitals that are their own region").

## Uzbekistan (UZ)

`region [4]`, `city [6]`.

- **Region was the district tier.** The generated `region: [6]` (204
  tumani/shahri) won by being the only level in range, since `region`'s scan
  only measures levels the entry already lists (`selectRegionLevels` in
  `adminLevelDetection.ts`, `isRegionLevel` in `adminBoundaryIndex.ts`).
  Level 4 is 13 viloyats (62.9%). Samarkand's region is now `Samarqand
  Viloyati`.
- **City tier appeared as a side effect.** With region off level 6, `city:
  [6]` covers 99.9% with real district names; city had been forced onto
  level 8 at 1.3% purely because 6 was claimed. Samarkand resolves to
  `Samarqand shahri`.
- **Tashkent is a region with no city.** *(open)* Returns `region Toshkent
  shahri, city Chilonzor Tumani` (a district): the capital exists only as the
  level-4 relation `region` resolves to (confirmed by scanning every
  Toshkent/Tashkent relation). See "Capitals that are their own region".

## Vatican (VA)

No `COUNTRY_ADMIN_LEVELS` entry (no region or city tier).

- **Vatican resolves to Italy, or to a country with no region or city.**
  41.903323, 12.454001 returned `Vatican`, `region -`, `city -`; 41.903786,
  12.451823 returned `Italy`, `region -`, `city -`. Natural Earth's Vatican
  is a 7-vertex polygon about 110 m by 130 m, a few percent of the real
  state (about 1 km by 0.85 km); the second point was outside it and inside
  Italy, and Rome's OSM polygon correctly leaves the Vatican out, so only
  the country Italy covered it. Fixed by the OSM country outlines (see
  "Natural Earth's outlines are too coarse") and `CITY_STATES`: the Vatican
  gets a region `Vatican` and a city `Vatican City`, both covering its
  whole outline, since OSM has nothing below its `admin_level=2` relation.
  Both points read `Vatican / Vatican / Vatican City` on
  `world-high-res.bin`. On `world.bin` a leaf cell (about 1.8 km by 1.2 km)
  is bigger than the Vatican, so it answers Rome there: the grid cannot
  draw it without giving it a few km² of Rome.

## Venezuela (VE)

`region [4]`, `city [7, 8]`.

- **Level 7 is parroquias, 101.9%, almost untagged.** Level 8 carries 267
  real settlement tags (147 town, 69 village, 51 city) in a layer with 899
  untagged/suburb/hamlet features. Gap-filling 8 is a real but partial win:
  most parroquias are named after their seat (Aguasay), but El Salto, Las
  Trincheras and San Antonio de Los Altos now resolve under their own plain
  name. "Los Robles", the one candidate to survive the strict filter, does
  not benefit.
- **Maracaibo.** *(open)* Venezuela's 2nd-largest city has no admin boundary
  above `place=neighbourhood` at level 9: a deeper bug than the Brazil one (fixed: municipalities were there, only the config skipped them),
  not reachable by this gap-fill.

## Vietnam (VN)

`region [4]` (170.3%), `city [6]` (99.6%).

- **Hanoi answers with a ward.** *(open)* Reported 2026-10-14 while improving capitals, looked up on `world-high-res.bin`. 21.0245, 105.84117 returns
  `region Hà Nội`, `city Phường Văn Miếu - Quốc Tử Giám`. Suspected: what
  is in the region slot looks like cities, so region and city move down.
  Region coverage of 170% means overlapping candidates; check that first.

## Yemen (YE)

`region [4]`, `city [6]`.

- **Capital resolves to a district.** *(open)* Sana'a returns `region
  أمانة العاصمة` with `city مديرية الثورة`; Aden is the same pattern one
  level down (its city boundary is the only level-5 feature in Yemen).
  Level 6 (districts, 99.5%) splits the larger cities while being about
  right for rural areas, and no single level fits both. See "Capitals that
  are their own region".
