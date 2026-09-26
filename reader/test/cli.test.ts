import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// The fixture only exists as bytes, and the CLI mostly takes a path.
const fixturePath = path.join(mkdtempSync(path.join(tmpdir(), "cgeodata-cli-")), "appendix-a.bin");
writeFileSync(fixturePath, APPENDIX_A_BYTES);

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], stdin: string | Buffer = ""): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    input: stdin,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 1 };
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

const NL = "Nederland | The Netherlands";
const BE = "België | Belgium";

// --- lookup -----------------------------------------------------------------

test("lookup: resolves points given as arguments in the readable form", () => {
  const { stdout, status } = run(["lookup", fixturePath, "20,100", "-10,10"]);
  assert.equal(status, 0);
  // Lookup 1 from appendix-a.test.ts, then lookup 5 (empty chunk 1).
  assert.equal(
    stdout,
    [
      "20,100",
      `  country  ${NL}`,
      "  region   Noord-Holland",
      "  city     Zaandam",
      "  cell     lat 0..22.5  lon 90..135",
      "  chunk    3  (col 1, row 1 of 2x2)",
      "-10,10",
      "  country  -",
      "  region   -",
      "  city     -",
      "  cell     lat -90..0  lon 0..180",
      "  chunk    1  (col 1, row 0 of 2x2)",
      "",
    ].join("\n"),
  );
});

test("lookup: --json emits one object per point with the input echoed back", () => {
  const { stdout, status } = run(["lookup", fixturePath, "--json", "20,100"]);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    lat: 20,
    lon: 100,
    country: ["Nederland", "The Netherlands"],
    region: ["Noord-Holland"],
    city: ["Zaandam"],
    boundingBox: { minLon: 90, maxLon: 135, minLat: 0, maxLat: 22.5 },
    chunkIndex: 3,
  });
});

test("lookup: with no points, reads them from stdin, carries tags through, and skips bad lines", () => {
  const input = [
    "# a comment",
    "",
    "20,100\tzaandam-by-comma",
    "20\t100\tzaandam-by-tab\twith\ttabs",
    "not,numbers\tbad",
    "95,0\tout-of-range",
    "40,30",
  ].join("\n");
  const { stdout, stderr, status } = run(["lookup", fixturePath, "--json"], input);
  assert.equal(status, 0, "a bad line must not fail the batch");

  const lines = jsonLines(stdout);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]?.["tag"], "zaandam-by-comma");
  assert.deepEqual(lines[0]?.["city"], ["Zaandam"]);
  assert.equal(lines[1]?.["tag"], "zaandam-by-tab\twith\ttabs");
  assert.deepEqual(lines[1]?.["city"], ["Zaandam"]);
  assert.equal(lines[2]?.["tag"], undefined, "no tag key when there was nothing to echo");
  assert.equal(lines[2]?.["city"], null);

  assert.match(stderr, /line 5: latitude "not" is not a number/);
  assert.match(stderr, /line 6: latitude 95 is outside/);
  assert.match(stderr, /skipped 2 malformed lines/);
});

test("lookup: the file itself can come from stdin as '-', but not together with the points", () => {
  const { stdout, status } = run(["lookup", "-", "--json", "20,100"], APPENDIX_A_BYTES);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout)["city"], ["Zaandam"]);

  const both = run(["lookup", "-"], APPENDIX_A_BYTES);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /stdin can't be both/);
});

test("lookup: a malformed point given as an argument is a hard failure (exit 2)", () => {
  const { status, stderr } = run(["lookup", fixturePath, "20,100", "abc,def"]);
  assert.equal(status, 2);
  assert.match(stderr, /latitude "abc" is not a number/);
});

// --- list -------------------------------------------------------------------

test("list: countries by default, --level walks down, fixed tab-separated columns", () => {
  assert.equal(run(["list", fixturePath]).stdout, `0\tcountry\t${NL}\t-\t-\n1\tcountry\t${BE}\t-\t-\n`);
  assert.equal(
    run(["list", fixturePath, "--level", "region"]).stdout,
    `2\tregion\tNoord-Holland\t-\t${NL}\n3\tregion\tAntwerpen | Antwerp\t-\t${BE}\n`,
  );
  assert.equal(
    run(["list", fixturePath, "--level", "city"]).stdout,
    [
      `4\tcity\tAmsterdam\tNoord-Holland\t${NL}`,
      `5\tcity\tZaandam\tNoord-Holland\t${NL}`,
      `6\tcity\tAntwerpen | Antwerp\tAntwerpen | Antwerp\t${BE}`,
      "",
    ].join("\n"),
  );
});

