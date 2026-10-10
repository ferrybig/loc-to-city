import assert from "node:assert/strict";
import { test } from "node:test";
import {
	areaByte,
	compareAreaRelevance,
	compareRelevance,
	containsTokenRun,
	contextQuality,
	EXACT_SPELLING_BONUS,
	foldDiacritics,
	LEVEL_BONUS,
	nameMatchQuality,
	parseQualifiedQuery,
	placeMatchQuality,
	prepareNeedle,
	QUALITY_EXACT,
	QUALITY_MAX,
	QUALITY_SUBSTRING,
	QUALITY_WHOLE_WORD,
	type RankedMatch,
	regionRankArea,
	tokenize,
	tokenizeFolded,
} from "../src/relevance.ts";

test("foldDiacritics: NFD, strip combining marks, lowercase -- no digit/punctuation bucketing", () => {
	assert.equal(foldDiacritics("Zürich"), "zurich");
	assert.equal(foldDiacritics("MÉDÉA"), "medea");
	assert.equal(foldDiacritics("België"), "belgie");
	// ß and ø have no NFD decomposition: unaffected, unlike searchIndex.ts's
	// foldSymbols, which also treats them as symbols of their own but for a
	// different reason (they're non-ASCII).
	assert.equal(foldDiacritics("Straße"), "straße");
	assert.equal(foldDiacritics("Ørsted"), "ørsted");
	// No digit/punctuation bucketing (unlike foldSymbols): "5th" and "9th"
	// must stay distinct, or an exact/substring match would be too loose.
	assert.equal(foldDiacritics("5th Ave."), "5th ave.");
});

test("tokenize vs tokenizeFolded: only the folded version is diacritic-insensitive", () => {
	assert.deepEqual(tokenize("Café du Coin"), ["café", "du", "coin"]);
	assert.deepEqual(tokenizeFolded("Café du Coin"), ["cafe", "du", "coin"]);
	assert.deepEqual(
		containsTokenRun(tokenize("Café du Coin"), tokenize("cafe")),
		false,
	);
	assert.deepEqual(
		containsTokenRun(tokenizeFolded("Café du Coin"), tokenizeFolded("cafe")),
		true,
	);
});

test("quality tiers are spaced so level bonus and the spelling bonus can never cross a tier", () => {
	assert.ok(QUALITY_SUBSTRING + EXACT_SPELLING_BONUS < QUALITY_WHOLE_WORD);
	assert.ok(QUALITY_WHOLE_WORD + EXACT_SPELLING_BONUS < QUALITY_EXACT);
	const levelBonusSpread =
		Math.max(...Object.values(LEVEL_BONUS)) -
		Math.min(...Object.values(LEVEL_BONUS));
	assert.ok(
		levelBonusSpread <
			QUALITY_WHOLE_WORD - (QUALITY_SUBSTRING + EXACT_SPELLING_BONUS),
	);
	assert.ok(
		levelBonusSpread <
			QUALITY_EXACT - (QUALITY_WHOLE_WORD + EXACT_SPELLING_BONUS),
	);
	assert.equal(QUALITY_MAX, QUALITY_EXACT + EXACT_SPELLING_BONUS);
});

test("nameMatchQuality: diacritic folding finds a match plain lowercasing alone would miss", () => {
	const needle = prepareNeedle("zurich");
	assert.equal(nameMatchQuality("Zürich", needle), QUALITY_EXACT); // folded-only: no spelling bonus
});

test("nameMatchQuality: exact-as-typed spelling outranks a folding-only match of the same tier", () => {
	// The real Appendix A/B.12 case: querying "belgie" (no diaeresis) finds
	// "België" only by folding (quality 40, no bonus); querying "belgië"
	// (typed correctly) finds it exactly as typed too (quality 41).
	const plain = nameMatchQuality("België", prepareNeedle("belgie"));
	const accented = nameMatchQuality("België", prepareNeedle("belgië"));
	assert.equal(plain, QUALITY_EXACT);
	assert.equal(accented, QUALITY_EXACT + EXACT_SPELLING_BONUS);
	assert.ok(accented > plain);
});

