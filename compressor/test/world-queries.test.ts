import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CGeoDataReader } from "@ferrybig/cgeodata-reader";
import { openFile } from "@ferrybig/cgeodata-reader/node";

// Spot-checks against the worldwide build, the counterpart of
// zuid-holland-queries.test.ts for everything `countries.md` documents.
// Skipped unless a worldwide .bin exists. Uses CGEODATA_WORLD_BIN if set,
// else the most recently built of data/03-final/world.bin and
// world-high-res.bin (they are built at different times, and a stale one
// would report fixes as broken). The first test below says which file ran
// and warns when it is older than the resolved input it was built from.
//
// Two kinds of case:
// - Plain cases are answers that were fixed (or were never broken) and must
//   stay that way. A failure here is a regression.
// - `todo` cases are the expected answer for a place `countries.md` lists as
//   *(open)*. node:test runs them but reports a failure as "todo", not as a
//   failed suite; once one starts passing, move the entry to the plain list
//   and update countries.md. The `todo` string names the countries.md section.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINAL = path.resolve(__dirname, "../../data/03-final");
const RESOLVED_INPUT = path.resolve(__dirname, "../../data/02-resolved/world/hierarchy.json");

function pickWorldBin(): string | undefined {
  const fromEnv = process.env.CGEODATA_WORLD_BIN;
  if (fromEnv !== undefined) return existsSync(fromEnv) ? fromEnv : undefined;
  return [path.join(FINAL, "world.bin"), path.join(FINAL, "world-high-res.bin")]
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const BIN_PATH = pickWorldBin();
const skip = BIN_PATH === undefined;

/** Any non-empty answer: the tier must resolve, whatever it is called. */
const ANY = Symbol("any");
/** A name the place is known by (local or international), or any of several. */
type Expected = string | readonly string[] | typeof ANY;

interface Case {
  /** Shown as the test title; also what to look for on the map. */
  name: string;
  at: readonly [lat: number, lon: number];
  country?: Expected;
  region?: Expected;
  city?: Expected;
  /** Open issue: the countries.md section that documents why this fails. */
  todo?: string;
}

function matches(actual: { names: readonly string[] } | null | undefined, expected: Expected): boolean {
  if (!actual) return false;
  if (expected === ANY) return true;
  const wanted = typeof expected === "string" ? [expected] : expected;
  return wanted.some((name) => actual.names.includes(name));
}

const CASES: Case[] = [
  // ---- Fixed: must keep resolving ----
  { name: "Seattle is a city, not King County", at: [47.602922, -122.33139], country: "United States of America", region: "Washington", city: "Seattle" },
  { name: "Manhattan (New York override [8, 7])", at: [40.7831, -73.9712], region: "New York", city: "Manhattan" },
  { name: "Brooklyn (New York override [8, 7])", at: [40.6782, -73.9442], region: "New York", city: "Brooklyn" },
  { name: "Belfast (Northern Ireland override)", at: [54.5973, -5.9301], city: "Belfast" },
  { name: "Cardiff (Wales wholeUnits)", at: [51.4816, -3.1791], city: "Cardiff" },
  { name: "Pontypridd (Wales communities)", at: [51.6023, -3.3419], city: "Pontypridd" },
  { name: "Edinburgh (Scotland override)", at: [55.9533, -3.1883], city: "Edinburgh" },
  { name: "Glasgow (Scotland override)", at: [55.8642, -4.2518], city: "Glasgow" },
  { name: "Westminster (GB gap-fill 8)", at: [51.507674, -0.130119], region: "England", city: "City of Westminster" },
  { name: "Maribor (Slovenia Voronoi region + real city)", at: [46.5547, 15.6459], country: "Slovenia", city: "Maribor" },
  { name: "Tripoli (Libya Voronoi city fallback)", at: [32.8872, 13.1913], country: "Libya", city: "Tripoli" },
  { name: "N'Djamena (Chad Voronoi city fallback)", at: [12.1348, 15.0557], country: "Chad", city: "N'Djamena" },
  { name: "Asmara (Eritrea Voronoi city fallback)", at: [15.3229, 38.9251], country: "Eritrea", city: "Asmara" },
  { name: "Riyadh (Saudi Arabia region 4 / city 6)", at: [24.7136, 46.6753], region: "Riyadh Region", city: "Riyadh governorate" },
  { name: "Addis Ababa (Ethiopia region 4 / city 5)", at: [9.03, 38.74], country: "Ethiopia", region: "Addis Ababa", city: "Addis Ababa" },
  { name: "Kabul (Afghanistan region 4 / city 5)", at: [34.5553, 69.2075], region: "Kabul Province" },
  { name: "Taipei (Taiwan city [7, 8])", at: [25.033, 121.5654], region: "Taipei", city: "Xinyi District" },
  { name: "Samarkand (Uzbekistan region 4 / city 6)", at: [39.6548, 66.9597], region: "Samarqand Region", city: "Samarqand shahri" },
  { name: "Wormerveer, not Zaandijk", at: [52.488789, 4.794346], country: "Netherlands", city: "Wormerveer" },
  { name: "Almere, not Huizen", at: [52.333399, 5.237517], city: "Almere" },
  { name: "Soest, not Soesterberg", at: [52.131565, 5.277514], city: "Soest" },
  { name: "Open water off Enkhuizen is Lelystad's (false positive, see Netherlands)", at: [52.683459, 5.295410], region: "Flevoland", city: "Lelystad" },
  { name: "Amsterdam", at: [52.3676, 4.9041], region: "North Holland", city: "Amsterdam" },
  { name: "Paris", at: [48.8566, 2.3522], country: "France", city: "Paris" },

  // ---- Polygon-in-polygon: the inner place already resolves, see the
  // outer's entry in countries.md for the question of what it should be ----
  { name: "Kościan town", at: [52.086468, 16.644287], country: "Poland", city: "Kościan" },
  { name: "Lubin town", at: [51.398777, 16.217194], country: "Poland", city: "Lubin" },
  { name: "Biłgoraj town", at: [50.526087, 22.7211], country: "Poland", city: "Biłgoraj" },
  { name: "Krasnystaw town", at: [50.98826, 23.169994], country: "Poland", city: "Krasnystaw" },
  { name: "Mikashevichy town", at: [52.225276, 27.46891], country: "Belarus", city: "Mikashevichy" },
  { name: "Ubly village", at: [43.710199, -82.935448], country: "United States of America", city: "Ubly" },
  { name: "Portage la Prairie city", at: [49.952987, -98.299484], country: "Canada", city: "Portage la Prairie" },

  // ---- Open: expected answers for places countries.md lists as *(open)* ----
  { name: "Kyiv resolves a city, not only a region", at: [50.441108, 30.527229], country: "Ukraine", city: "Kyiv", todo: "Ukraine" },
  { name: "Poland: whole area without region or city (1)", at: [51.638902, 17.824631], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (2)", at: [51.602666, 20.083008], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (3)", at: [52.229377, 17.273254], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (4)", at: [52.107138, 20.628204], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (5)", at: [52.431106, 20.71455], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (6)", at: [51.147479, 21.968193], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Poland: whole area without region or city (7)", at: [51.137894, 22.846928], country: "Poland", region: ANY, city: ANY, todo: "Poland" },
  { name: "Georgia: Khobi Municipality has a city", at: [42.31667, 41.903229], country: "Georgia", city: ANY, todo: "Georgia" },
  { name: "Egypt/Sudan border strip has a country", at: [21.869146, 33.739014], country: ["Egypt", "Sudan"], todo: "Egypt" },
  { name: "Border artifact: Dutch side of the German border", at: [52.441101, 6.84886], country: "Netherlands", todo: "Border artifacts" },
  { name: "Border artifact: Belgian side of the German border", at: [50.710482, 6.090031], country: "Belgium", todo: "Border artifacts" },
  { name: "Border artifact: Luxembourg side of the German border", at: [49.947409, 6.159039], country: "Luxembourg", todo: "Border artifacts" },
  { name: "Border artifact: French side of the Luxembourg border", at: [49.446226, 5.977764], country: "France", todo: "Border artifacts" },
  { name: "Border artifact: French side of the Belgian border", at: [49.533439, 5.691605], country: "France", todo: "Border artifacts" },
  { name: "Border artifact: Czech side of the German border", at: [50.264491, 12.187872], country: "Czechia", todo: "Border artifacts" },
  { name: "Prague has a city, not only a region", at: [50.087382, 14.421787], country: "Czechia", region: "Praha", city: ANY, todo: "Czechia" },
  { name: "Parkman, Ohio has a city", at: [41.370754, -81.064682], region: "Ohio", city: ANY, todo: "United States" },
  { name: "City of London has a city", at: [51.515046, -0.093212], region: "England", city: ANY, todo: "United Kingdom" },
  { name: "Potters Bar has a city", at: [51.695597, -0.187626], region: "England", city: ANY, todo: "United Kingdom" },
  { name: "Bristol has a city", at: [51.4539, -2.595348], region: "England", city: ANY, todo: "United Kingdom" },
  { name: "North Macedonia has a city", at: [41.432573, 22.011393], country: "North Macedonia", city: ANY, todo: "North Macedonia" },
  { name: "Northern Cyprus has a country", at: [35.257394, 33.731461], country: ["Cyprus", "Turkey"], todo: "Cyprus" },
  { name: "Somaliland has a country", at: [10.611344, 47.369614], country: ANY, todo: "Somalia" },
  { name: "Okahandja has a city", at: [-21.979981, 16.910706], country: "Namibia", city: "Okahandja", todo: "Namibia" },
  { name: "Benguela has a city", at: [-12.600135, 13.393707], country: "Angola", city: "Benguela", todo: "Angola" },
  { name: "Huambo has a city", at: [-12.775308, 15.732937], country: "Angola", city: "Huambo", todo: "Angola" },
  { name: "Vatican (St. Peter's Square) has region and city", at: [41.903323, 12.454001], country: "Vatican", region: ANY, city: ANY, todo: "Vatican" },
  { name: "Vatican (St. Peter's Basilica) is Vatican", at: [41.903786, 12.451823], country: "Vatican", region: ANY, city: ANY, todo: "Vatican" },
  { name: "Monaco is a country with a city", at: [43.73084, 7.421372], country: "Monaco", city: ANY, todo: "Monaco" },
  { name: "Bremen is a city, not only a region", at: [53.079296, 8.801694], country: "Germany", city: "Bremen", todo: "Germany" },
  { name: "Reading is a city (GB gap-fill 6)", at: [51.4556, -0.9693], country: "United Kingdom", city: "Reading", todo: "United Kingdom" },
  { name: "Brighton is a city (GB gap-fill 6)", at: [50.8225, -0.1372], country: "United Kingdom", city: "Brighton and Hove", todo: "United Kingdom" },
  { name: "Terrace, BC is a city, not Kitimat-Stikine", at: [54.5164, -128.6003], country: "Canada", city: "Terrace", todo: "Canada" },
];

let reader: Promise<CGeoDataReader> | undefined;
function world(): Promise<CGeoDataReader> {
  if (!reader) {
    reader = openFile(BIN_PATH!);
  }
  return reader;
}

for (const c of CASES) {
  const options = c.todo !== undefined ? { skip, todo: `countries.md: ${c.todo}` } : { skip };
  test(`${c.at.join(", ")}: ${c.name}`, options, async () => {
    const result = await (await world()).query(c.at[0], c.at[1]);
    const got = `${result.country?.localName ?? "-"} / ${result.region?.localName ?? "-"} / ${result.city?.localName ?? "-"}`;
    for (const tier of ["country", "region", "city"] as const) {
      const expected = c[tier];
      if (expected === undefined) continue;
      assert.ok(matches(result[tier], expected), `${tier}: expected ${expected === ANY ? "any" : JSON.stringify(expected)}, got ${got}`);
    }
  });
}

test("which worldwide .bin the cases ran against", { skip }, (t) => {
  const bin = statSync(BIN_PATH!);
  t.diagnostic(`using ${BIN_PATH} (built ${bin.mtime.toISOString()})`);
  if (existsSync(RESOLVED_INPUT) && statSync(RESOLVED_INPUT).mtimeMs > bin.mtimeMs) {
    t.diagnostic(`WARNING: ${BIN_PATH} is older than ${RESOLVED_INPUT}; rebuild it before trusting failures`);
  }
});