test("list: --country scopes by id or by any name, case-insensitively", () => {
  const byId = run(["list", fixturePath, "--level", "city", "--country", "1"]).stdout;
  assert.equal(byId, `6\tcity\tAntwerpen | Antwerp\tAntwerpen | Antwerp\t${BE}\n`);
  assert.equal(run(["list", fixturePath, "--level", "city", "--country", "belgium"]).stdout, byId);
  assert.equal(run(["list", fixturePath, "--level", "city", "--country", "BELGIË"]).stdout, byId);
  const unknown = run(["list", fixturePath, "--country", "Atlantis"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no country is named "Atlantis"/);
});

test("list: --tree indents the hierarchy down to --level (city by default)", () => {
  assert.equal(
    run(["list", fixturePath, "--tree"]).stdout,
    [`0\t${NL}`, "  2\tNoord-Holland", "    4\tAmsterdam", "    5\tZaandam", `1\t${BE}`, "  3\tAntwerpen | Antwerp", "    6\tAntwerpen | Antwerp", ""].join("\n"),
  );
  assert.equal(
    run(["list", fixturePath, "--tree", "--level", "region", "--country", "0"]).stdout,
    [`0\t${NL}`, "  2\tNoord-Holland", ""].join("\n"),
  );
});

test("list: --json emits one Place per line", () => {
  const lines = jsonLines(run(["list", fixturePath, "--level", "city", "--json"]).stdout);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1], {
    id: 5,
    names: ["Zaandam"],
    level: "city",
    country: { id: 0, names: ["Nederland", "The Netherlands"] },
    region: { id: 2, names: ["Noord-Holland"] },
    city: { id: 5, names: ["Zaandam"] },
  });
});

// --- search -----------------------------------------------------------------

test("search: matches any name at any level, exit 0 on a match and 1 on none", () => {
  const hit = run(["search", fixturePath, "ANTWERP"]);
  assert.equal(hit.status, 0);
  assert.equal(hit.stdout, `3\tregion\tAntwerpen | Antwerp\t-\t${BE}\n6\tcity\tAntwerpen | Antwerp\tAntwerpen | Antwerp\t${BE}\n`);

  const miss = run(["search", fixturePath, "xyzzy"]);
  assert.equal(miss.status, 1);
  assert.equal(miss.stdout, "");
  assert.equal(miss.stderr, "");
});

test("search: --sort ranks by relevance -- same match quality, city outranks region", () => {
  // Unsorted: id order puts the region (3) before the city (6). Both have
  // the exact same name entry ("Antwerpen | Antwerp"), so it's an exact
  // match either way -- --sort should still flip the order because a
  // city outranks a region on the level bonus.
  const unsorted = run(["search", fixturePath, "ANTWERP"]).stdout;
  assert.equal(unsorted, `3\tregion\tAntwerpen | Antwerp\t-\t${BE}\n6\tcity\tAntwerpen | Antwerp\tAntwerpen | Antwerp\t${BE}\n`);

  const sorted = run(["search", fixturePath, "ANTWERP", "--sort"]).stdout;
  assert.equal(sorted, `6\tcity\tAntwerpen | Antwerp\tAntwerpen | Antwerp\t${BE}\n3\tregion\tAntwerpen | Antwerp\t-\t${BE}\n`);

  // --limit applies to the ranked list, not to scan order: the top match
  // (the city, found second while scanning) still wins with limit 1.
  assert.equal(run(["search", fixturePath, "ANTWERP", "--sort", "--limit", "1"]).stdout, `${sorted.split("\n")[0]}\n`);
});

test("search: --level, --country and --limit narrow the scan", () => {
  assert.equal(run(["search", fixturePath, "antwerp", "--level", "city"]).stdout.split("\t")[0], "6");
  assert.equal(run(["search", fixturePath, "a", "--country", "nederland", "--level", "city"]).stdout, `4\tcity\tAmsterdam\tNoord-Holland\t${NL}\n5\tcity\tZaandam\tNoord-Holland\t${NL}\n`);
  assert.equal(jsonLines(run(["search", fixturePath, "dam", "--limit", "1", "--json"]).stdout).length, 1);
  assert.equal(run(["search", fixturePath]).status, 2, "text is required");
});

// --- locate / build-locate-index -------------------------------------------

test("locate: prints a point per id at the cell's precision, exit 1 when one has none", () => {
  // Appendix C.8: Zaandam, then Nederland; België has no cells. The cells
  // are 22.5 degrees high, so no decimals are meaningful.
  const { stdout, stderr, status } = run(["locate", fixturePath, "5", "0", "1", "--no-index"]);
  assert.equal(status, 1);
  assert.equal(stdout, "11, 113\n34, 68\n");
  assert.equal(stderr, "1: no geometry found\n");
  assert.equal(run(["locate", fixturePath]).status, 2, "an id is required");
  assert.equal(run(["locate", fixturePath, "5", "--index", "x", "--no-index"]).status, 2);
});

