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
	/** The query lowercased, diacritics kept. */
	raw: string;
	/** `raw`'s words (`tokenize`). */
	rawTokens: string[];
	/** The query folded (`foldDiacritics`). */
	folded: string;
	/** `folded`'s words. */
	foldedTokens: string[];
}

/** `text` as a `Needle`, for scoring many names against one query. */
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

/** `quality` without `EXACT_SPELLING_BONUS`: the folded tier alone
 * (`QUALITY_SUBSTRING`, `QUALITY_WHOLE_WORD` or `QUALITY_EXACT`), or 0. */
export function qualityTier(quality: number): number {
	return quality - (quality % QUALITY_SUBSTRING);
}

// ── Area order (Appendix B.5.1) ───────────────────────────────────────────────

/**
 * Appendix C.3's area byte for an area of `cells` full-precision cells:
 * `0` for an empty area, otherwise the bit length of `cells^4`, at most
 * 255 -- `1 + floor(4 × log2(cells))`, a quarter of a doubling per step,
 * computed exactly. `cells` must be a non-negative integer.
 */
export function areaByte(cells: number): number {
	if (cells <= 0) return 0;
	const bits = (BigInt(cells) ** 4n).toString(2).length;
	return Math.min(bits, 255);
}

/**
 * The rank area of a region (Appendix B.5.1): its own area byte, unless
 * one or more of its cities has the same local name (field 0) once folded
 * (`foldDiacritics`) -- then the largest area byte among those cities, so
 * the province of Utrecht ranks right after the city of Utrecht instead of
 * ahead of it for being larger. A city-state with no same-named city of
 * its own (Berlin, Vienna) keeps its own area. Countries and cities rank by
 * their own area byte.
 */
export function regionRankArea(
	regionLocalName: string,
	regionArea: number,
	cities: Iterable<{ localName: string; area: number }>,
): number {
	const folded = foldDiacritics(regionLocalName);
	let best = -1;
	for (const city of cities) {
		if (city.area > best && foldDiacritics(city.localName) === folded)
			best = city.area;
	}
	return best < 0 ? regionArea : best;
}

/** One search match, with everything the relevance orders compare. */
export interface RankedMatch {
	/** The place's id. */
	id: number;
	/** The place's level. */
	level: PlaceLevel;
	/** Its match quality (`placeMatchQuality`) -- for a qualified query
	 * (Appendix B.13), the head's. */
	quality: number;
	/** The summed quality of a qualified query's contexts against the
	 * ancestors they matched; 0 for a plain query. */
	contextQuality: number;
	/** Its rank area (Appendix B.5.1); only the area order reads it. */
	rankArea: number;
}

/** Appendix B.5's relevance order, as a sort comparator: score
 * (`quality + LEVEL_BONUS`) descending, then context quality descending,
 * then id ascending. */
export function compareRelevance(a: RankedMatch, b: RankedMatch): number {
	return (
		b.quality + LEVEL_BONUS[b.level] - (a.quality + LEVEL_BONUS[a.level]) ||
		b.contextQuality - a.contextQuality ||
		a.id - b.id
	);
}

/**
 * Appendix B.5.1's area order, as a sort comparator: folded tier, then
 * context quality, then countries ahead of regions and cities, then rank
 * area, then the exact spelling bonus, then city ahead of region, then id
 * -- each only breaking ties left by the ones before it. Area comes before
 * the spelling bonus so that typing "zurich" can't put a hamlet literally
 * named Zurich ahead of the much larger Zürich.
 */
export function compareAreaRelevance(a: RankedMatch, b: RankedMatch): number {
	return (
		qualityTier(b.quality) - qualityTier(a.quality) ||
		b.contextQuality - a.contextQuality ||
		Number(b.level === "country") - Number(a.level === "country") ||
		b.rankArea - a.rankArea ||
		(b.quality % QUALITY_SUBSTRING) - (a.quality % QUALITY_SUBSTRING) ||
		LEVEL_BONUS[b.level] - LEVEL_BONUS[a.level] ||
		a.id - b.id
	);
}

// ── Qualified queries (Appendix B.13) ─────────────────────────────────────────

/** One reading of a search text: a head that a place's own names must
 * match, and contexts its ancestors' names must match, nearest first. */
export interface QueryInterpretation {
	/** Matched against the place's own names, as a plain query would be. */
	head: string;
	/** Each matched against a different ancestor, each further up than
	 * the one before (Appendix B.13). Empty for the whole text. */
	contexts: string[];
}

/**
 * The readings of a search text (Appendix B.13): the whole text as typed,
 * with no contexts, and for every comma in it, the text before that comma
 * as the head (trimmed) and each comma-separated part after it as a
 * context (trimmed, empty ones dropped). "Paris, Texas" is both a place
 * named "Paris, Texas" and a "Paris" under a "Texas"; a trailing comma
 * ("Paris,") reads as "Paris" alone. Duplicate readings are dropped.
 */
export function parseQualifiedQuery(text: string): QueryInterpretation[] {
	const readings: QueryInterpretation[] = [{ head: text, contexts: [] }];
	const parts = text.split(",");
	const seen = new Set<string>([JSON.stringify(readings[0])]);
	for (let k = 1; k < parts.length; k++) {
		const head = parts.slice(0, k).join(",").trim();
		if (head.length === 0) continue;
		const contexts = parts
			.slice(k)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		const reading = { head, contexts };
		const key = JSON.stringify(reading);
		if (seen.has(key)) continue;
		seen.add(key);
		readings.push(reading);
	}
	return readings;
}

/**
 * How well `contexts` match `ancestors` (nearest first, each a name list):
 * the best total quality over every way of matching context `i` to an
 * ancestor further up than context `i - 1`'s, or 0 when there is no such
 * way -- including when there are more contexts than ancestors. Every
 * context must match (Appendix B.13). `contexts` must be non-empty.
 */
export function contextQuality(
	contexts: readonly Needle[],
	ancestors: readonly (readonly string[])[],
): number {
	// best[j]: the best total for the contexts so far, the last one matched
	// to ancestor j (-1: impossible). Few contexts and at most two
	// ancestors, so this is tiny.
	let best = ancestors.map((names) => placeMatchQuality(names, contexts[0]!));
	best = best.map((q) => (q > 0 ? q : -1));
	for (let i = 1; i < contexts.length; i++) {
		const next = ancestors.map(() => -1);
		let prefix = -1;
		for (let j = 0; j < ancestors.length; j++) {
			if (prefix >= 0) {
				const q = placeMatchQuality(ancestors[j]!, contexts[i]!);
				if (q > 0) next[j] = prefix + q;
			}
			prefix = Math.max(prefix, best[j]!);
		}
		best = next;
	}
	return Math.max(0, ...best);
}
