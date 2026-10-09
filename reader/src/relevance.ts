/**
 * Relevance order for search results (binary-format.md Appendix B.5):
 * what `CGeoDataReader.search({ sort: true })` ranks by, and what a
 * search index's short-query table is built with -- one implementation
 * for both, since the table is only correct if it ranks exactly like the
 * search it stands in for.
 */
import type { PlaceLevel } from "./reader.ts";

/** Per-level bonus: a query that exactly names a country should surface
 * that country, not a same-named city buried inside it (e.g. "Nederland"
 * the country, not a village called Nederland in Overijssel) -- a country
 * is also the rarest, most deliberate kind of query, while a short
 * substring is far more likely to be aimed at one of the many more
 * numerous cities. Only country jumps the queue: city still outranks
 * region exactly as before (a plain reversal of all three would also
 * rank, say, the Antwerpen *province* above the city of Antwerp on an
 * identical exact match, which nobody asked for and is backwards for the
 * much more common case of searching a city's own name). `LEVEL_BONUS`'s
 * spread (2) is kept well under the gap between adjacent quality tiers
 * (`QUALITY_SUBSTRING` to `QUALITY_WHOLE_WORD`, 9) so quality always
 * decides first and the level bonus only ever breaks a tie between two
 * matches of the same tier and spelling exactness -- see
 * `nameMatchQuality`. */
export const LEVEL_BONUS: Readonly<Record<PlaceLevel, number>> = {
	country: 3,
	city: 2,
	region: 1,
};

/** The Combining Diacritical Marks block (Section B.2 step 2). Written
 * with escapes, not the literal code points, which would otherwise
 * combine onto the surrounding brackets in an editor. */
const COMBINING = /[\u0300-\u036f]/g;

/** NFD, strip combining diacritics, lowercase -- diacritic- and
 * case-insensitive text for matching and ranking (Section B.5).
 * `searchIndex.ts`'s `foldSymbols` (Section B.2's full symbol folding
 * used for trigrams) continues from this, and only from this -- but
 * matching and ranking stop here, because that one also buckets
 * every ASCII digit into one shared symbol and every other ASCII
 * punctuation/space character into another, which is the right call for
 * trigram list sizing but would make "5th" match "9th" as a substring --
 * too loose for deciding whether, or how well, a name matches a query.
 * `foldDiacritics` only folds diacritics and case, so it stays strictly
 * narrower than (every match it finds, `foldSymbols`-based folded
 * substring containment also finds) the trigram index's own folding,
 * which is what makes it safe to confirm trigram-index candidates with
 * (Section B.9). */
export function foldDiacritics(text: string): string {
	return text.normalize("NFD").replace(COMBINING, "").toLowerCase();
}

function splitTokens(text: string): string[] {
	return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/** Lowercases and splits on any run of non-letter/non-digit characters,
 * so "Nieuw-Amsterdam" and "Nieuw Amsterdam" tokenize identically
 * regardless of which separator the data used. Unicode-aware (`\p{L}`),
 * so accented letters count as letters rather than splitting a word in
 * two. Case-only -- no diacritic folding; see `tokenizeFolded` for that.
 * Kept separate so `nameMatchQuality` can tell whether a match needed
 * folding to reach its tier (the "exact spelling" bonus). */
export function tokenize(text: string): string[] {
	return splitTokens(text.toLowerCase());
}

/** Like `tokenize`, but folds diacritics first (see `foldDiacritics`). */
export function tokenizeFolded(text: string): string[] {
	return splitTokens(foldDiacritics(text));
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

/** A query, precomputed once per search (not once per name): both its
 * raw (case-folded only) and diacritic-folded forms, each with its own
 * tokens, since `nameMatchQuality` needs both to tell a match that needed
 * folding from one that didn't. */
export interface Needle {
	raw: string;
	rawTokens: string[];
	folded: string;
	foldedTokens: string[];
}

export function prepareNeedle(text: string): Needle {
	return {
		raw: text.toLowerCase(),
		rawTokens: tokenize(text),
		folded: foldDiacritics(text),
		foldedTokens: tokenizeFolded(text),
	};
}

/** A plain substring match. Spaced ten apart from the next tier (and the
 * next from `QUALITY_EXACT`) so `EXACT_SPELLING_BONUS` and
 * `LEVEL_BONUS` can never add up to enough to cross into a higher tier --
 * quality always dominates level and spelling exactness, which only ever
 * break a tie within the same tier. */
export const QUALITY_SUBSTRING = 10;
/** The query's tokens occur in the field's tokens as a contiguous run. */
export const QUALITY_WHOLE_WORD = 20;
/** The field equals the query. */
export const QUALITY_EXACT = 40;
/** Added when a field reaches its tier (substring, whole-word, or exact)
 * without needing diacritic folding at all -- i.e. the query's raw
 * spelling, as typed, was already enough. Rewards typing a name's
 * diacritics correctly over a folding-only match of the same tier,
 * without ever letting a folding-only match of a *better* tier lose to
 * an exact-spelling match of a worse one (`QUALITY_SUBSTRING`'s best case,
 * 11, is still well under `QUALITY_WHOLE_WORD`'s worst, 20). */
export const EXACT_SPELLING_BONUS = 1;
/** The best any single field can ever score. */
export const QUALITY_MAX = QUALITY_EXACT + EXACT_SPELLING_BONUS;

/** `0` if `normalized` doesn't contain `needle` at all, else the tier
 * `normalized` reaches against `needle`/`needleTokens` -- both already
 * normalized the same way as `normalized` itself (both raw, or both
 * folded, never mixed). */
function tierQuality(
	normalized: string,
	needle: string,
	needleTokens: readonly string[],
): number {
	if (!normalized.includes(needle)) return 0;
	if (normalized === needle) return QUALITY_EXACT;
	if (containsTokenRun(splitTokens(normalized), needleTokens))
		return QUALITY_WHOLE_WORD;
	return QUALITY_SUBSTRING;
}

/**
 * A name's match quality against `needle`: the diacritic-folded
 * comparison decides which tier it reaches (0 for no match, otherwise
 * `QUALITY_SUBSTRING`/`QUALITY_WHOLE_WORD`/`QUALITY_EXACT`), and the raw
 * (unfolded) comparison decides whether `EXACT_SPELLING_BONUS` applies --
 * it does whenever the raw comparison reaches *at least* the same tier,
 * which folding can only ever match or improve on for the same
 * name/needle pair (never make worse), so "reaches at least" is exactly
 * "didn't need folding to get here".
 *
 * Only a substring match counts at all, so sorting ranks the same set
 * unsorted search finds: without that, " di " would match "Di" by its
 * tokens alone, and a search index (which only guarantees folded
 * substring candidates, Appendix B.9) would miss it.
 */
export function nameMatchQuality(name: string, needle: Needle): number {
	const folded = tierQuality(
		foldDiacritics(name),
		needle.folded,
		needle.foldedTokens,
	);
	if (folded === 0) return 0;
	const raw = tierQuality(name.toLowerCase(), needle.raw, needle.rawTokens);
	return folded + (raw >= folded ? EXACT_SPELLING_BONUS : 0);
}

/** The best `nameMatchQuality` over a place's names. */
export function placeMatchQuality(
	names: readonly string[],
	needle: Needle,
): number {
	let best = 0;
	for (const name of names) {
		best = Math.max(best, nameMatchQuality(name, needle));
		if (best === QUALITY_MAX) break;
	}
	return best;
}
