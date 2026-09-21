import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// The fixture only exists as bytes, and the CLI only takes a path.
const fixturePath = path.join(mkdtempSync(path.join(tmpdir(), "cgeodata-cli-")), "appendix-a.bin");
writeFileSync(fixturePath, APPENDIX_A_BYTES);

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], stdin = ""): Run {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    input: stdin,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 1 };
}

test("cli: resolves points given as arguments in the readable form", () => {
  const { stdout, status } = run([fixturePath, "20,100", "-10,10"]);
  assert.equal(status, 0);
  // Lookup 1 from appendix-a.test.ts, then lookup 5 (empty chunk 1).
  assert.equal(
    stdout,
    [
      "20,100",
      "  country  Nederland | The Netherlands",
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

test("cli: --json emits one object per point with the input echoed back", () => {
  const { stdout, status } = run([fixturePath, "--json", "20,100"]);
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

test("cli: --stdin accepts both line forms, carries tags through, and skips bad lines", () => {
  const input = [
    "# a comment",
    "",
    "20,100\tzaandam-by-comma",
    "20\t100\tzaandam-by-tab\twith\ttabs",
    "not,numbers\tbad",
    "95,0\tout-of-range",
    "40,30",
  ].join("\n");
  const { stdout, stderr, status } = run([fixturePath, "--stdin", "--json"], input);
  assert.equal(status, 0, "a bad line must not fail the batch");

  const lines = stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
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

test("cli: usage errors exit 2 without touching the file", () => {
  assert.equal(run([]).status, 2);
  assert.equal(run([fixturePath]).status, 2, "no points and no --stdin");
  assert.equal(run([fixturePath, "--stdin", "20,100"]).status, 2, "--stdin and points are exclusive");
  const unknown = run([fixturePath, "--nope", "20,100"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown flag --nope/);
});

test("cli: a malformed point given as an argument is a hard failure", () => {
  const { status, stderr } = run([fixturePath, "20,100", "abc,def"]);
  assert.equal(status, 1);
  assert.match(stderr, /latitude "abc" is not a number/);
});
