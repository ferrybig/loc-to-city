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
  fixed Baarle-Hertog's Belgian enclaves). The country *polygons* the
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
  polygons), `VORONOI_REGION_FALLBACK` (Slovenia).
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
    (`cutCountriesOutOfForeignRegions`). Region polygons are simplified
    (~1.1 km), which drops a small hole: Lazio covered the Vatican,
    Provence-Alpes-Côte d'Azur Monaco (Mareterra, outside Monaco's older
    city polygon, answered France), Guangdong Macau, Noord-Brabant the
    Baarle-Hertog enclaves. 304 regions are cut, most by a sliver where a
    simplified region overshot a land border.

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
- **A city inside two overlapping regions gets whichever the R-tree returns
  first.** *(open)* `assignCityRegion` (`regionPolygons.ts`) returns the
  first region in `regionIndex`'s R-tree order whose polygon contains the
  city's representative point, and simplified region polygons overlap
  along their borders. The order depends on the whole tree: adding two
  regions (Monaco's and the Vatican's) moved 593 cities500 points to
  another region, Ninghe District from Tianjin to Hebei among them, and
  cost Taipa (Macau) its city. The city-states are kept out of the tree for
  that reason, so the order is as before, but any other change to the
  region set reshuffles it. A deterministic rule (the region containing
  most of the city's own polygon, or the smallest containing region) would
  end this; it changes the region of every such border city, so it needs
  its own measurement.
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
  districts, or nothing. Seen at: Berlin and Hamburg (Germany), Prague
  (Czechia), Kyiv (Ukraine), Moscow (Russia), Astana (Kazakhstan), Sana'a
  and Aden (Yemen), Tashkent (Uzbekistan), Minsk (Belarus), Yerevan
  (Armenia), Ashgabat (Turkmenistan, fixed by a duplicate relation). The
  levels cannot express this: there is no tier where the city appears as a
  city. What the current primary/gap-fill model *cannot* do is repeat a
  region polygon as a city. An untried mechanism: a short opt-in list of
  "city-state regions" (like `VORONOI_CITY_FALLBACK`) that also emits the
  region polygon as a gap-fill city, which would make Kyiv, Berlin,
  Hamburg, Prague and Moscow answer with their own name without disturbing
  districts elsewhere. A city that has finer districts under a *different*
  name than itself (Tallinn, Mexico City, Lisbon, below) is a separate,
  harder shape: the district polygons tile the city, so a whole-city
  gap-fill never gets the chance to win.
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
  What is still missing is their regions and cities: city/region candidates
  are assigned to a country through Natural Earth, which puts these areas
  in no country, so they are dropped and a lookup there answers the country
  only. Mapping `CYN`/`SOL` onto `CY`/`SO` in `prepare-world.ts` would keep
  them, consistent with the outline.
- **Countries with a thin city tier.** The generated table lists every
  country whose chosen city level covers under 20% of it:
  AO 9.1, AZ 4.2, BB 19.6, BH 0.6, BW 18.1, BZ 5.3, CF 0.2, CV 6.3, DM 0.9,
  GE 4.3, LR 0.2, ME 9.6, MP 3.1, MV 9.7, MW 10.2, NA 0.1, QA 1.2, SX 11.7,
  TT 0.1, UG 6.4, UY 1.3, WS 0.3 (and empty city lists: BM, ER, FJ, GD, GL,
  GW, HM, KN, LC, LS, LY, MR, MS, NE, NR, PW, SC, SH, SZ, TC, VC, VG, VU).
  Egypt, Chad, Eritrea and Libya were handled with the Voronoi fallback;
  none of the others have been examined for whether OSM has a better level
  or whether the fallback is the right tool. *(open)*
- **Capitals.** *(open)* `verify/test/world-queries.test.ts` looks up
  the capital of every country and dependency GeoNames lists one for
  (232; `verify/src/cases.ts`'s `CAPITALS` and `OPEN_CAPITALS` tables carry the
  coordinates and the exact rule) and measured 77 resolving and 155
  not, on `world-high-res.bin` (built 2026-10-12). A capital resolves when
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
  - **Country only** (29): neither a region nor a city covers the point.
    Microstates and small territories, and also Manila (Philippines),
    Tbilisi (Georgia) and Skopje (North Macedonia), which have their own
    sections. `CITY_STATES` (Monaco, Vatican) is the mechanism for the
    microstates among them.
    Andorra la Vella (Andorra); The Valley (Anguilla); Oranjestad (Aruba);
    Nassau (Bahamas); George Town (Cayman Is.); Willemstad (Curaçao);
    Stanley (Falkland Is.); Port-aux-Français (Fr. S. Antarctic Lands);
    Tbilisi (Georgia); Gibraltar (Gibraltar); Bissau (Guinea-Bissau); Saint
    Helier (Jersey); Tarawa (Kiribati); Kuwait City (Kuwait); Valletta
    (Malta); Majuro (Marshall Is.); Alofi (Niue); Skopje (North Macedonia);
    Manila (Philippines); Adamstown (Pitcairn Is.); Grytviken (S. Geo. and
    the Is.); Jamestown (Saint Helena); San Marino (San Marino); Philipsburg
    (Sint Maarten); Gustavia (St-Barthélemy); Marigot (St-Martin);
    Saint-Pierre (St. Pierre and Miquelon); Funafuti (Tuvalu); Mata-Utu
    (Wallis and Futuna Is.)
  - **The capital is only a region** (40): the region carries the
    capital's name and no city covers the point. This is the previous
    entry ("Capitals that are their own region"), which has the untried
    mechanism for it; Kyiv, Prague and Bremen are tracked by their own
    cases there.
    Vienna (Austria); Baku (Azerbaijan); Minsk (Belarus); Hamilton
    (Bermuda); Thimphu (Bhutan); Gaborone (Botswana); Gitega (Burundi);
    Praia (Cabo Verde); Bangui (Central African Rep.); Yamoussoukro (Côte
    d'Ivoire); Nicosia (Cyprus); Prague (Czechia); Kinshasa (Dem. Rep.
    Congo); Djibouti (Djibouti); Mbabane (eSwatini); Banjul (Gambia);
    Berlin (Germany); Conakry (Guinea); Pristina (Kosovo); Riga (Latvia);
    Maseru (Lesotho); Monrovia (Liberia); Vilnius (Lithuania); Lilongwe
    (Malawi); Kuala Lumpur (Malaysia); Male (Maldives); Bamako (Mali);
    Port Louis (Mauritius); Saipan (N. Mariana Is.); Yaren (Nauru);
    Bucharest (Romania); Moscow (Russia); Castries (Saint Lucia);
    Bratislava (Slovakia); Ljubljana (Slovenia); Honiara (Solomon Is.);
    Basseterre (St. Kitts and Nevis); Dushanbe (Tajikistan); Port of Spain
    (Trinidad and Tobago); Kyiv (Ukraine)
  - **A region around it, no city** (26): the region is a province,
    parish or federal district (Washington is "District of Columbia", New
    Delhi is "Delhi", Brasília is "Distrito Federal"), and no city covers
    the point. Washington, New Delhi and Brasília are the capital's own
    jurisdiction under a different name, so they probably need the same
    mechanism as the previous shape.
    Manama (Bahrain); Bridgetown (Barbados); Belmopan (Belize); Brasília
    (Brazil); Road Town (British Virgin Is.); Quito (Ecuador); Suva
    (Fiji); Nuuk (Greenland); Saint George's (Grenada); Saint Peter Port
    (Guernsey); New Delhi (India); Macau (Macao); Antananarivo
    (Madagascar); Plymouth (Montserrat); Ngerulmud (Palau); Kigali
    (Rwanda); Apia (Samoa); Victoria (Seychelles); Kingstown (St. Vin. and
    Gren.); Khartoum (Sudan); Lomé (Togo); Nuku‘alofa (Tonga); Tunis
    (Tunisia); Cockburn Town (Turks and Caicos Is.); Washington (United
    States of America); Port-Vila (Vanuatu)
  - **A district, ward or parish instead of the capital** (60): the
    country's city tier is finer than its capital (Beijing, Tokyo, Seoul,
    Bangkok, Lisbon, London and many more). The capital's own boundary
    exists in OSM for most of these, usually a level above the one the
    country is configured at; check the country's `admin_level` before
    assuming a data gap. Where the district polygons tile the capital, a
    whole-city gap-fill never wins (see Tallinn, Mexico City, Lisbon).
    Algiers (Algeria); Saint John’s (Antigua and Barb.); Buenos Aires
    (Argentina); Yerevan (Armenia); Canberra (Australia); Brussels
    (Belgium); Porto-Novo (Benin); Bandar Seri Begawan (Brunei); Phnom
    Penh (Cambodia); Beijing (China); Brazzaville (Congo); San José (Costa
    Rica); Havana (Cuba); Tallinn (Estonia); Accra (Ghana); Port-au-Prince
    (Haiti); Tegucigalpa (Honduras); Hong Kong (Hong Kong); Baghdad
    (Iraq); Kingston (Jamaica); Tokyo (Japan); Amman (Jordan); Astana
    (Kazakhstan); Nairobi (Kenya); Bishkek (Kyrgyzstan); Vientiane (Laos);
    Beirut (Lebanon); Nouakchott (Mauritania); Mexico City (Mexico);
    Palikir (Micronesia); Ulan Bator (Mongolia); Maputo (Mozambique); Nay
    Pyi Taw (Myanmar); Abuja (Nigeria); Kingston (Norfolk Island);
    Pyongyang (North Korea); Muscat (Oman); Islamabad (Pakistan); Panama
    City (Panama); Port Moresby (Papua New Guinea); Lima (Peru); Lisbon
    (Portugal); Dakar (Senegal); Freetown (Sierra Leone); Singapore
    (Singapore); Mogadishu (Somalia); Pretoria (South Africa); Seoul
    (South Korea); Paramaribo (Suriname); Taipei (Taiwan); Bangkok
    (Thailand); Dili (Timor-Leste); Ankara (Turkey); Charlotte Amalie
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