test("nameMatchQuality: a field with no diacritics gets the spelling bonus regardless of what the query folds from", () => {
	// "Belgium" (no diacritics) exact-matches "belgium" whether or not the
	// query needed folding to reach some OTHER field -- the bonus is
	// per-field, not per-place.
	assert.equal(
		nameMatchQuality("Belgium", prepareNeedle("belgium")),
		QUALITY_EXACT + EXACT_SPELLING_BONUS,
	);
});

test("nameMatchQuality: no match at all is 0, regardless of folding", () => {
	assert.equal(nameMatchQuality("Zürich", prepareNeedle("tokyo")), 0);
});

test("placeMatchQuality: best field wins, folded and raw evaluated independently per field", () => {
	const needle = prepareNeedle("belgie");
	// "België" matches only by folding (40); "Belgium" doesn't contain
	// "belgie" at all (0, b-e-l-g-i-u-m has no such substring).
	assert.equal(placeMatchQuality(["België", "Belgium"], needle), QUALITY_EXACT);
});

test("LEVEL_BONUS: country beats city beats region, spread kept within one quality tier's bonus room", () => {
	assert.ok(LEVEL_BONUS.country > LEVEL_BONUS.city);
	assert.ok(LEVEL_BONUS.city > LEVEL_BONUS.region);
});

test("areaByte: the bit length of cells^4 -- 1 + floor(4 log2 cells), exactly", () => {
	assert.equal(areaByte(0), 0);
	assert.equal(areaByte(1), 1);
	assert.equal(areaByte(2), 5); // C.8: Zaandam
	assert.equal(areaByte(10), 14); // C.8: Noord-Holland, Nederland
	for (let k = 1; k <= 40; k++) {
		// A power of two starts a step; from 7 cells up, one cell less is
		// still in the step before.
		assert.equal(areaByte(2 ** k), 4 * k + 1, `2^${k}`);
		if (k >= 3) assert.equal(areaByte(2 ** k - 1), 4 * k, `2^${k} - 1`);
	}
	assert.equal(areaByte(2 ** 52), 209);
	assert.equal(areaByte(Number.MAX_SAFE_INTEGER), 212); // 2^53 - 1
	// The worldwide e7/d10 grid has 2^34 cells: 137, well under the cap.
	assert.equal(areaByte(2 ** 34), 137);
});

function match(overrides: Partial<RankedMatch> & { id: number }): RankedMatch {
	return {
		level: "city",
		quality: QUALITY_EXACT + EXACT_SPELLING_BONUS,
		contextQuality: 0,
		rankArea: 0,
		...overrides,
	};
}

function order(
	matches: RankedMatch[],
	compare: (a: RankedMatch, b: RankedMatch) => number,
): number[] {
	return [...matches].sort(compare).map((m) => m.id);
}

test("compareRelevance: B.5's score, then context quality, then id", () => {
	const matches = [
		match({ id: 4, level: "region" }),
		match({ id: 3 }),
		match({ id: 2, contextQuality: 20 }),
		match({ id: 1, level: "country", quality: QUALITY_EXACT }),
		match({ id: 0, quality: QUALITY_WHOLE_WORD }),
	];
	// The country's 40 + 3 ties a city's 41 + 2 -- the level bonus can
	// outweigh the spelling bonus -- so context quality, then id, decide;
	// area plays no part.
	assert.deepEqual(order(matches, compareRelevance), [2, 1, 3, 4, 0]);
});

