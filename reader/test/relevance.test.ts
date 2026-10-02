import assert from "node:assert/strict";
import { test } from "node:test";
import {
	containsTokenRun,
	EXACT_SPELLING_BONUS,
	foldDiacritics,
	LEVEL_BONUS,
	nameMatchQuality,
	placeMatchQuality,
	prepareNeedle,
	QUALITY_EXACT,
	QUALITY_MAX,
	QUALITY_SUBSTRING,
	QUALITY_WHOLE_WORD,
	tokenize,
	tokenizeFolded,
} from "../src/relevance.js";

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
	assert.deepEqual(containsTokenRun(tokenize("Café du Coin"), tokenize("cafe")), false);
	assert.deepEqual(containsTokenRun(tokenizeFolded("Café du Coin"), tokenizeFolded("cafe")), true);
});

test("quality tiers are spaced so level bonus and the spelling bonus can never cross a tier", () => {
	assert.ok(QUALITY_SUBSTRING + EXACT_SPELLING_BONUS < QUALITY_WHOLE_WORD);
	assert.ok(QUALITY_WHOLE_WORD + EXACT_SPELLING_BONUS < QUALITY_EXACT);
	const levelBonusSpread = Math.max(...Object.values(LEVEL_BONUS)) - Math.min(...Object.values(LEVEL_BONUS));
	assert.ok(levelBonusSpread < QUALITY_WHOLE_WORD - (QUALITY_SUBSTRING + EXACT_SPELLING_BONUS));
	assert.ok(levelBonusSpread < QUALITY_EXACT - (QUALITY_WHOLE_WORD + EXACT_SPELLING_BONUS));
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
	assert.equal(nameMatchQuality("Belgium", prepareNeedle("belgium")), QUALITY_EXACT + EXACT_SPELLING_BONUS);
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
