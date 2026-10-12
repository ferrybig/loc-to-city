/**
 * The shape of `<dataset>.checks.json`, the export the demo draws as map
 * markers. The demo has its own copy of what it reads (it must not depend
 * on this package); bump `CHECKS_FILE_VERSION` when a field it needs changes.
 */

import type { Status } from "./cases.ts";
import type { Check, CheckResult, Group, Outcome, Tier } from "./evaluate.ts";

export const CHECKS_FILE_VERSION = 1;

export interface ChecksFileEntry {
	id: string;
	group: Group;
	name: string;
	lat: number;
	lon: number;
	status: Status;
	outcome: Outcome;
	/** The `countries.md` section the place is documented in. */
	section: string;
	/** `country / region / city`, `-` for a tier the check does not care about. */
	expected: string;
	actual: Record<Tier, string[]>;
}

export interface ChecksFile {
	version: typeof CHECKS_FILE_VERSION;
	generatedAt: string;
	dataset: {
		file: string;
		/** Size of the .bin the checks ran against: the demo only shows the markers for a dataset of the same size. */
		bytes: number;
		attribution: string;
		builtAt: string;
		/** The resolved input is newer than the .bin: failures may be fixes not built yet. */
		olderThanResolvedInput: boolean;
	};
	/** How many checks ended in each outcome. */
	summary: Record<Outcome, number>;
	checks: ChecksFileEntry[];
}

export const OUTCOMES: readonly Outcome[] = [
	"verified",
	"regression",
	"open",
	"known-wrong",
	"report-upstream",
	"now-passing",
];

export function entryFor(check: Check, result: CheckResult): ChecksFileEntry {
	return {
		id: check.id,
		group: check.group,
		name: check.name,
		lat: check.at[0],
		lon: check.at[1],
		status: check.status,
		outcome: result.outcome,
		section: check.section,
		expected: result.expected,
		actual: result.actual,
	};
}

export function summarize(
	entries: readonly { outcome: Outcome }[],
): Record<Outcome, number> {
	const summary = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<
		Outcome,
		number
	>;
	for (const e of entries) summary[e.outcome]++;
	return summary;
}