## Angola (AO)

`region [4]`, `city [6]` (9.1% coverage).

- **Benguela and Huambo resolve to their province only.** *(open)*
  -12.600135, 13.393707 (expected city Benguela) returns `Benguela
  Province` with `city -`; -12.775308, 15.732937 (expected Huambo) returns
  `Huambo Province` with `city -`. With 9.1% of the country covered by the
  chosen level, most of Angola answers with its province. Unexamined:
  whether OSM has a better level (municipios vs comunas), and whether
  Angola belongs in `VORONOI_CITY_FALLBACK` (see "Countries with a thin
  city tier"). Check the OSM extract for these two relations first.

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

## Belarus (BY)

`region [4]`, `city [8, 6]` (99.5% at 8, gap-fill 6).

- **Level 6 gap-fill for Baranavichy.** Level 6 holds 9 `place=city`
  relations (Belarus's major cities below the level-4 ones); 8 of them
  already resolved through an identically-named level-8 entry. Only
  Baranavichy (Баранавічы, 7th-largest city) lacked one; confirmed by
  `world.bin` resolving it to nothing before the fix.
- **Minsk is a level-4 region.** *(open)* See "Capitals that are their own
  region".
- **A village council surrounds Mikashevichy.** *(open)* 52.225276,
  27.468910 resolves to `Мікашэвічы / Mikashevichy` and 52.212235,
  27.444878 to `Сінкевіцкі сельскі Савет` (Sinkevichy rural council), whose
  polygon wraps the town. Here the names do *not* match, so this is the
  "Surrounding rural unit" pattern with a differently named rural unit
  (the council is named after a village, not after the town).

## Brazil (BR)

`region [4]`, `city [9]` (66.6% coverage).

- **Major cities missing despite 66.6% city coverage.** *(open)* Neither
  São Paulo nor Rio de Janeiro (the city, not the state) resolves: `lookup`
  at each city's own coordinates returned `city -`. Re-checked on
  `world-high-res.bin`: -23.5505, -46.6333 now returns `Sé`, a distrito
  (district) of São Paulo, so level 9 is the district tier in the big
  metros and the municipality is level 8 with no competing same-name
  candidate at level 9 at all. Not a tie the tie-break tool's
  (country, name) grouping can resolve. Not yet investigated whether
  widening to `[9, 8]` fixes both this and the 6 villages the tie-break
  tool found.

## Burkina Faso (BF)

`region [4]`, `city [6]` (67.2%).

- **Level-8 place-tagged candidates already resolve.** Koudougou,
  Tenkodogo, Bagaré, Lankoué and Toéni share their name with the level-6
  department containing them (departments are named after their chief
  town), so all five already resolve under their own plain name. Gap-filling
  8 in would only put a finer level in contention for cells its container
  already names correctly (the New York / Arkansas risk). Not applied.

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

## Cyprus (CY)

`region [6]`, `city [8]`.

- **Northern Cyprus resolves to no country.** 35.257394, 33.731461 returned
  `country -`: Natural Earth's `N. Cyprus` (`CYN`) and the UN buffer zone
  (`CNM`) have `ISO_A2_EH` `-99`, so they were dropped. Fixed by the OSM
  country outlines (see "Natural Earth's outlines are too coarse"), whose
  Cyprus relation covers the whole island: it now answers `Cyprus`, with no
  region or city yet (see "Countries without an ISO code").

## Czechia (CZ)

`region [4]`, `city [8]` (99.3%).

- **Prague is a region with no city.** *(open)* 50.087382, 14.421787
  returns `region Praha / Prague`, `city -`. Same shape as Berlin: the
  capital is a level-4 region. See "Capitals that are their own region".
- **Place-tagged level-10 villages deliberately not gap-filled.** Level 8
  (`place=municipality`/`city` where tagged) already resolves every sampled
  case, including Brno and all 6 same-named "Babice" municipalities. The
  1,065 of 3,307 level-10 features that are `place=village` look like
  cadastral villages nested inside an already-correct municipality (the
  New York / Arkansas risk: a finer level contesting its container's cells
  for no naming benefit). The one survivor of the strict filter, Petřkovice,
  is a `place=borough` at level 9 inside Ostrava, not a standalone
  settlement.

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

## Ethiopia (ET)

`region [4]`, `city [5]`.

- **Wrong tiers.** Region was the zone tier and city the woreda tier (12.6%
  coverage), so most of the country had no city. Now region 4 (regional
  states) / city 5 (zones, ~100%): Shire -> `Tigray / Semien Mi'irabawi
  Zone`, Yebokile -> `Amhara / East Gojjam`, Addis Ababa -> `Addis Ababa /
  Addis Ababa`.
- **Shire and Yebokile are place nodes only.** *(unsolvable)* See
  "Towns mapped only as place nodes".

## Georgia (GE)

`region [6]`, `city [8]` (4.3%).

- **Khobi Municipality has no city.** *(open)* 42.316670, 41.903229
  returns `Khobi Municipality`, `city -`. City coverage is 4.3% nationally,
  so most of the country answers with its municipality. Not yet checked
  whether OSM simply lacks the polygons (possibly bad OSM data, as
  suspected from the map) or whether another level covers the towns.

## Germany (DE)

`region [4]`, `city [8, 6]` (97.8% at 8, gap-fill 6).

- **Bremen is a city-state with a second relation.** Germany's three
  city-states are `admin_level=4`, the same level as every other Land, so
  they lost the city slot to the region tier. Bremen has a separate
  `place=city` relation at level 6 for the city itself, and `DE: { city:
  [8, 6] }` gap-fills it. Verified at the time that it leaked no Landkreis
  name into normal cities (Munich, Cologne, Frankfurt, Hannover unchanged).
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
- **Berlin and Hamburg are regions with no city.** *(open)* 52.520008,
  13.404954 and 53.551086, 9.993682. Confirmed: neither has a second,
  lower-level relation anywhere in the German extract, unlike Bremen. See
  "Capitals that are their own region".
- **Border artifacts** on the Dutch, Belgian, Luxembourg and Czech borders.
  Fixed by the OSM country outlines: see "Border artifacts".

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

## Jersey and Guernsey (JE, GG)

- **Natural Earth's outlines are 47 and 59 vertices.** Fixed: the country
  outlines are OSM's now (see "Natural Earth's outlines are too coarse").
  Saint Helier still answers `Jersey` with no region or city, one of the
  "Country only" capitals.

## Kazakhstan (KZ)

`region [4]`, `city [6]`.

- **Astana resolves to a city district.** *(open)* 51.142310, 71.433792
  returns `region Астана / Astana`, `city Есіл ауданы / Esil district`. The
  republican cities are level-4 regions, so the only thing below is the
  city's own districts. See "Capitals that are their own region".

## Laos (LA)

`region [4]`, `city [6]`.

- **Region was a district tier, not a province tier.** See Uzbekistan,
  which has the identical story. The generated `region: [6]` was only
  considered because level 6 was the only level listed for the country. Level
  4 is Laos's 18 provinces (100.7%); freed level 6 (148 muang, 100.8%) as a
  real city tier (Pakse resolves to `ເມືອງປາກເຊ`, Pak Sé District), where the
  city had previously been forced onto a 0.2%-coverage level 7.

## Latvia (LV)

`region [5]`, `city [8, 7]` (98.0% at 8, gap-fill 7).

- **Real towns are at level 7, not 8.** Latvia tags its town tier with
  `border_type=town` (72 of 75 level-7 features) and no `place` value, so
  the tie-break tool's `place`-only filter could not see it; found by manual
  investigation. The configured level 8 is `place=civil_parish`/`parish` (511
  of 1,678 level-8 features), the rural tier, so Aizkraukle and Koknese
  resolved to "Aizkraukles pagasts" / "Kokneses pagasts". Level 7 gap-fills
  the real towns (Aizkraukle's level-9 village bbox sits inside its level-7
  town polygon).
- **Rīga and the other six republic cities.** *(open)* They are
  `border_type=city` at level 5, the country's own region level, so no
  level choice fixes it. See "Capitals that are their own region".

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

## Namibia (NA)

`region [4]`, `city [8]` (0.1%).

- **Okahandja resolves to its region only.** *(open)* -21.979981,
  16.910706 returns `Otjozondjupa Region`, `city -`. City coverage is 0.1%
  nationally, so Namibia effectively has no city tier. Candidate for
  `VORONOI_CITY_FALLBACK` after confirming OSM has nothing better (see
  "Countries with a thin city tier").

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
  are too coarse".
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

## Nicaragua (NI)

`region [4]`, `city [6, 10]` (128.1% at 6, gap-fill 10).

- **León, Matagalpa and Jinotepe.** Each has a real `place=city`/`town`
  relation at level 10 nested inside its level-6 `place=municipality`,
  distinct from the far more numerous non-settlement level-10 features
  (hamlets, isolated dwellings, neighbourhoods), which the tie-break
  signal's own `place` filter excludes by tag rather than by level.

## North Macedonia (MK)

`region []`, `city [8]` (98.8%).

- **Region tier removed by hand.** The only level 4/5/6 candidate was
  "Град Скопје" (City of Skopje, 2.3%), one municipality's boundary that
  happens to carry a lower admin level, not a region tier. Set to `region:
  []`. The city tier (level 8) already resolved correctly.
- **41.432573, 22.011393 returns only the country.** *(open)* Reported with
  "missing everything except country": `city -` (and `region -` is
  expected given the line above). At this location the lookup cell is large
  (lat 41.31..41.48, lon 21.80..22.15), which suggests the leaf stopped
  subdividing over a region where no level-8 polygon covers; not yet
  checked whether OSM lacks the municipality here. Note that `region -`
  everywhere in North Macedonia is by design.

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
  (The `world-queries` todo tests encode all seven.)

## Portugal (PT)

`region [6]`, `city [8]` (100.7%).

- **Lisboa is not a city.** *(open)* Lisboa is `place=city` at level 7
  (the concelho tier, 292 nationally), but Lisbon's freguesias (Alvalade,
  Belém, Benfica, Carnide, ...) are tagged at level 8, already primary.
  Applied as `city: [8, 7]`, verified no effect, reverted. The other 291
  concelhos already resolve through an identically-named level-8 entry. See
  Estonia.

## Russia (RU)

`region [4]`, `city [6]` (104.0%).

- **Moscow has a region and no city.** *(open)* 55.7558, 37.6173 returns
  `Москва / Moscow`, `city -`. See "Capitals that are their own region".
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

## Saudi Arabia (SA)

`region [4]`, `city [6]` (99.8%).

- **City was level 10, splitting Riyadh into neighbourhoods.** Now region 4
  (13 provinces) / city 6 (governorates): Riyadh -> `Riyadh Region / Riyadh
  Governorate`, Jeddah -> `Makkah Region / Jeddah Governorate`. Level 10 was
  1.5% coverage and urban neighbourhoods (Thulaim).

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

## Somalia (SO)

- **Somaliland resolves to no country.** 10.611344, 47.369614 returned
  `country -`: Natural Earth's `Somaliland` (`SOL`) has `ISO_A2_EH` `-99`
  and is dropped. Fixed by the OSM country outlines, whose Somalia relation
  includes Somaliland: it now answers `Somalia`, with no region or city yet
  (see "Countries without an ISO code").

## Sudan (SD)

`region [4]`, `city [6]` (72.2%).

- **No city tier, and the zero-region drop is not fully explained.**
  *(open)* Khartoum resolves to neither region nor city although the config
  records 100.5% region coverage, the same pattern the "Regions with no
  cities were dropped" fix (README) was supposed to cover, not yet
  distinguished from it. Deliberately not in `VORONOI_CITY_FALLBACK` yet:
  adding a fallback on top of an unexplained bug risks hiding the second
  issue, the way Slovenia's region gap once masked its city tier being fine.
  Coverage is patchy, not uniformly zero, across this class of country:
  Niamey (Niger) and Nouakchott (Mauritania) resolve all the way to city
  despite low national percentages.

## Taiwan (TW)

`region [4]`, `city [7, 8]`.

- **Villages instead of townships.** City was level 9 (7,545 villages).
  Now `[7, 8]`: townships (level 8) are primary, and the level-7 districts
  (inside special municipalities) gap-fill: Taipei -> `Taipei City / Xinyi
  District`, Kaohsiung -> `Kaohsiung City / Xinxing District`.

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

## Turkmenistan (TM)

`region [4]`, `city [5, 8]`.

- **Ashgabat has a duplicate.** The capital is `place=city` at level 4 (the
  region level) *and* has an identical second relation (same Wikidata id,
  Q23438) at level 8, a genuine duplicate of the same boundary at two levels
  (all tags compared), unlike Astana's districts. The one capital-is-region
  case that turned out fixable. Minsk and Yerevan were checked the same way
  and have no duplicate.

## Ukraine (UA)

`region [4]`, `city [7]` (99.7%).

- **Kyiv has a region and no city.** *(open)* 50.441108, 30.527229 returns
  `Київ / Kyiv`, `city -`; the expected city is `Kyiv`. See "Capitals that
  are their own region".

## United Kingdom (GB)

`region [4]`, `city [6, 8, 10]`, with `overrides` for Wales, Northern Ireland
and Scotland, `wholeUnits` for Wales, and `VORONOI_CITY_FALLBACK_WITHIN_REGIONS`
for Scotland and Northern Ireland.

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
- **Level-6 gap-fill does not show up on the current builds.** *(open)*
  On the 2026-10-10 builds Reading (51.4556, -0.9693), Brighton (50.8225, -0.1372) and Bristol
  (51.453900, -2.595348) all return `England`, `city -`, and
  `cities-filtered.geojsonseq` has no GB feature named `Reading`, `Bristol`
  or `Brighton and Hove`. Level-8 gap-fill still works (`City of Westminster`
  is there and resolves). Same symptom as Bremen and Terrace; whether it is a
  regression or a stale input is undetermined, see Germany. (Kinross, 56.128332, -3.306370, now resolves to
  `Lochgelly` through the Scottish Voronoi cells, not to `Fife`.)
- **London and Potters Bar.** *(open)* 51.515046, -0.093212 (City of London)
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

`region [4]`, `city [8]` (10.7%), with `overrides: { "New York": [8, 7] }`.

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
  above `place=neighbourhood` at level 9: a deeper bug of the Brazil shape,
  not reachable by this gap-fill.

## Yemen (YE)

`region [4]`, `city [6]`.

- **Capital resolves to a district.** *(open)* Sana'a returns `region
  أمانة العاصمة` with `city مديرية الثورة`; Aden is the same pattern one
  level down (its city boundary is the only level-5 feature in Yemen).
  Level 6 (districts, 99.5%) splits the larger cities while being about
  right for rural areas, and no single level fits both. See "Capitals that
  are their own region".
