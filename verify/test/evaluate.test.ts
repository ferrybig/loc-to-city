import assert from "node:assert/strict";
import { test } from "node:test";
import { ANY, NONE, type Status } from "../src/cases.ts";
import { type Check, evaluate, matches, outcomeOf } from "../src/evaluate.ts";

const place = (id: number, ...names: string[]) => ({
	id,
	localName: names[0]!,
	internationalName: names[0]!,
	names,
});

/** A reader that answers every query with the same hierarchy, or per point. */
function fakeReader(
	answers: Record<
		string,
		{
			country?: ReturnType<typeof place>;
			region?: ReturnType<typeof place>;
			city?: ReturnType<typeof place>;
		}
	>,
) {
	return {
		async query(lat: number, lon: number) {
			const a = answers[`${lat},${lon}`] ?? {};
			return {
				country: a.country ?? null,
				region: a.region ?? null,
				city: a.city ?? null,
			} as never;
		},
	};
}

const base = {
	id: "spot:1,2",
	group: "spot",
	name: "x",
	at: [1, 2],
	status: "fixed",
	section: "Netherlands",
} as const satisfies Check;

test("outcomeOf: what each status means for a pass and a fail", () => {
	const table: [Status, boolean, string][] = [
		["fixed", true, "verified"],
		["fixed", false, "regression"],
		["false-positive", true, "verified"],
		["false-positive", false, "regression"],
		["open", false, "open"],
		["open", true, "now-passing"],
		["unsolvable", false, "known-wrong"],
		["unsolvable", true, "now-passing"],
		["human-error", false, "report-upstream"],
		["human-error", true, "now-passing"],
	];
	for (const [status, pass, outcome] of table)
		assert.equal(outcomeOf(status, pass), outcome, `${status} ${pass}`);
});

test("matches: names, lists, ANY, NONE and capitals", () => {
	const nl = place(1, "Nederland", "Netherlands");
	assert.ok(matches(nl, "Netherlands"));
	assert.ok(matches(nl, ["Belgium", "Nederland"]));
	assert.ok(!matches(nl, "Belgium"));
	assert.ok(matches(nl, ANY) && !matches(null, ANY));
	assert.ok(matches(null, NONE) && !matches(nl, NONE));
	assert.ok(!matches(null, "Netherlands"));
	const hanoi = place(2, "Thành phố Hà Nội", "Hanoi");
	assert.ok(matches(hanoi, { namedFor: "hà nội" }));
	assert.ok(
		matches(place(3, "Београд"), {
			namedFor: "Belgrade",
			aliases: ["Београд"],
		}),
	);
	// A district of the capital is not the capital.
	assert.ok(!matches(place(4, "Dongcheng District"), { namedFor: "Beijing" }));
	// Whole words only.
	assert.ok(!matches(place(5, "Sofiatown"), { namedFor: "Sofia" }));
	// St, St. and Saint are one word.
	for (const name of ["St Peter Port", "St. Peter Port", "Saint Peter Port"]) {
		assert.ok(matches(place(6, name), { namedFor: "Saint Peter Port" }), name);
		assert.ok(matches(place(6, name), { namedFor: "St Peter Port" }), name);
	}
	assert.ok(!matches(place(7, "Stockholm"), { namedFor: "Saint Peter Port" }));
});

test("evaluate: reports the failing tier and what came back", async () => {
	const reader = fakeReader({
		"1,2": { country: place(1, "Germany"), region: place(2, "Bremen") },
	});
	const result = await evaluate(reader, {
		...base,
		country: "Netherlands",
		city: "Bremen",
	});
	assert.equal(result.pass, false);
	assert.equal(result.outcome, "regression");
	assert.equal(result.expected, "Netherlands / - / Bremen");
	assert.deepEqual(result.actual, {
		country: ["Germany"],
		region: ["Bremen"],
		city: [],
	});
	assert.equal(result.failures.length, 2);
});

test("evaluate: otherCityThan wants two different cities", async () => {
	const same = fakeReader({
		"1,2": { city: place(7, "Ansen") },
		"3,4": { city: place(7, "Ansen") },
	});
	assert.equal(
		(await evaluate(same, { ...base, otherCityThan: [3, 4] })).pass,
		false,
	);
	const two = fakeReader({
		"1,2": { city: place(7, "Ansen") },
		"3,4": { city: place(8, "Ansen") },
	});
	assert.equal(
		(await evaluate(two, { ...base, otherCityThan: [3, 4] })).pass,
		true,
	);
	const none = fakeReader({ "1,2": { city: place(7, "Ansen") } });
	assert.equal(
		(await evaluate(none, { ...base, otherCityThan: [3, 4] })).pass,
		false,
	);
});

test("evaluate: an open case that now passes says so", async () => {
	const reader = fakeReader({ "1,2": { country: place(1, "Netherlands") } });
	const result = await evaluate(reader, {
		...base,
		status: "open",
		country: "Netherlands",
	});
	assert.equal(result.outcome, "now-passing");
});
