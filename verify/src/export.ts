#!/usr/bin/env node
/**
 * Runs the spot-checks against a worldwide .bin and writes the results as
 * JSON, for the demo to draw as markers (it picks up `<dataset>.checks.json`
 * next to the dataset it serves, like the sidecar indexes).
 *
 *   node verify/src/export.ts <file.bin> --out <file.checks.json> [--section NAME]
 *
 * `--out -` writes to stdout. `--section` keeps only the checks filed under
 * that countries.md section, for a dataset that covers part of the world.
 * A failing check is a result, not an error: the exit status is 0 unless
 * the arguments or the dataset are bad (the tests are the gate).
 */
import {
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { openFile } from "@ferrybig/cgeodata-reader/node";
import {
	CHECKS_FILE_VERSION,
	type ChecksFile,
	entryFor,
	summarize,
} from "./checksFile.ts";
import { allChecks, evaluate } from "./evaluate.ts";
import { RESOLVED_INPUT } from "./pickBin.ts";

const USAGE =
	"usage: export.ts <file.bin> --out <file.checks.json | -> [--section NAME]";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: { out: { type: "string" }, section: { type: "string" } },
	});
	const [binPath] = positionals;
	if (
		binPath === undefined ||
		positionals.length > 1 ||
		values.out === undefined
	) {
		console.error(USAGE);
		process.exit(2);
	}
	const reader = await openFile(binPath);
	const bin = statSync(binPath);

	const checks = allChecks().filter(
		(c) => values.section === undefined || c.section === values.section,
	);
	if (checks.length === 0) {
		console.error(`no checks in section ${JSON.stringify(values.section)}`);
		process.exit(2);
	}
	const entries = [];
	for (const check of checks)
		entries.push(entryFor(check, await evaluate(reader, check)));

	const file: ChecksFile = {
		version: CHECKS_FILE_VERSION,
		generatedAt: new Date().toISOString(),
		dataset: {
			file: path.basename(binPath),
			bytes: bin.size,
			attribution: reader.header.attribution,
			builtAt: bin.mtime.toISOString(),
			olderThanResolvedInput:
				existsSync(RESOLVED_INPUT) &&
				statSync(RESOLVED_INPUT).mtimeMs > bin.mtimeMs,
		},
		summary: summarize(entries),
		checks: entries,
	};
	const json = `${JSON.stringify(file, null, "\t")}\n`;
	if (values.out === "-") {
		process.stdout.write(json);
	} else {
		// Renamed into place, so the demo never reads half a file.
		mkdirSync(path.dirname(values.out), { recursive: true });
		const tmp = `${values.out}.tmp`;
		writeFileSync(tmp, json);
		renameSync(tmp, values.out);
	}
	console.error(
		`${entries.length} checks: ${Object.entries(file.summary)
			.map(([k, v]) => `${v} ${k}`)
			.join(", ")}`,
	);
	if (file.dataset.olderThanResolvedInput)
		console.error(
			`WARNING: ${binPath} is older than ${RESOLVED_INPUT}; rebuild it before trusting failures`,
		);
}

await main();
