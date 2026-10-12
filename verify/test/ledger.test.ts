import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Status } from "../src/cases.ts";
import { allChecks, type Check } from "../src/evaluate.ts";
import { REPO_ROOT } from "../src/pickBin.ts";

// The cases in src/cases.ts and countries.md describe the same places. This
// keeps them in step: a case's `section` must be a heading there, and its
// `entry` a bullet of that section whose marker is the case's `status`.

const MARKER_FOR: Record<Status, string | undefined> = {
	fixed: undefined,
	"false-positive": "false positive",
	open: "open",
	unsolvable: "unsolvable",
	"human-error": "human error",
};

interface Bullet {
	title: string;
	marker: string | undefined;
}

/** Each `## ` section's name (without its trailing ISO code) and bullets. */
function parseLedger(): Map<string, Bullet[]> {
	const text = readFileSync(path.join(REPO_ROOT, "countries.md"), "utf8");
	const sections = new Map<string, Bullet[]>();
	for (const part of text.split(/^## /m).slice(1)) {
		const name = part
			.slice(0, part.indexOf("\n"))
			.replace(/ \([A-Z, ]+\)$/, "");
		const bullets: Bullet[] = [];
		for (const m of part.matchAll(
			/^- \*\*([\s\S]+?)\*\*\s*(?:\*\(([a-z ]+)\)\*)?/gm,
		)) {
			bullets.push({ title: m[1]!.replace(/\s+/g, " "), marker: m[2] });
		}
		sections.set(name, bullets);
	}
	return sections;
}

const ledger = parseLedger();
const checks = allChecks();

test("the ledger parses into sections with bullets", () => {
	assert.ok(ledger.size > 40, `only ${ledger.size} sections`);
	assert.ok(ledger.get("Netherlands")!.length > 3);
});

test("every check's section is a heading in countries.md", () => {
	const missing = [...new Set(checks.map((c) => c.section))].filter(
		(s) => !ledger.has(s),
	);
	assert.deepEqual(missing, []);
});

test("every check's entry is a bullet of its section with the marker its status implies", () => {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const check of checks) {
		if (check.entry === undefined) {
			if (check.status !== "fixed")
				problems.push(`${check.id}: status ${check.status} needs an entry`);
			continue;
		}
		const key = `${check.section}|${check.entry}|${check.status}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const bullet = ledger
			.get(check.section)
			?.find((b) => b.title.startsWith(check.entry!));
		if (!bullet)
			problems.push(
				`${check.id}: no bullet starting "${check.entry}" in ${check.section}`,
			);
		else if (bullet.marker !== MARKER_FOR[check.status]) {
			problems.push(
				`${check.id}: "${bullet.title}" is marked ${bullet.marker ?? "(none)"}, the case says ${check.status}`,
			);
		}
	}
	assert.deepEqual(problems, []);
});

test("check ids are unique", () => {
	const ids = checks.map((c: Check) => c.id);
	assert.equal(new Set(ids).size, ids.length);
});
