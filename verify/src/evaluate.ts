/**
 * Runs the spot-checks of `cases.ts` against a reader and says how each
 * one turned out. Shared by the tests (which assert `pass`) and by
 * `export.ts` (which writes everything out for the demo's map).
 */
import type { CGeoDataReader, PlaceRef } from "@ferrybig/cgeodata-reader";
import {
	ANY,
	CAPITALS,
	CASES,
	type Case,
	type Expected,
	NONE,
	OPEN_CAPITALS,
	type Status,
} from "./cases.ts";

export const TIERS = ["country", "region", "city"] as const;
export type Tier = (typeof TIERS)[number];

/** Where a check comes from; the demo draws capitals separately, being many. */
export type Group = "spot" | "capital";

/**
 * How a check turned out, in terms of what a person should do:
 * - `verified`: correct, and the ledger says it should be.
 * - `regression`: the ledger says it is right and it is not. Fails the tests.
 * - `open`: wrong, as the ledger says; fixable.
 * - `known-wrong`: wrong, as the ledger says; nothing here can fix it.
 * - `report-upstream`: wrong because the source data is; worth reporting.
 * - `now-passing`: the ledger says it is wrong, and it is right. Close the entry.
 */
export type Outcome =
	| "verified"
	| "regression"
	| "open"
	| "known-wrong"
	| "report-upstream"
	| "now-passing";

/** One thing to look up and the answer it should have. */
export interface Check {
	/** Unique, stable across runs: group and coordinates. */
	id: string;
	group: Group;
	name: string;
	at: readonly [lat: number, lon: number];
	country?: Expected;
	region?: Expected;
	city?: Expected;
	otherCityThan?: readonly [lat: number, lon: number];
	status: Status;
	section: string;
	entry?: string;
}

export interface CheckResult {
	pass: boolean;
	outcome: Outcome;
	/** What was expected, as `country / region / city`. */
	expected: string;
	/** What the lookup returned, each tier as its names (empty when it resolved nothing). */
	actual: Record<Tier, string[]>;
	/** Why it failed, one line per failing tier; empty when it passed. */
	failures: string[];
}

export function outcomeOf(status: Status, pass: boolean): Outcome {
	if (status === "fixed" || status === "false-positive")
		return pass ? "verified" : "regression";
	if (pass) return "now-passing";
	if (status === "unsolvable") return "known-wrong";
	if (status === "human-error") return "report-upstream";
	return "open";
}

/** Whether a check is allowed to fail (the tests register it as `todo`). */
export function expectedToFail(status: Status): boolean {
	return status !== "fixed" && status !== "false-positive";
}

const fold = (s: string) =>
	s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[‘’`]/g, "'")
		// "Saint Peter Port" and "St Peter Port" are one place.
		.replace(/(^|[^\p{L}\p{N}])(?:saint|st\.?)(?=$|[^\p{L}\p{N}])/gu, "$1st");

function isNamedFor(
	e: Expected,
): e is { namedFor: string; aliases?: readonly string[] } {
	return typeof e === "object" && "namedFor" in e;
}

function namedFor(
	place: PlaceRef,
	capital: string,
	aliases: readonly string[],
): boolean {
	const wanted = [capital, ...aliases].map(fold);
	return place.names
		.map(fold)
		.some((name) =>
			wanted.some((w) =>
				new RegExp(
					`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
					"u",
				).test(name),
			),
		);
}

export function matches(
	actual: { names: readonly string[] } | null | undefined,
	expected: Expected,
): boolean {
	if (expected === NONE) return !actual;
	if (!actual) return false;
	if (expected === ANY) return true;
	if (isNamedFor(expected))
		return namedFor(
			actual as PlaceRef,
			expected.namedFor,
			expected.aliases ?? [],
		);
	const wanted = typeof expected === "string" ? [expected] : expected;
	return wanted.some((name) => actual.names.includes(name));
}

function describeOne(expected: Expected | undefined): string {
	if (expected === undefined) return "-";
	if (expected === ANY) return "any";
	if (expected === NONE) return "none";
	if (isNamedFor(expected)) return `named for ${expected.namedFor}`;
	return typeof expected === "string" ? expected : expected.join(" | ");
}

/** `country / region / city` with `-` for a tier the check does not care about. */
export function describeExpected(check: Pick<Check, Tier>): string {
	return TIERS.map((tier) => describeOne(check[tier])).join(" / ");
}

type Lookup = Pick<CGeoDataReader, "query">;

export async function evaluate(
	reader: Lookup,
	check: Check,
): Promise<CheckResult> {
	const result = await reader.query(check.at[0], check.at[1]);
	const actual = { country: [], region: [], city: [] } as Record<
		Tier,
		string[]
	>;
	for (const tier of TIERS) actual[tier] = [...(result[tier]?.names ?? [])];
	const got = TIERS.map((tier) => result[tier]?.localName ?? "-").join(" / ");
	const failures: string[] = [];
	for (const tier of TIERS) {
		const expected = check[tier];
		if (expected === undefined) continue;
		if (!matches(result[tier], expected))
			failures.push(`${tier}: expected ${describeOne(expected)}, got ${got}`);
	}
	if (check.otherCityThan !== undefined) {
		const other = await reader.query(
			check.otherCityThan[0],
			check.otherCityThan[1],
		);
		if (result.city === null || other.city === null) {
			failures.push(`city: expected both points to resolve a city, got ${got}`);
		} else if (result.city.id === other.city.id) {
			failures.push(
				`city: ${check.at.join(", ")} and ${check.otherCityThan.join(", ")} are both place ${result.city.id}`,
			);
		}
	}
	const pass = failures.length === 0;
	return {
		pass,
		outcome: outcomeOf(check.status, pass),
		expected: describeExpected(check),
		actual,
		failures,
	};
}

function fromCase(c: Case): Check {
	const {
		name,
		at,
		country,
		region,
		city,
		otherCityThan,
		status,
		section,
		entry,
	} = c;
	return {
		id: `spot:${at[0]},${at[1]}`,
		group: "spot",
		name,
		at,
		...(country !== undefined && { country }),
		...(region !== undefined && { region }),
		...(city !== undefined && { city }),
		...(otherCityThan !== undefined && { otherCityThan }),
		status,
		section,
		...(entry !== undefined && { entry }),
	};
}

function fromCapitals(list: typeof CAPITALS, status: Status): Check[] {
	return list.map(([country, capital, lat, lon, aliases]) => ({
		id: `capital:${lat},${lon}`,
		group: "capital",
		name: `${capital} (${country})`,
		at: [lat, lon],
		country,
		city: { namedFor: capital, ...(aliases && { aliases }) },
		status,
		...(status === "fixed"
			? { section: "What each tier is for" }
			: { section: "Cross-cutting patterns", entry: "Capitals." }),
	}));
}

/** Every check there is: the spot-checks, then the capitals that resolve, then those that do not. */
export function allChecks(): Check[] {
	return [
		...CASES.map(fromCase),
		...fromCapitals(CAPITALS, "fixed"),
		...fromCapitals(OPEN_CAPITALS, "open"),
	];
}