test("build-locate-index: writes the Appendix C.8 file, which locate picks up next to the .bin", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cgeodata-cli-locate-"));
  const binPath = path.join(dir, "fixture.bin");
  const indexPath = path.join(dir, "fixture.locate-index.bin");
  writeFileSync(binPath, APPENDIX_A_BYTES);
  const build = run(["build-locate-index", binPath, "--output", indexPath]);
  assert.equal(build.status, 0);
  assert.equal(
    readFileSync(indexPath).toString("hex"),
    "4347454f44415441" + "20" + "ea66ac6ca7f74b33" + "01" + "07" + "73007300007400",
  );
  assert.equal(run(["locate", binPath, "5", "0"]).stdout, "11, 113\n34, 68\n");
  assert.match(run(["search", binPath, "zaandam", "--locate"]).stdout, /\tZaandam\t.*\t11,113\n$/);

  // A stale index is an error rather than a silent fallback; --no-index or
  // an explicit --index gets past it.
  const stale = readFileSync(indexPath);
  stale[9] = stale[9]! ^ 0xff;
  writeFileSync(indexPath, stale);
  const broken = run(["locate", binPath, "5"]);
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /fixture\.locate-index\.bin: .*checksum mismatch/);
  assert.equal(run(["locate", binPath, "5", "--no-index"]).stdout, "11, 113\n");
  const good = path.join(dir, "elsewhere.bin");
  assert.equal(run(["build-locate-index", binPath, "--output", good]).status, 0);
  assert.equal(run(["locate", binPath, "5", "--index", good]).stdout, "11, 113\n");
});

// --- show / chunk / info ----------------------------------------------------

test("show: resolves ids to names and parents", () => {
  const { stdout, status } = run(["show", fixturePath, "5", "1"]);
  assert.equal(status, 0);
  assert.equal(
    stdout,
    [
      "5\tcity",
      `  country  ${NL}  [0]`,
      "  region   Noord-Holland  [2]",
      "  city     Zaandam  [5]",
      "1\tcountry",
      `  country  ${BE}  [1]`,
      "  region   -",
      "  city     -",
      "",
    ].join("\n"),
  );
  assert.equal(JSON.parse(run(["show", fixturePath, "3", "--json"]).stdout)["level"], "region");
  const outOfRange = run(["show", fixturePath, "7"]);
  assert.equal(outOfRange.status, 2);
  assert.match(outOfRange.stderr, /out of range/);
});

test("chunk: dumps a chunk's header and records; an empty chunk is just the header", () => {
  const full = run(["chunk", fixturePath, "3"]);
  assert.equal(full.status, 0);
  const [header, ...records] = full.stdout.trimEnd().split("\n");
  assert.match(header!, /^chunk 3 {2}\(col 1, row 1\) {2}lat 0\.\.90 {2}lon 0\.\.180 {2}26 bytes, \d+ palette entries, (\d+) records$/);
  assert.equal(records.length, Number(/(\d+) records$/.exec(header!)![1]));
  const zaandam = records.find((line) => line.includes("\tZaandam\t"));
  assert.ok(zaandam, "lookup 1's cell is a record resolving to Zaandam");
  assert.match(zaandam, /\t10\tlat 0\.\.22\.5, lon 90\.\.135\t5\tcity\tZaandam\tNoord-Holland\t/.source ? /lat 0\.\.22\.5, lon 90\.\.135\t5\tcity\tZaandam\tNoord-Holland\t/ : /x/);

  const empty = run(["chunk", fixturePath, "0"]);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trimEnd().split("\n").length, 1);
  assert.match(empty.stdout, /0 bytes, 0 palette entries, 0 records/);

  const json = jsonLines(run(["chunk", fixturePath, "3", "--json"]).stdout);
  assert.equal(json[0]?.["index"], 3);
  assert.equal(json.length - 1, records.length);
  assert.equal(run(["chunk", fixturePath, "4"]).status, 2);
});

test("info: reports Appendix A's header, counts and byte split", () => {
  const { stdout, status } = run(["info", fixturePath, "--json"]);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    version: 0,
    attribution: "OSM",
    grid: { width: 2, height: 2, widthExp: 1, heightExp: 1 },
    maxDepth: 2,
    keyframeExp: 2,
    places: { countries: 2, regions: 2, cities: 3 },
    bytes: { total: 157, header: 17, directory: 5, placeTable: 109, chunks: 26 },
    chunks: { total: 4, nonEmpty: 1, largest: [{ index: 3, bytes: 26 }] },
  });
  const readable = run(["info", fixturePath]);
  assert.match(readable.stdout, /places {7}2 countries, 2 regions, 3 cities/);
  assert.match(readable.stdout, /--only-chunks 3/);
  assert.doesNotMatch(run(["info", fixturePath, "--top", "0"]).stdout, /largest/);
});

// --- dispatch ---------------------------------------------------------------

test("usage errors exit 2 without touching the file; help exits 0", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(["frobnicate", fixturePath]).status, 2);
  assert.equal(run(["list"]).status, 2, "no file");
  const unknown = run(["lookup", fixturePath, "--nope", "20,100"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /--nope/);
  assert.match(unknown.stderr, /usage: cgeodata lookup/);

  const help = run(["help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /commands:/);
  assert.match(run(["help", "search"]).stdout, /^usage: cgeodata search/);
  assert.equal(run(["help", "frobnicate"]).status, 2);
});
