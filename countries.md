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
  added 2026-10-14, handles 26 more: AE, AO, AW, AZ, BF, BI, BW, CD, CF,
  GE, GW, LR, LS, MR, MW, NA, NE, PH, PY, QA, SD, SX, SZ, TG, TT, UG (AW and
  SX since 2026-10-15, see "Territories with no region tier"; AE and PY
  since 2026-10-15, see United Arab Emirates and Paraguay). What it found: in each of
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
  Fifteen capitals resolve now (see "Capitals."). Guinea-Bissau was in
  the list from the start (places of 5,000+ named 0 → 24 of 39), dropped
  before the 2026-10-14 commit on the wrong assumption that the fill did
  nothing there because Bissau has no region, and put back on 2026-10-15.
  Since 2026-10-15 a GeoNames section of a populated place (`PPLX`) is no
  site: Doha's and Dubai's neighbourhoods split their city into
  neighbourhood names (Qatar 21 of 43 points are PPLX, the Philippines 28
  of 4,529; 6 Philippine and 3 Aruban places of 1,000+ changed their
  answer to the neighbouring town's). Also since 2026-10-15 a real city of these countries that lies more than half
  in other regions than its own is dropped too (Uganda's Bugisa
  sub-region; see Uganda), and Togo's and Liberia's levels changed so the
  fill names their towns (see Togo, Liberia). Remaining open in the group:
  Bissau itself, whose sector has no relation at any level, so the fill
  has no region to put a cell in (15 places of 5,000+ there answer the
  country only); BB, BH, BZ, CV, DM, ME, MP, MV, UY, WS, the other empty
  lists and the countries not in the table (the 5-20% ones) are not
  examined. *(open)*
- **Regions with no city mapped.** *(open)* Found 2026-10-16 from the place
  table alone: `node reader/src/cli.ts list data/03-final/world-high-res.bin
  --level region --childless` prints every region whose `city_counts` entry
  is 0 (0.7 s, no chunk is read). 418 of 5,125 regions in 70 countries
  (`world-high-res.bin`, built 2026-10-15); looking each one up at its
  `locate` point gave the region and `city -` every time. Reading the list:
  - **Countries with no city at all** (13, 128 regions): British Virgin Is.,
    Fiji, Grenada, Heard I. and McDonald Is., Montserrat, Nauru, Palau, Saint
    Lucia, Seychelles, St. Kitts and Nevis, St. Vin. and Gren., Turks and
    Caicos Is., Vanuatu. The empty city lists of "Countries with a thin city
    tier"; the Voronoi hole fill was not tried on them (Fiji is excluded by
    its region overlap). Their towns answer with the region.
  - **Countries where most regions have none** (the rest of that entry's
    list): Bahrain 3 of 4, Dominica 9 of 10, Greenland 5 of 6, Saint Helena
    5 of 6, Macao 6 of 8, Samoa 11 of 12, Maldives 19 of 21, Cook Is. 10 of
    11, Cabo Verde 17 of 22, eSwatini 34 of 53 (the hole fill covers SZ, but
    not these inkhundla), Bahamas 9 of 33.
  - **A region that is one town, with no city for it**, the Bremen shape
    (verified by lookup, answer `city -`): Kranj (Slovenia, Urban
    Municipality of Kranj), Izola, Abidjan and Yamoussoukro (Côte d'Ivoire),
    Cetinje (Montenegro), Paphos (Cyprus), Rason (North Korea), Ménaka
    (Mali), Banjul and Kanifing (Gambia), Djibouti and Ali Sabieh, Honiara,
    Osh, Sejong, Labuan, Delhi, Ljubljana, the Bahraini governorates, Kigali's
    districts, Niamey 5. Several are capitals already listed under
    "Capitals." Fix with `REGION_CITIES` (with a `city` name where the
    region's is not the town's) after checking the region holds no other
    town.
  - **Not a problem**: uninhabited or remote units (Ashmore and Cartier,
    Coral Sea Islands, Bouvet, Jan Mayen, Gough and Nightingale, Mexican
    islets); Ugandan districts that surround a separate `... City` region
    (Gulu, Mbarara, Mbale, Masaka, Soroti, Arua and Fort Portal all resolve
    to their city); Vietnam's new `Tỉnh Lào Cai` and `Tỉnh Quảng Trị`, whose
    wards sit under the `... cũ` (old) province relation.
  - **Relations that are not places**: China's `... Boundary ...` and
    enclave relations (824, 825, 826, 833, 843, 849, 855), India's `Karnataka
    - Maharashtra border` and `Maghval – Nagar Haveli border`, Spain's
    `Cantabria - Castilla y León` and `Castilla y León - Euskadi`, Georgia's
    `Къуайса`. They are regions with no land of their own; worth dropping or
    reporting upstream, not mapping.
  - **Not covered here**: Bremen itself has Bremerhaven, so it is not
    childless. The second check is a region that has cities but whose own
    `locate` point resolves to none (245 regions; Bremen is one, 1012 at
    53.1251, 8.7465, which resolves since 2026-10-16, see Germany's
    "Bremen does not resolve on the current builds."). It is noisier,
    since the point can fall between cities. Not triaged; the largest groups are the United States 37, Uruguay 18,
    Indonesia 14, Thailand 11, Montenegro 9, Panama 8.
  Cases: Kranj and Izola are in `verify/src/cases.ts` as open. Abidjan,
  Cetinje, Paphos, Rason and Ménaka resolve since 2026-10-16 (next entry).
  Slovenia's (Kranj, Izola, Ljubljana) are a different shape: its regions
  are Voronoi cells named for GeoNames' admin1 codes, which in Slovenia are
  the municipalities, so a region and the city of the same name compete
  (see Slovenia).
- **Regions that are one town had no city.** Fixed 2026-10-16. From the
  "one town" group of the entry above, each region was checked twice: which
  OSM relations cover its town (a scratch scan of the extract), and which
  cities500 places answer it with `city -`. Two fixes, by how many towns the
  region holds:
  - **One town, nothing at the city level inside: `REGION_CITIES`.** Banjul;
    Honiara (its 11 cities500 places are its wards); Osh City (`Ош шаары`,
    shown as `Ош` / Osh); Sejong; Rason (Rajin and Sŏnbong are its two
    districts); Paphos Municipality (`Δήμος Πάφου`, shown as `Πάφος` /
    Paphos: Cyprus' regions are its municipalities, and Paphos' holds no
    level-8 community, only quarters); Labuan; Abidjan and Yamoussoukro,
    whose autonomous districts have no department (Côte d'Ivoire's city
    tier) inside. The last three hold more than one town: Bingerville,
    Anyama and Songon answer Abidjan, and Attiégouakro's villages answer
    Yamoussoukro. That is the grain of the country's city tier (a
    department, a daerah), not a town inside it. Kaesong (`개성시`) was
    tried and skipped by the build, since it already holds 3 cities.
    `REGION_CITIES` entries take a `cityEn` now, for a city named unlike
    its region.
  - **Several towns: the city hole fill** (`VORONOI_CITY_FALLBACK_HOLES`)
    for Bahrain (city tier 0.6%), Djibouti (Djibouti and Balbala, and the
    towns of Ali Sabieh and Arta), Montenegro (city tier 9.6%: Cetinje and
    places in 16 more municipalities) and Mali (Ménaka region, no cercles).
  Measured against the previous build: 186 cities500 answers changed, all in
  these 11 countries. 185 went from `city -` to a city. The other,
  Ibarac (Montenegro), went from Rožaje to its own name; it is a separate
  village of 3,135 next to the town. Five capitals resolve since:
  Yamoussoukro, Djibouti, Banjul, Honiara and Manama.
  Not done: Delhi, which holds New Delhi and more (its municipal
  corporations are the cities since 2026-10-16, see India), Kigali,
  whose districts tile it (Nyarugenge holds the centre), Kanifing, which is
  Serekunda's municipality but not named for it, and Niamey 5.
- **Overlapping cities traded cells.** Fixed 2026-10-16, reported by the
  user at Hyderabad: tiny enclave-like pieces of one city scattered inside
  another. Found with `verify/src/islands.ts`, which counts the separate
  pieces (edge-connected cells) of every place and ranks places by those
  times the pieces of their most broken-up neighbouring city. One piece is
  normal, 2-4 an enclave or a sliver touching at a corner (Den Haag 2,
  Uikhoven 3, Khudail Tahsil 4, Baarle-Hertog 7 against Baarle-Nassau 3);
  above ~50, two polygons lie on top of each other. Hyderabad had 203:
  India's talukas tile whole districts, the corporations included, so the
  gap-fill mandals around Hyderabad (Patancheruvu, Alwal, Balanagar,
  Rajendranagar, ...) reach into the corporation, and in the overlap the
  smaller polygon won each cell. Their edges are drawn from different
  sources, so the overlap is a ragged band and every cell along it could
  go either way. The cause is general: a gap-fill city from a *coarser*
  level than the primaries names what they leave, never land a primary
  holds. prepare-world now marks those (`CityProperties.gapFill`: a
  gap-fill city whose level is below its country's, or its region
  override's, primary level), and the compressor's `preferred` ranks them
  after every other candidate, and does not let one win a max-depth border
  cell a primary city contains. A gap-fill city from a *finer* level is a
  real place a coarser primary overlaps (Varadero, level 8, in Cárdenas, 6)
  and is not marked: marking every gap-fill city lost Varadero to Cárdenas.
  50 cities500 places changed, all gains: 44 in India (Chennai's suburbs
  from their taluk to Chennai Corporation, Secunderabad and Malkajgiri to
  Hyderabad, Joka to Kolkata) and six New York villages that had lost to
  their town (Ballston Spa, Gowanda, Sag Harbor, Black River, Earlville,
  Middleville). Pieces: Hyderabad 203 -> 7, Chennai Corporation 127 -> 1,
  Kolkata 111 -> 4, Sitarganj 70 -> 1, Town of North Hempstead 39 -> 19;
  1,662 fewer pieces in 197 places, 107 more in 19, mostly the mandals now
  cut along the corporation's edge, and Kolkata district (level 5, a
  gap-fill city of its own), 11 -> 39, now only the slivers where its
  outline sticks out past the corporation's. Such a district is the city
  drawn twice, so a coarser gap-fill city named like a primary it overlaps
  (local or English name) that is at least half its size is dropped
  (prepare-world, "drawn again" in the log): Kolkata and Chennai districts,
  no answer changed. Tried first and reverted: not counting uncovered land
  within 200 m of a primary (an eroded coverage grid). It cannot tell
  Kolkata district's slivers (3.69 km^2 left at 50-150 m) from Coalville's
  unparished town in North West Leicestershire (3.45 km^2), on grids of
  ~200 m cells, and lost Coalville its city.
- **Border artifacts found by the island count.** *(open)* Ranked by
  `verify/src/islands.ts` on 2026-10-16 (after "Overlapping cities traded
  cells") and checked on the map by the user, all true positives: Tāzirbū
  (26.243694, 18.601570, a horizontal slice), Fada, Al Jawf and Ounianga
  Kébir (19.660694, 23.649101, a vertical slice), Bilma (20.766186,
  15.573978), Idrī, Debdeb, In Amenas, Teseney, Wagar, Assab, Central
  Tigray and Semien Mi'irabawi Zone, Goz Beida, Léré, Bardaï, Rey-Bouba,
  Abéché, Guéréda; Slovenia's Sevnica, Šentjur, Litija, Ljubljana and
  Brežice (66 pieces, next to Krško's 102). Most are borders where one
  side is synthesized Voronoi cities (Libya, Chad, Eritrea, Niger and
  their neighbours) or Slovenia's Voronoi regions. Capital Region Rural
  District (New Brunswick) is a large rural polygon in the city slot that
  the towns inside it cut into pieces, with artifacts at 45.828500,
  -66.457157 and 45.690113, -66.395187. There it borders 5th Canadian
  Division Support Base - Gagetown, also level 6, and the two outlines'
  shared edge is drawn differently, so cells along it alternate; the
  marking above does not separate two gap-fill cities of one level. OSM
  also still has the parishes the 2023 reform replaced, at level 8
  (Burton Parish, Petersville Parish). Every place scoring above ~21,000
  that was checked is a true positive; between 10 and 20 pieces most are not.
- **Territories with no region tier.** Fixed 2026-10-15. A city with no
  region is dropped (`emitCity`), so a country configured `region: []`
  lost every city it had unless it was in `CITY_STATES`. Thirteen were
  (AW, BL, BS, FK, JE, KI, KY, MF, NU, PM, SX, TV, WF), and Bermuda had its
  parishes as the region and no city level. `CITY_STATES` now gives these one region covering the
  territory, as it does Malta and Andorra: Aruba, Bermuda (`city [6]`, the
  parishes and the City of Hamilton, was `region [6]`), Falkland Islands,
  Jersey (`city [8]`, the parishes, was the vingtaines at 9), Kiribati
  (the atolls; South Tarawa is `Tarawa Te Inainano`), Cayman Islands (the
  districts), Niue (the villages), Saint-Pierre-et-Miquelon, Sint Maarten,
  Tuvalu (the islands). Aruba and Sint Maarten have relations for only a
  few towns (Oranjestad, Philipsburg), so they are in the hole fill as well
  (its regions are `finalRegions`, which holds a city-state's region).
  cities500 places of 500+ named for their city, before → after: AW 0 →
  14 of 14, BM 0 → 10 of 12, FK 0 → 1 of 1, JE 0 → 5 of 5, KI 0 → 21 of 36
  (a village answers its atoll), KY 0 → 66 of 71 (a neighbourhood answers
  its district), NU 0 → 1 of 1, PM 0 → 2 of 2, SX 0 → 7 of 7, TV 0 → 6 of 8;
  no city 0 everywhere. No other country's answer changed for any cities500
  place of 1,000+. Ten capitals resolve: Oranjestad, Hamilton, Stanley,
  Saint Helier, Tarawa, Alofi, Philipsburg, Saint-Pierre, Funafuti and
  George Town. The Bahamas, Wallis and Futuna, St-Barthélemy, St-Martin,
  Curaçao, Anguilla, Gibraltar and the Marshall Islands followed the same
  day (see "Land no region covers").
- **Land no region covers.** Fixed 2026-10-15. A city with no region is
  dropped, so a town on land none of its country's regions covers lost its
  city too. Measured with every cities500 place: 43 countries had places
  answering a country with no region. Two shapes, two fixes:
  - **Region names without polygons** (`VORONOI_REGION_HOLES`,
    `regionHoles.ts`): a country whose regions leave populated land out.
    Every cities500 place of the country is a Voronoi site, and the cells of
    the places no region holds, minus the regions, go by GeoNames admin1:
    to the region of the nearest covered place with the same admin1 code
    (Baku's outer districts join `Bakı`; Comoros', Madagascar's, Mauritius'
    and Lake Victoria's offshore islands join theirs), else to a new region
    named for the admin1 (`Bissau`, `Karakalpakstan`, `Madeira`, `Azores`,
    `Rodrigues`, `Saint Helena`, `Ascension`), else, with no named admin1, to
    the nearest covered place's region. Land in the hole nearer a covered
    place stays as it was. A first rule gave a code to the region whose
    places mostly carry it, which split Baku into `Bakı` and a new `Baki`
    (two regions both mostly carry admin1 Baku) and made tiny regions from
    the unnamed code 00. AZ, GW, KM, MG, MU, PF, PT, SH, TZ, UZ.
    Not for Cyprus: its regions are the south's new municipalities, which
    the north's places would extend across the line, and not for Western
    Sahara, whose places have no admin1.
  - **No region at all**: the country's name, as for Monaco and Malta
    (`CITY_STATES`): Anguilla, Curaçao, Gibraltar (city `Gibraltar` too),
    Saint-Barthélemy, Saint-Martin; Anguilla and Curaçao also get the city
    hole fill. Where OSM has the tier at another level, that level instead:
    the Bahamas' districts and Wallis and Futuna's three kingdoms (level 8)
    are the regions, with the city hole fill for the towns; the Marshall
    Islands' two chains (4) and atolls (8).

  No other country's answer changed for any cities500 place of 1,000+.
  Seven capitals resolve: Bissau, Nassau, Willemstad, Gibraltar, The
  Valley, Majuro, Mata-Utu. Still with no region: northern Cyprus (13),
  Western Sahara (4), and single places on a coast or border elsewhere.
  Bonaire, Saba and Sint Eustatius (10) have their island as region since
  2026-10-15 (see Netherlands), Poland's 132 since 2026-10-16 (namesake
  powiaty, see Poland).
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
  - **Country only** (6): neither a region nor a city covers the point.
    Microstates and small territories (Skopje, Manila and Tbilisi left on
    2026-10-14). `CITY_STATES` (Monaco, Vatican) is the mechanism for the
    microstates among them (Andorra, Malta and San Marino were added
    2026-10-13 and are out of this list). On 2026-10-15 it took nine
    territories off it, whose city tier OSM has but which had no region
    to sit in (see "Territories with no region tier"), and seven more the
    same day (see "Land no region covers"). Jamestown, Gustavia and Marigot
    have a region since then but still no city named for them.
    Port-aux-Français (Fr. S. Antarctic Lands); Adamstown (Pitcairn Is.);
    Grytviken (S. Geo. and the Is.); Jamestown (Saint Helena); Gustavia
    (St-Barthélemy); Marigot (St-Martin)
  - **The capital is only a region** (10; Yamoussoukro, Djibouti, Banjul and Honiara left on 2026-10-16, see "Regions that are one town had no city"; nine left on 2026-10-14, see "Countries with a thin city tier", Hamilton on 2026-10-15, see "Territories with no region tier", and Vilnius the same day, see Lithuania): the region carries the
    capital's name and no city covers the point. This is the previous
    entry ("Capitals that are their own region"). Its `REGION_CITIES`
    took 13 capitals off this list on 2026-10-13 (Vienna, Minsk, Prague,
    Kinshasa, Berlin, Conakry, Riga, Kuala Lumpur, Port Louis, Bucharest,
    Moscow, Dushanbe, Kyiv). Bamako resolves since the same day: its city
    is drawn exactly like a second region (`Bamako - Koulikoro`), and a
    city now beats a region drawn the same (see "Cities drawn twice").
    The rest are either a province named after its seat or not checked
    yet (that entry says which).
    Thimphu (Bhutan); Praia (Cabo Verde; at this location the city's name
    ends up in the region slot, see Cabo Verde); Male
    (Maldives); Saipan (N. Mariana Is.); Yaren (Nauru);
    Castries (Saint Lucia); Ljubljana (Slovenia);
    Basseterre (St. Kitts and Nevis)
  - **A region around it, no city** (18; New Delhi left on 2026-10-16, see India; Manama left on 2026-10-16 with Bahrain's city hole fill; Khartoum and Lomé left on 2026-10-14; Brasília moved on 2026-10-14, see Brazil; Guernsey left on 2026-10-14, it has a city and only the spelling differed): the region is a province,
    parish or federal district, and no city covers the point. Washington
    ("District of Columbia") was one and resolves since 2026-10-13
    (`REGION_CITIES` with a `city` name).
    Bridgetown (Barbados); Belmopan (Belize); Road Town (British Virgin Is.); Quito (Ecuador); Suva
    (Fiji); Nuuk (Greenland); Saint George's (Grenada); Macau (Macao); Antananarivo
    (Madagascar); Plymouth (Montserrat); Ngerulmud (Palau); Kigali
    (Rwanda); Apia (Samoa); Victoria (Seychelles); Kingstown (St. Vin. and
    Gren.); Tunis
    (Tunisia); Cockburn Town (Turks and Caicos Is.); Port-Vila (Vanuatu)
  - **A district, ward or parish instead of the capital** (61; Brussels left on 2026-10-14, see Belgium; Abu Dhabi on 2026-10-15, see United Arab Emirates): the
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
    (U.S. Virgin Is.); London (United
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
- **Baku's outer districts had no region.** Fixed 2026-10-15. 17 places
  of 5,000+ around Baku (Sabunçu, Mərdəkan, Hövsan, Zabrat) answered the
  country only. The level-6 `Bakı` relation is the 164 km² core; OSM has
  no relation for Baku's whole administrative territory, whose outer
  districts (`Sabunçu rayonu`, `Suraxanı rayonu`, `Xəzər rayonu`) are
  level-8 relations in no region, so they were dropped. With
  `VORONOI_REGION_HOLES` the land joins `Bakı` (its places are GeoNames
  admin1 Baku, like the nearest covered ones in the core), and the
  districts are cities in it: Zabrat answers `Bakı`, `Sabunçu rayonu`.

## Bahrain (BH)

`region [4]`, `city [10]` (0.6%), city hole fill.

- **No town had a city.** Fixed 2026-10-16 by the city hole fill: Manama,
  Al Muharraq, Ar Rifā‘ and Bahrain's other cities500 places name the land
  around them. See "Regions that are one town had no city" (Cross-cutting patterns).

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

## Bosnia and Herzegovina (BA)

`region [4]` (the entities), `city [9, 6, 7]`, `primaryLevel: 9`,
`coverageGapFill: [6, 7]`.

- **Federation towns had no city.** Fixed 2026-10-15. 41 of 118 places of
  5,000+ answered `Federacija Bosne i Hercegovine` with `city -` (Živinice,
  Visoko, Konjic, Kakanj). `city [9]`, the settlements, covers 61.3%:
  Republika Srpska and the big towns (Sarajevo, Zenica, Tuzla, Mostar) have
  them, much of the Federation does not. Its cities (`Grad Živinice`, level
  6) and municipalities (`Općina Kakanj`, 7) cover the rest, so they fill
  the land the settlements leave, the Bulgarian shape (see Bulgaria). Named
  73 → 97 of 118, no city 41 → 0; the rest are villages answering their
  municipality (`Mala Kladuša` → `Općina Velika Kladuša`). Places of
  50,000+ 7 of 7 before and after; Sarajevo still resolves.

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

## Cabo Verde (CV)

`region [6]` (municipalities), `city [9]` (6.3%).

- **Praia answers as a region.** *(open)* Remark added 2026-10-15 at the
  user's request: at the capital's own point, 14.93152, -23.51254, the
  city ends up in the region slot. The lookup returns `region Praia`,
  `city -`: the level-6 region is the municipality of Praia, named after
  its town, and no level-9 relation covers the point, so the name a user
  looks for in the city field is only in the region field there. Not
  examined further yet (CV is one of the thin-city-tier countries).

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

## Côte d'Ivoire (CI)

`region [4]`, `city [5]` (departments, 99.1%), `REGION_CITIES` for Abidjan
and Yamoussoukro.

- **The autonomous districts had no city.** 5.36, -4.0083 returned
  `region Abidjan`, `city -`, as did Yamoussoukro: both districts are
  level-4 regions with no level-5 department inside (Abidjan's communes are
  level-8 `place=suburb` relations). Fixed 2026-10-16 by `REGION_CITIES`.
  Bingerville, Anyama and Songon now answer Abidjan, and Attiégouakro's
  villages Yamoussoukro, which is the department grain the rest of the
  country answers at. See "Regions that are one town had no city" (Cross-cutting patterns).

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
- **Paphos had no city.** 34.772, 32.4297 returned `region Δήμος Πάφου`,
  `city -`: the region tier is the municipalities, and Paphos' holds no
  level-8 community, only level-9 quarters. Fixed 2026-10-16 by
  `REGION_CITIES`, shown as `Πάφος` / Paphos. See "Regions that are one town had no city" (Cross-cutting patterns).

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

## Djibouti (DJ)

`region [4]`, `city [6]` (79.2%), city hole fill.

- **Djibouti, Ali Sabieh and Arta had no city.** Their regions hold
  several towns each and no level-6 relation. Fixed 2026-10-16 by the city
  hole fill: Djibouti and Balbala, Ali Sabieh, Arta, Holhol and the other
  cities500 places. See "Regions that are one town had no city" (Cross-cutting patterns).

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

## Gambia (GM)

`region [4]`, `city [6]`, `REGION_CITIES` for Banjul.

- **Banjul had no city.** Its level-4 region holds only Banjul (a level-5
  relation of the same name, below the city level). Fixed 2026-10-16 by
  `REGION_CITIES`. Kanifing is not listed: it is Serekunda's municipality
  and not named for the town. See "Regions that are one town had no city" (Cross-cutting patterns).

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
- **Bremen does not resolve on the current builds.** Fixed 2026-10-16.
  53.079296, 8.801694 returned `region Bremen`, `city -`, and no German
  city named `Bremen` reached `cities-filtered.geojsonseq`.

  The state of Bremen is two cities with the state around them: the city
  of Bremen (Stadtgemeinde) and Bremerhaven, both enclaves in Lower Saxony,
  plus small exclaves. One of them is Bremen's overseas port area,
  which lies inside Bremerhaven. See
  <https://en.wikipedia.org/wiki/Bremen_(state)>. OSM matches that: the
  Land is `a125437` (level 4), the city of Bremen `a125119` (level 6,
  `place=city`, three parts, port area included), and Bremerhaven
  `a125317` (level 6).

  Not a regression, and not a missing relation: the level-6 gap fill
  dropped it. A gap-fill candidate was tested by its `repPoint`, which for a
  polygon whose bbox midpoint is outside it (Bremen's bbox reaches up to
  the port area) is the nearest boundary vertex. Bremen's vertex,
  53.18549, 8.69942, is on the Lesum, on the border with Ritterhude, a
  level-8 Lower Saxony municipality that contains the vertex too. So
  Bremen counted as covered by a primary. Region assignment had the same
  flaw and already used a strictly interior point (`regionPoint`); the
  gap-fill and `wholeUnits` coverage tests use it now as well
  (`insidePoint` in `adminLevelDetection.ts`, with a test).

  Measured against the previous build: 17 cities500 answers changed, all
  for the better:
  - Bremen, Vegesack and Burglesum (`city -` -> Bremen). Bremen's port
    area in Bremerhaven, 53.585, 8.545, answers Bremen, and Bremerhaven
    still answers Bremerhaven.
  - Nuremberg (515,543), Wetzendorf and Großreuth bei Schweinau
    (`city -` -> Nürnberg), and Landau in der Pfalz: two more German
    `kreisfreie Städte` with the same vertex problem.
  - Pļaviņas, Ilūkste and Ādaži (Latvia), Matagami (`city -` -> itself).
  - Buffalo Narrows and White City (Saskatchewan): their own municipality
    instead of the rural unit around it. Varadero: itself instead of
    Cárdenas. Hornell (`city -` -> City of Hornell), and Munsons Corners
    and Cortland West (`city -` -> Town of Cortlandville).

  The `world-queries` case now passes, and a Nuremberg case pins the
  second city.
- **Berlin and Hamburg are regions with no city.** 52.520008,
  13.404954 and 53.551086, 9.993682. Confirmed: neither has a second,
  lower-level relation anywhere in the German extract, unlike Bremen.
  Fixed 2026-10-13 by `REGION_CITIES`, which emits the Land polygon as the
  city too (see "Capitals that are their own region"). Bremen is not
  listed: the Land holds Bremerhaven, and the city of Bremen has a
  relation of its own (see the entry above).
- **Border artifacts** on the Dutch, Belgian, Luxembourg and Czech borders.
  Fixed by the OSM country outlines: see "Border artifacts".
- **The German-Luxembourg condominium was a city.** Fixed 2026-10-16,
  reported by the user. 49.494277, 6.368744, in the Moselle between
  Schengen and Perl, answered `region Rheinland-Pfalz`, `city Condominium
  Lëtzebuerg-Deutschland`, while the cells to its left answered Luxembourg
  and to its right Saarland. Condominium Lëtzebuerg-Deutschland (relation
  3659532) is the Moselle, Sauer and Our where they form the border, held
  by both countries and, in its own `note`, part of no Gemeinde, commune
  or Kreis. It is tagged `admin_level=6`, Germany's city gap-fill level, so
  it was a city along the whole border, with the region its point lies in.
  No tag says it is not a place, and it is the only such relation in the
  extract, so it is listed by id in `NOT_PLACES` and dropped in Pass 1 like
  `natural=coastline` islands. The point answers Saarland / Perl now; no
  cities500 place changed.

## Guinea (GN)

`region [4]`, `city [6]` (100.4%), `REGION_CITIES` for Conakry.

- **Conakry was a region with no city.** 9.53795, -13.67729 returned
  `Conakry`, `city -`: the capital is its own region, with nothing at level
  6 inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits the region
  polygon as the city too (see "Capitals that are their own region").

## Guinea-Bissau (GW)

`region [6]` (sectors), `city []`, `VORONOI_CITY_FALLBACK_HOLES`,
`VORONOI_REGION_HOLES`.

- **Bissau has no region.** Fixed 2026-10-15. 11.86357, -15.59767 answered
  the country only. OSM has no relation for the autonomous sector of Bissau
  at any level (the eight regions at 4 and the sectors at 6 leave it out),
  and a city with no region is dropped, so the hole fill, which names the
  rest of the country (places of 5,000+ named 0 → 24 of 39), put no cell
  there. The region hole fill (see "Land no region covers") makes the land
  a region `Bissau` (GeoNames admin1 GW.11) from the cells of its 14
  cities500 places; the city hole fill then names Bissau and its suburbs.
  Bissau resolves (`region Bissau`, `city Bissau`).

## India (IN)

`region [4]` (100.2%), `city [8, 6, 5]`: municipal corporations (8)
primary, talukas (6, 97.4%) and then districts (5) fill by coverage.
India has 28 states and 8 union territories, among them the National
Capital Territory of Delhi; Mumbai is Maharashtra's largest city, Kolkata
West Bengal's, Ahmedabad and Surat Gujarat's (see
<https://en.wikipedia.org/wiki/States_and_union_territories_of_India>, and
<https://en.wikipedia.org/wiki/Delhi#Geography> for Delhi).

- **India's municipal corporations were hidden behind talukas.** Fixed
  2026-10-16. `city [6]` (talukas, tehsils, mandals) was the only tier, so
  Hyderabad answered `Asif Nagar mandal`, Jaipur `Jaipur Tehsil`, Nagpur
  `Nagpur Urban Taluka`, and the cities no taluka covers answered only
  their state: Chennai, Kolkata, New Delhi and Delhi (154 cities500 places
  with a region and no city, 122 of them in Delhi). OSM has India's urban
  local bodies at level 8, 84 relations and 10,370 km^2: Chennai
  Corporation (relation 1766358), Kolkata (9381363), New Delhi (21180662,
  the NDMC), Delhi (the MCD), Hyderabad, Jaipur Municipal Corporation,
  Bengaluru's five city corporations, Nagpur City, Thane, Navi Mumbai,
  Madurai, and Kerala's grama panchayats. Level 9 is 55,092 villages
  (9%), level 7 blocks in Haryana and Tripura only. The Lithuanian shape:
  `primaryLevel: 8`, with talukas in `coverageGapFill`, so a taluka shows
  wherever no corporation is, and districts (5) after them, for land no
  taluka covers (Mumbai's two districts, Leh). A district the talukas
  tile is skipped (`finerArea`). 227 places changed, all in India: 147
  from `city -` to a city, 80 from a taluka to their corporation (Madurai
  North and South are Madurai, Yelahanka is Bengaluru North City
  Corporation, Virar is Vasai-Virar). 7 places with no city are left:
  Surat and Ahmedabad (see below), Kalpeni and four Mizoram villages.
  New Delhi, the capital, resolves since. Shahdara answering Delhi
  Cantonment is right for its point: GeoNames puts it at 28.60311,
  77.13988, inside the cantonment, not in east Delhi.
  Three Lakshadweep islands lost their city on that build: Amini (2.7
  km^2), Kiltan (1.8) and Chetlat (1.2) are whole island taluks that no
  primary covers, but under `MIN_UNCOVERED_KM2` (3 km^2), which applied
  even to a candidate smaller than the floor. A candidate under twice the
  floor now needs half of itself uncovered (`minUncoveredKm2`). That
  changed 4 places worldwide: the three islands, and Linksmakalnis
  (Lithuania), now in Linksmakalnio seniūnija instead of `city -`.
- **Mumbai, Ahmedabad, Surat and Pune have no city relation.** *(open)*
  19.076, 72.8777 (Mumbai) answers `Mumbai Suburban District`, south
  Mumbai `Mumbai City District`; 23.0225, 72.5714 (Ahmedabad)
  `SabarmatiTaluka`; 21.1702, 72.8311 (Surat) `Majura Taluka`; 18.5204,
  73.8567 (Pune) `Pune City Subdistrict`. None of the four has a level-8
  relation like the other metros. Mumbai's city relations, 7888990 and
  16173235, have no `admin_level`, so the extract does not have them;
  Surat's 10029899747 is a node. Ahmedabad and Surat are level-5
  districts (relations 1953566, 1952514) that their talukas tile.

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
  Saint Helier answered `Jersey` with no region or city, one of the
  "Country only" capitals, until 2026-10-15 (see "Territories with no
  region tier": region `Jersey` by `CITY_STATES`, `city [8]`, the parishes,
  instead of the vingtaines at 9).

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

## Kyrgyzstan (KG)

`region [4]`, `city [6]`, `REGION_CITIES` for Osh.

- **Osh had no city.** `Ош шаары` (Osh City) is a level-4 region with
  nothing at level 6 inside. Fixed 2026-10-16 by `REGION_CITIES`, shown as
  `Ош` / Osh. See "Regions that are one town had no city" (Cross-cutting patterns).

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

`region [4]` (counties), `city []`, `VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-14 and 2026-10-15. Hole fill: places of
  50,000+ named 0 → 3 of 5, no city 3 → 0, Monrovia resolves. Gbarnga,
  Ganta and Zwedru still answered `Zone 3`, `Zone 4` and `Zone 2`: level 8
  holds only the numbered zones inside a few towns (0.2% of the country),
  which won their land over the fill. With `city []` the fill names it all:
  places of 5,000+ named 19 → 22 of 22, 50,000+ 5 of 5.
- **The region was the district.** Changed 2026-10-15. `region [6]` came
  from the generated table and is the ~136 districts (`Greater Monrovia`,
  `Jorquelleh`); the 15 counties, Liberia's first-level division and
  GeoNames' admin1, are level 4. Monrovia is in `Montserrado County` now.

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

## Lithuania (LT)

`region [5]` (municipalities), `city [8, 6]`, `primaryLevel: 8`,
`coverageGapFill: [6]`.

- **Cities had no city, towns answered their eldership.** Fixed
  2026-10-15. Vilnius, Kaunas, Klaipėda, Šiauliai and Panevėžys answered
  their city municipality with `city -`, Trakai `Trakų seniūnija`.
  `city [6]` was the elderships (seniūnija, 98.1%): rural districts
  around a town, and none inside the city municipalities. Level 8 holds
  the settlements, towns and villages. Settlements are primary now, the
  elderships fill the land between them. Places of 5,000+ named 28 → 56
  of 71, no city 29 → 0 (the rest are Vilnius and Kaunas neighbourhoods
  answering their city); 50,000+ 0 → 6 of 6. Vilnius resolves.

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

`region [4]`, `city [6]` (100.8%), `REGION_CITIES` for Kuala Lumpur,
Putrajaya and Labuan.

- **The federal territories had no city.** Kuala Lumpur (3.1412,
  101.68653) returned `Kuala Lumpur`, `city -`, and so did Putrajaya: each
  is a federal territory at the region level with nothing at level 6
  inside it. Fixed 2026-10-13 by `REGION_CITIES`, which emits each
  territory polygon as the city too (see "Capitals that are their own
  region"). Labuan, the third, is an island territory whose town
  (Victoria) is not the whole of it, and was not listed at first. It is
  since 2026-10-16: the city tier is the districts (daerah), and Labuan is
  one district-sized territory with no district inside, so `Labuan` is the
  grain every other Malaysian answer has. See "Regions that are one town had no city" (Cross-cutting patterns).

## Mali (ML)

`region [4]`, `city [6]` (cercles, 86.3%), city hole fill.

- **Ménaka had no city.** The region has no cercles in OSM. Fixed
  2026-10-16 by the city hole fill (Ménaka, Andéranboukan, Inékar). See
  "Regions that are one town had no city" (Cross-cutting patterns).

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

## Montenegro (ME)

`region [6]` (municipalities), `city [8]` (9.6%), city hole fill.

- **Most municipalities had no city.** Cetinje (42.3931, 18.9115) and
  cities500 places in 16 more municipalities answered `city -`. Fixed 2026-10-16 by
  the city hole fill. Ibarac, a village of 3,135 next to Rožaje, now
  answers its own name instead of Rožaje. See "Regions that are one town had no city" (Cross-cutting patterns).

## Namibia (NA)

`region [4]`, `city [8]` (0.1%).

- **Okahandja resolved to its region only.** Fixed 2026-10-14.
  -21.979981, 16.910706 returned `Otjozondjupa Region`, `city -`. City
  coverage is 0.1%, so Namibia has no real city tier; the Voronoi hole fill
  (`VORONOI_CITY_FALLBACK_HOLES`) names every cities500 place's land
  (places of 50,000+ named 1 → 4 of 4).

## Netherlands (NL)

`region [4]`, `city [10]` (110.8%), `regionOutside [8]` (the Caribbean
islands), the hole fill on those islands only.

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

- **Bonaire, Saba and Sint Eustatius had no region.** Fixed 2026-10-15.
  The Caribbean Netherlands are part of the Netherlands (special
  municipalities, *openbare lichamen*; see
  <https://nl.wikipedia.org/wiki/Caribisch_Nederland> and
  <https://www.centruminternationaalrecht.nl/-/is-er-verschil-tussen-caribisch-nederland-en-het-caribisch-deel-van-het-koninkrijk-der-nederlanden->),
  and OSM has them inside the
  Netherlands' `admin_level=2` relation, so the country was right; but they
  are in no province (level 4) and have no level-10 woonplaatsen, so all 10
  cities500 places there answered "Netherlands" alone. OSM has each island at
  level 8, next to the gemeenten: Bonaire (relation 2324450), Saba
  (2324451), Sint Eustatius (2324452). They are the regions now, through a new option,
  `regionOutside`: a relation at a listed level is a region only when its
  point lies in no region of the chosen level, which of NL's level-8
  relations only the three islands do (the build log names them). The towns
  come from the Voronoi hole fill, limited to those three regions
  (`VORONOI_CITY_FALLBACK_HOLES_IN`), so the European woonplaatsen are
  untouched. GeoNames files the islands under their own ISO 3166-1 code, BQ,
  not NL; OSM's only BQ relation is Caribisch Nederland (1216720), tagged
  `boundary=legal` and noted as "not an administrative entity", which is no
  country here. `GEONAMES_COUNTRY_OF` reads cities500's BQ places as NL.
  12.15, -68.26667 is Bonaire / Kralendijk, 12.23762, -68.33059 Bonaire / Dorp
  Rincon, 17.62652, -63.24971 Saba / The Bottom, 17.48303, -62.9864 Sint
  Eustatius / Oranjestad. Kralendijk is in the capitals table under the
  Netherlands. No place outside the three islands changed. Windwardside, on
  Saba, is not in cities500, so it answers Upper Hell's Gate, its nearest
  place there (which GeoNames gives a population of 2,810, more than Saba
  has).
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

## North Korea (KP)

`region [4]`, `city [6]`, `REGION_CITIES` for Rason.

- **Rason had no city.** `라선시` is a level-4 special city whose two
  districts (Rajin, Sŏnbong) are level 7, below the city level. Fixed
  2026-10-16 by `REGION_CITIES`. Kaesong (`개성시`) was tried too and
  skipped: it already holds 3 cities, so its GeoNames point answering
  `city -` is a gap between them. See "Regions that are one town had no city" (Cross-cutting patterns).

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

## Paraguay (PY)

`region [4]`, `city [8, 6, 7]`, `primaryLevel: 8`, `coverageGapFill: [6, 7]`,
`VORONOI_CITY_FALLBACK_HOLES`.

- **Missing districts.** Fixed 2026-10-15. 27 of 66 places of 5,000+ had
  no city (Villarrica, Coronel Oviedo, Caacupé, Concepción). The districts
  are at level 8 in most departments, 6 in Paraguarí and 7 in Caazapá, and
  many (Coronel Oviedo, Caacupé, Horqueta, Piribebuy) have no relation at
  all. Levels 6 and 7 fill what 8 leaves, and the hole fill names the
  rest. Named 37 → 64 of 66, no city 27 → 0; 50,000+ 15 → 18 of 19. The
  two left are suburbs answering the neighbouring district (Fernando de
  la Mora → San Lorenzo).

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
- **Whole blocks with a country but no region or city.** Fixed
  2026-10-16. Seven reported points in central/eastern Poland returned
  `Poland`, `region -`, `city -`, as did 132 cities500 places (Czechowice-
  Dziedzice, 34,703 people, the largest).

  Cause: regions were keyed by (country, level, name), and when two
  relations shared a key the one with the larger bbox was kept. Poland
  repeats ten powiat names across voivodeships, so one of each pair was
  lost, and its gminas were dropped by `emitCity`'s "no region, no city"
  rule. Nowe Skalmierzyce was not dropped but went to the next region,
  Kalisz.

  The ten pairs, with the build's relation ids:

  | Name | Relations |
  |---|---|
  | powiat bielski | a5606671, a4831575 |
  | powiat brzeski | a5332339, a5342183 |
  | powiat grodziski | a673243, a5385077 |
  | powiat krośnieński | a5327711, a5271315 |
  | powiat nowodworski | a3106173, a5196693 |
  | powiat opolski | a5384841, a5323819 |
  | powiat ostrowski | a5409379, a5368989 |
  | powiat średzki | a5126187, a903023 |
  | powiat świdnicki | a5599793, a902721 |
  | powiat tomaszowski | a5426157, a5379245 |

  Fix: namesakes whose bboxes do not touch are all kept, as
  `RegionCandidate`s keyed and named `name [id]` throughout ingest. The
  hierarchy's `regionLocalNames` gives each its OSM name back, so both
  show as `powiat ostrowski` (their `name:en`, Ostrów Wielkopolski County
  and Ostrów Mazowiecka County, tells them apart). Same-named relations
  whose bboxes touch are still treated as duplicates (larger bbox wins),
  now logged.

  Measured against the previous build:
  - all 134 changed cities500 places are Polish: the 132 and the two
    Skalmierzyce places;
  - Poland has no place without a region left.

  The build splits other namesakes too: MP's Northern Islands Municipality
  (9 island relations), CN, TN, and ES "Cantabria - Castilla y León",
  plus NL's two Bergen gemeenten, which are not regions there. None of
  them changed a cities500 answer.

  Cases: the seven points are fixed cases, each pinned to the English
  county name that tells its namesake apart. Two more cases cover the
  other halves: Ostrów Mazowiecka, and Czechowice-Dziedzice in Bielsko
  County.

- **Poland may be another England.** *(open)* The user's note, with no
  coordinate: the gmina tier probably misses cities that are their own
  county-level relation. See "United Kingdom" for the mechanism and
  "Town inside its own rural gmina" above for the six pairs already found.

## Portugal (PT)

`region [6]`, `city [8]` (100.7%), `VORONOI_REGION_HOLES`.

- **Madeira and the Azores had no region.** Fixed 2026-10-15. 104 places
  answered the country only: the region level is the mainland districts,
  and the two autonomous regions are not districts, so their parishes were
  dropped. The region hole fill makes them regions `Madeira` and `Azores`
  (GeoNames admin1 PT.10, PT.23); 83 places of 1,000+ there gained a city.
- **Lisboa is not a city.** *(open)* Lisboa is `place=city` at level 7
  (the concelho tier, 292 nationally), but Lisbon's freguesias (Alvalade,
  Belém, Benfica, Carnide, ...) are tagged at level 8, already primary.
  Applied as `city: [8, 7]`, verified no effect, reverted. The other 291
  concelhos already resolve through an identically-named level-8 entry. See
  Estonia.

## Qatar (QA)

`region [4]`, `city []`, `REGION_CITIES` for Doha, `VORONOI_CITY_FALLBACK_HOLES`.

- **Thin city tier.** Fixed 2026-10-14. Places of 50,000+: named 2 → 5 of
  6, no city 3 → 0. The sixth is Old Airport (`المطار القديم`), a real
  level-10 polygon around a place GeoNames calls differently.
- **Doha answered its neighbourhoods.** Fixed 2026-10-15. `city [10]` is
  Doha's neighbourhoods (1.2% of the country), and the hole fill named the
  gaps between them after GeoNames' neighbourhood points (PPLX, 21 of
  Qatar's 43). Doha itself only passed because one neighbourhood is
  called `Mushayrib Downtown Doha`. Now `city []`, the Doha municipality is
  the city `Doha` (`REGION_CITIES`), and the fill, without PPLX sites,
  names the other municipalities' towns (Ar Rayyān, Al Wakrah, Al Khawr).
  "Named for the point's city" falls 30 → 15 of 36 places of 5,000+,
  because those are Doha's neighbourhoods and now answer `Doha`; no city
  stays 0.

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

## Solomon Islands (SB)

`region [4]`, `city [5]` (28.5%), `REGION_CITIES` for Honiara.

- **Honiara had no city.** A level-4 region with only level-9 wards inside.
  Fixed 2026-10-16 by `REGION_CITIES`. The hole fill was not used: it would
  have named Honiara's wards (Kukum, Vura, ...), which GeoNames lists as
  places. See "Regions that are one town had no city" (Cross-cutting patterns).

## Somalia (SO)

- **Somaliland resolves to no country.** 10.611344, 47.369614 returned
  `country -`: Natural Earth's `Somaliland` (`SOL`) has `ISO_A2_EH` `-99`
  and is dropped. Fixed by the OSM country outlines, whose Somalia relation
  includes Somaliland: it now answers `Somalia`. Its regions and cities
  resolve since candidates Natural Earth places nowhere get their country
  from the outlines: 10.611344, 47.369614 is `Sanaag` / `Ceerigaabo` (see
  "Places Natural Earth puts at sea were dropped").

## South Korea (KR)

`region [4]`, `city [6]`, `REGION_CITIES` for Sejong.

- **Sejong had no city.** `세종특별자치시` is a level-4 special city with
  level-8 dong inside and nothing at level 6. Fixed 2026-10-16 by
  `REGION_CITIES`. See "Regions that are one town had no city" (Cross-cutting patterns).

## Sri Lanka (LK)

`region [4]` (146.5%, territorial waters included), `city [5]`: the 25
districts.

- **Colombo answers Colombo District.** *(open)* Reported 2026-10-16 by the
  user. 6.927811, 79.862537 returns `region Western Province`, `city Colombo
  District`; it should be Colombo. The capitals check passes anyway, since
  `Colombo` is a whole word of `Colombo District` (`namedFor`), so this one
  is a case with the exact name. OSM has Colombo at level 8 (relation 16132,
  Colombo Municipal Council, 46.8 km^2), but level 8 holds only a handful of
  towns (Colombo, Galle, Matara, Weligama, Moragolla), and level 6 only 15
  divisions (1,698 km^2). Likely fix: the India shape, level 8 primary with
  the districts filling by coverage (`primaryLevel: 8`, `coverageGapFill:
  [5]`).

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

`region [4]`, `city [8]` (Lomé only), `VORONOI_CITY_FALLBACK_HOLES`.

- **Prefecture-grain cities.** Fixed 2026-10-15. The hole fill
  (2026-10-14) named Lomé and the south, where the prefectures are missing,
  but the north kept answering the prefecture: Sokodé was `Tchaoudjo`, Kara
  `Kozah`, Dapaong `Préfecture de Kpendjal`. Level 6 is the 39 prefectures
  (58.6% of the country), not towns; OSM has no commune relations except
  Lomé (level 8). `city [8]` keeps Lomé's real outline and lets the fill
  name the rest. Places of 5,000+ named 21 → 32 of 32, 50,000+ 5 → 8 of 8.

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
  named 2, with no city 39. Hole fill: 40 of 41 named, no city 1.
- **Mbale had no city.** Fixed 2026-10-15. 1.08209, 34.17503 answered
  `Mbale City` with `city -`. Level 6 holds a few counties and towns, and
  `Bugisa sub-region`, 2,483 km² over five districts and resolved to
  Sironko. As a real city it took the fill's sites in Mbale City, then
  lost every cell there to the smaller region. A real city of a hole-fill
  country that lies more than half in regions other than its own is now
  dropped (`shareInOtherRegions`, sampled on a grid; land in no region
  counts for neither). Measured on every real city of the 21 countries
  first: Bugisa is 84% elsewhere, the next is 50% (Viana, split between
  Luanda and Icolo e Bengo). The first try also counted land its own
  region shares with an overlapping one, which dropped 853 Philippine and
  68 Georgian cities under the level-3/level-4 gap-fill regions; own
  region land is never elsewhere now. Places of 5,000+ named 158 → 163 of
  163, 50,000+ 41 of 41.

## Ukraine (UA)

`region [4]`, `city [7]` (99.7%), `REGION_CITIES` for Kyiv.

- **Kyiv has a region and no city.** 50.441108, 30.527229 returned
  `Київ / Kyiv`, `city -`; the expected city is `Kyiv`. Fixed 2026-10-13 by
  `REGION_CITIES`, which emits the region polygon as the city too (see
  "Capitals that are their own region").

## United Arab Emirates (AE)

`region [4]` (emirates), `city [5]` (Abu Dhabi), `REGION_CITIES` for Dubai,
`VORONOI_CITY_FALLBACK_HOLES`.

- **No city tier.** Fixed 2026-10-15. 61 of 94 places of 5,000+ had no
  city (Dubai and every place in it, Fujairah, Hatta), and the rest
  answered a neighbourhood (Abu Dhabi `حدبة الزعفرانة`, Ajman `الجرف`):
  `city [8]` was the neighbourhoods and suburbs (373 relations, none in
  most of Dubai). OSM has no town tier in between: level 5 is the city of
  Abu Dhabi (799 km²), level 6 Abu Dhabi's three municipal regions (Abu
  Dhabi, Al Ain, Al Dhafra, up to 30,000 km² of desert). `city [5, 6]` with
  6 as gap-fill was tried first and made Zayed City and Ruwais answer
  `منطقة الظفرة` (Al Dhafra), so 6 is out. Abu Dhabi's city keeps its
  outline, Dubai's emirate is the city `Dubai` (Dubai Municipality is the
  emirate), and the hole fill names the other towns (Sharjah, Khor Fakkan,
  Al Ain, Zayed City), PPLX neighbourhoods excluded (see "Countries with a
  thin city tier"). No city 61 → 0; named 27 → 47 of 94, the rest being
  Dubai's neighbourhoods answering `Dubai` and Abu Dhabi's suburbs
  answering `Abu Dhabi`. Abu Dhabi resolves.

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
- **Carson City has no city.** *(open)* Reported 2026-10-15:
  39.166237, -119.766877 returns `Nevada`, `city -`; the expected city is
  `Carson City`. Nevada's capital is a consolidated city-county, and OSM
  has it only at the county level (relation 332921, `admin_level=6`), so
  the level-8 city tier has nothing there. Not fixed yet: other
  consolidated or independent cities may have the same shape.
- **"Town of ..." around cities in some states.** *(open)* Reported
  2026-10-15: in Michigan, New York, Pennsylvania, Wisconsin and Minnesota
  the land around a city answers a town or township (`Town of ...`,
  `... Township`), in the other states it answers the state with no city.
  These states have civil townships or towns (minor civil divisions) that
  tile the land outside the incorporated places, at level 8 like the cities
  (level 7 in New York, which `overrides` uses as gap-fill), so they show
  up as cities; elsewhere unincorporated land has no such unit. The same
  question as "Township around a village": whether a township is a city.

- **Washington, D.C. had no city.** 38.89511, -77.03637 returned `District
  of Columbia`, `city -`: the district is a level-4 region with nothing at
  level 8 inside it. Fixed 2026-10-13 by `REGION_CITIES`, with the city
  named `Washington` (see "Capitals that are their own region").

## Uzbekistan (UZ)

`region [4]`, `city [6]`, `VORONOI_REGION_HOLES`.

- **Karakalpakstan had no region.** Fixed 2026-10-15. 24 places (Nukus,
  332,500, Qŭnghirot, Mŭynoq) answered the country only: the autonomous
  republic is not among the level-4 viloyats, and its districts were
  dropped for having no region. The region hole fill makes it a region
  `Karakalpakstan` (GeoNames admin1 UZ.09); Nukus answers
  `Karakalpakstan`, `Nókis qalası hákimiyatı`.
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