test("compareAreaRelevance: tier, context, country, rank area, spelling, city over region, id", () => {
	const exact = QUALITY_EXACT + EXACT_SPELLING_BONUS;
	assert.deepEqual(
		order(
			[
				match({ id: 9, quality: QUALITY_WHOLE_WORD + 1, rankArea: 200 }), // worse tier
				match({ id: 8, rankArea: 50 }),
				match({ id: 7, rankArea: 90, level: "region" }),
				match({ id: 6, rankArea: 90 }), // city ahead of region of equal rank area
				match({ id: 5, rankArea: 10, level: "country" }), // countries first
				match({ id: 4, rankArea: 60, quality: QUALITY_EXACT }), // area before spelling
				match({ id: 3, rankArea: 60, quality: exact }),
				match({ id: 2, rankArea: 1, contextQuality: 41 }), // context before area
			],
			compareAreaRelevance,
		),
		[2, 5, 6, 7, 3, 4, 8, 9],
	);
	// Equal on everything but id: the lower id first.
	assert.deepEqual(
		order([match({ id: 2 }), match({ id: 1 })], compareAreaRelevance),
		[1, 2],
	);
});

test("regionRankArea: a region takes the area of its largest same-named city", () => {
	const cities = [
		{ localName: "Amersfoort", area: 40 },
		{ localName: "Utrecht", area: 44 },
		{ localName: "UTRECHT", area: 41 },
	];
	assert.equal(regionRankArea("Utrecht", 60, cities), 44);
	assert.equal(regionRankArea("Ütrecht", 60, cities), 44); // folded
	assert.equal(regionRankArea("Berlin", 60, cities), 60); // no namesake
	assert.equal(regionRankArea("Utrecht", 60, []), 60);
});

test("parseQualifiedQuery: the whole text, then every comma as a split", () => {
	assert.deepEqual(parseQualifiedQuery("Paris"), [
		{ head: "Paris", contexts: [] },
	]);
	assert.deepEqual(parseQualifiedQuery("Paris, Texas"), [
		{ head: "Paris, Texas", contexts: [] },
		{ head: "Paris", contexts: ["Texas"] },
	]);
	assert.deepEqual(
		parseQualifiedQuery("Springfield , Illinois,United States"),
		[
			{ head: "Springfield , Illinois,United States", contexts: [] },
			{ head: "Springfield", contexts: ["Illinois", "United States"] },
			{ head: "Springfield , Illinois", contexts: ["United States"] },
		],
	);
	// A trailing comma (mid-typing) reads as the head alone; nothing before
	// a comma is no head at all.
	assert.deepEqual(parseQualifiedQuery("Paris,"), [
		{ head: "Paris,", contexts: [] },
		{ head: "Paris", contexts: [] },
	]);
	assert.deepEqual(parseQualifiedQuery(", Texas"), [
		{ head: ", Texas", contexts: [] },
	]);
	assert.deepEqual(parseQualifiedQuery("a,,b"), [
		{ head: "a,,b", contexts: [] },
		{ head: "a", contexts: ["b"] },
		{ head: "a,", contexts: ["b"] },
	]);
});

test("contextQuality: each context matches a further ancestor, best total wins", () => {
	const region = ["Noord-Holland"];
	const country = ["Nederland", "The Netherlands"];
	const needles = (...texts: string[]) => texts.map(prepareNeedle);
	const exact = QUALITY_EXACT + EXACT_SPELLING_BONUS;
	assert.equal(contextQuality(needles("nederland"), [region, country]), exact);
	assert.equal(contextQuality(needles("holland"), [region, country]), 21);
	assert.equal(
		contextQuality(needles("noord-holland", "nederland"), [region, country]),
		2 * exact,
	);
	// Out of order, or both on one ancestor: no.
	assert.equal(
		contextQuality(needles("nederland", "noord-holland"), [region, country]),
		0,
	);
	assert.equal(contextQuality(needles("ned", "neth"), [region, country]), 0);
	// "land" is in both, as a plain substring.
	assert.equal(contextQuality(needles("land"), [region, country]), 11);
	assert.equal(contextQuality(needles("belgie"), [region, country]), 0);
	assert.equal(contextQuality(needles("nederland"), []), 0);
});
