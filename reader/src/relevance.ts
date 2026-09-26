/**
 * Relevance order for search results (binary-format.md Appendix B.5):
 * what `CGeoDataReader.search({ sort: true })` ranks by, and what a
 * search index's short-query table is built with -- one implementation
 * for both, since the table is only correct if it ranks exactly like the
 * search it stands in for.
 */
import type { PlaceLevel } from "./reader.js";

/** Per-level bonus: a city is what most queries are actually after, so
 * it outranks a region, which outranks a country, all else being equal. */
export const LEVEL_BONUS: Readonly<Record<PlaceLevel, number>> = {
	city: 4,
	region: 2,
	country: 1,
};

/** Lowercases and splits on any run of non-letter/non-digit characters,
 * so "Nieuw-Amsterdam" and "Nieuw Amsterdam" tokenize identically
 * regardless of which separator the data used. Unicode-aware (`\p{L}`),
 * so accented letters count as letters rather than splitting a word in
 * two. */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((token) => token.length > 0);
}

/** True if `needleTokens` occurs as a contiguous run within `tokens` --
 * i.e. the query matches one or more *whole* words of the name, not
 * just a substring that happens to straddle a word boundary. */
export function containsTokenRun(
	tokens: readonly string[],
	needleTokens: readonly string[],
): boolean {
	if (needleTokens.length === 0 || needleTokens.length > tokens.length)
		return false;
	search: for (let i = 0; i + needleTokens.length <= tokens.length; i++) {
		for (let j = 0; j < needleTokens.length; j++) {
			if (tokens[i + j] !== needleTokens[j]) continue search;
		}
		return true;
	}
	return false;
}

/**
 * A name's match quality: an exact match (4) beats a whole-word match
 * (2) beats a plain substring match (1); no match at all is 0.
 * `needle` must already be lowercase, and `needleTokens` is
 * `tokenize(needle)` -- both precomputed once per search, not per name.
 *
 * Only a substring match counts at all, so sorting ranks the same set
 * unsorted search finds: without that, " di " would match "Di" by its
 * tokens alone, and a search index (which only guarantees substring
 * candidates, Appendix B.9) would miss it.
 */
export function nameMatchQuality(
	name: string,
	needle: string,
	needleTokens: readonly string[],
): number {
	const lower = name.toLowerCase();
	if (!lower.includes(needle)) return 0;
	if (lower === needle) return 4;
	if (containsTokenRun(tokenize(name), needleTokens)) return 2;
	return 1;
}

/** The best `nameMatchQuality` over a place's names. */
export function placeMatchQuality(
	names: readonly string[],
	needle: string,
	needleTokens: readonly string[],
): number {
	let best = 0;
	for (const name of names) {
		best = Math.max(best, nameMatchQuality(name, needle, needleTokens));
		if (best === 4) break;
	}
	return best;
}
