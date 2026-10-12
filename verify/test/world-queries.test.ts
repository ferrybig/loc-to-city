import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { test } from "node:test";
import type { CGeoDataReader } from "@ferrybig/cgeodata-reader";
import { openFile } from "@ferrybig/cgeodata-reader/node";
import { allChecks, evaluate, expectedToFail } from "../src/evaluate.ts";
import { pickWorldBin, RESOLVED_INPUT } from "../src/pickBin.ts";

// Spot-checks against the worldwide build, the counterpart of
// compressor/test/zuid-holland-queries.test.ts for everything `countries.md`
// documents. The cases live in src/cases.ts. Skipped unless a worldwide .bin
// exists (see pickWorldBin: CGEODATA_WORLD_BIN, else the high-res
// build, else world.bin). The last test below says which file ran and
// warns when it is older than the resolved input it was built from.
//
// Two kinds of case:
// - Cases whose ledger status is `fixed` or `false-positive` are answers that
//   must stay that way. A failure here is a regression.
// - The others (`open`, `unsolvable`, `human-error`) are the expected answer
//   for a place `countries.md` lists as wrong. node:test runs them as `todo`,
//   so a failure is not a failed suite; once one starts passing it says so
//   (a diagnostic), and the entry should be closed in countries.md and the
//   case's status changed.

const BIN_PATH = pickWorldBin();
const skip = BIN_PATH === undefined;

let reader: Promise<CGeoDataReader> | undefined;
function world(): Promise<CGeoDataReader> {
	reader ??= openFile(BIN_PATH!);
	return reader;
}

for (const check of allChecks()) {
	const title =
		check.group === "capital" ? `capital ${check.name}` : check.name;
	const options = expectedToFail(check.status)
		? { skip, todo: `countries.md: ${check.section}` }
		: { skip };
	test(`${check.at.join(", ")}: ${title}`, options, async (t) => {
		const result = await evaluate(await world(), check);
		if (result.outcome === "now-passing") {
			t.diagnostic(
				`NOW PASSING: ${check.name} -- close "${check.entry}" in countries.md (${check.section}) and change its status`,
			);
		}
		assert.ok(result.pass, result.failures.join("; "));
	});
}

test("which worldwide .bin the cases ran against", { skip }, (t) => {
	const bin = statSync(BIN_PATH!);
	t.diagnostic(`using ${BIN_PATH} (built ${bin.mtime.toISOString()})`);
	if (
		existsSync(RESOLVED_INPUT) &&
		statSync(RESOLVED_INPUT).mtimeMs > bin.mtimeMs
	) {
		t.diagnostic(
			`WARNING: ${BIN_PATH} is older than ${RESOLVED_INPUT}; rebuild it before trusting failures`,
		);
	}
});
