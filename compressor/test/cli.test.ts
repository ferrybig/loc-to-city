// The CLI's --max-depth limit. Flags are all checked before any input is
// read, so missing input files tell an accepted depth (which then fails
// reading them) from a refused one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function compress(...flags: string[]): { status: number | null; stderr: string } {
  const { status, stderr } = spawnSync(
    process.execPath,
    [CLI, "missing-hierarchy.json", "missing-cities.geojson", "never-written.bin", ...flags],
    { encoding: "utf8" },
  );
  return { status, stderr };
}

test("--max-depth past 16 is refused, naming --unlock-depth-limit and why", () => {
  const { status, stderr } = compress("--max-depth", "17");
  assert.equal(status, 1);
  assert.match(stderr, /--max-depth 17 is past 16/);
  assert.match(stderr, /inflates whole/);
  assert.match(stderr, /--unlock-depth-limit/);
  assert.doesNotMatch(stderr, /missing-hierarchy/);
});

test("--max-depth 16 needs no unlocking", () => {
  const { status, stderr } = compress("--max-depth", "16");
  assert.equal(status, 1);
  assert.match(stderr, /missing-hierarchy\.json/);
  assert.doesNotMatch(stderr, /unlock-depth-limit/);
});

test("--unlock-depth-limit allows up to the format's 26", () => {
  const unlocked = compress("--max-depth", "26", "--unlock-depth-limit");
  assert.equal(unlocked.status, 1);
  assert.match(unlocked.stderr, /missing-hierarchy\.json/);

  const beyond = compress("--unlock-depth-limit", "--max-depth", "27");
  assert.equal(beyond.status, 1);
  assert.match(beyond.stderr, /--max-depth must be a whole number from 0 to 26/);
});
