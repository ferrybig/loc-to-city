import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSearchIndex, CGeoDataReader, type Place } from "../src/index.ts";
import { openFile } from "../src/node.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";
import { collect } from "./helpers.ts";

// Appendix A.3's identifier table: 0-1 countries, 2-3 regions, 4-6 cities.
const reader = await CGeoDataReader.open(APPENDIX_A_BYTES);

const NL = { id: 0, names: ["Nederland", "The Netherlands"] };
const BE = { id: 1, names: ["België", "Belgium"] };
const NH = { id: 2, names: ["Noord-Holland"] };
const ANT = { id: 3, names: ["Antwerpen", "Antwerp"] };

async function ids(places: AsyncIterable<Place>): Promise<number[]> {
	return (await collect(places)).map((p) => p.id);
}

test("placeCounts reflects the place table prefix", () => {
	assert.deepEqual(reader.placeCounts, { countries: 2, regions: 2, cities: 3 });
});

test("place(id) resolves each level with the QueryResult-shaped trio", async () => {
	assert.deepEqual(await reader.place(0), {
		id: 0,
		level: "country",
		names: NL.names,
		country: NL,
		region: null,
		city: null,
	});
	assert.deepEqual(await reader.place(3), {
		id: 3,
		level: "region",
		names: ANT.names,
		country: BE,
		region: ANT,
		city: null,
	});
	assert.deepEqual(await reader.place(5), {
		id: 5,
		level: "city",
		names: ["Zaandam"],
		country: NL,
		region: NH,
		city: { id: 5, names: ["Zaandam"] },
	});
	await assert.rejects(async () => await reader.place(7), RangeError);
});

test("placeIds(id) is place(id)'s level and ids without the names", async () => {
	for (let id = 0; id < 7; id++) {
		const place = await reader.place(id);
		assert.deepEqual(reader.placeIds(id), {
			level: place.level,
			country: place.country.id,
			region: place.region?.id ?? null,
			city: place.city?.id ?? null,
		});
	}
	assert.throws(() => reader.placeIds(7), RangeError);
});

test("query() is queryPlaceId() plus the place's names", async () => {
	// Appendix A's lookups: Zaandam (5), Noord-Holland (2), and three unknowns.
	for (const [lat, lon, placeId] of [
		[20, 100, 5],
		[40, 30, 2],
		[30, 100, null],
		[20, 170, null],
		[-10, 10, null],
	] as const) {
		const byId = await reader.lookup(lat, lon);
		assert.deepEqual(byId.placeId, placeId);
		const place = placeId === null ? null : await reader.place(placeId);
		assert.deepEqual(await reader.query(lat, lon), {
			...byId,
			country: place?.country.names ?? null,
			region: place?.region?.names ?? null,
			city: place?.city?.names ?? null,
		});
	}
});

test("places() walks in id order and honours level/country/region filters", async () => {
	assert.deepEqual(await ids(reader.places()), [0, 1, 2, 3, 4, 5, 6]);
	assert.deepEqual(await ids(reader.places({ level: "country" })), [0, 1]);
	assert.deepEqual(await ids(reader.places({ level: "city" })), [4, 5, 6]);
	assert.deepEqual(
		await ids(reader.places({ country: 0 })),
		[0, 2, 4, 5],
		"the country itself, its regions, its cities",
	);
	assert.deepEqual(
		await ids(reader.places({ country: 1, level: "city" })),
		[6],
	);
	assert.deepEqual(await ids(reader.places({ region: 2 })), [0, 2, 4, 5]);
	assert.deepEqual(await ids(reader.places({ region: 3, level: "city" })), [6]);
	assert.deepEqual(
		await ids(reader.places({ country: 0, region: 3 })),
		[],
		"a region not in that country yields nothing",
	);
	await assert.rejects(
		async () => await collect(reader.places({ country: 2 })),
		/not a country id/,
	);
	await assert.rejects(
		async () => await collect(reader.places({ region: 0 })),
		/not a region id/,
	);
});

test("search() matches any name of any level, case-insensitively, with limit", async () => {
	assert.deepEqual(
		await ids(reader.search("antwerp")),
		[3, 6],
		"region and city share the name",
	);
	assert.deepEqual(
		await ids(reader.search("NETHER")),
		[0],
		"matches an alternative name",
	);
	assert.deepEqual(await ids(reader.search("dam")), [4, 5]);
	assert.deepEqual(await ids(reader.search("dam", { limit: 1 })), [4]);
	assert.deepEqual(await ids(reader.search("dam", { limit: 0 })), []);
	assert.deepEqual(await ids(reader.search("antwerp", { level: "city" })), [6]);
	assert.deepEqual(await ids(reader.search("e", { country: 1 })), [1, 3, 6]);
	assert.deepEqual(
		await ids(reader.search("e", { region: 3 })),
		[1, 3, 6],
		"a region filter still yields its country",
	);
	assert.deepEqual(await ids(reader.search("nothing here")), []);
});

test("search() folds diacritics: a plain-ASCII query finds an accented name", async () => {
	assert.deepEqual(
		await ids(reader.search("belgie")),
		[1],
		"België, typed without the diaeresis",
	);
	assert.deepEqual(
		await ids(reader.search("BELGIE")),
		[1],
		"case-insensitive too",
	);
});

test("search({ sort: true }): a country beats a same-quality region or city match", async () => {
	// "e" matches every place's name, but only the two countries reach it
	// via an exact-spelling, no-fold-needed field match at the finest tier
	// either of them can ("Nederland"/"the Netherlands" and "België"
	// (folded)/"Belgium" are all plain substring matches) -- LEVEL_BONUS
	// should still put both countries ahead of every region and city.
	const sorted = await ids(reader.search("e", { sort: true }));
	assert.deepEqual(
		sorted.slice(0, 2).sort((a, b) => a - b),
		[0, 1],
		"both countries lead",
	);
});

test("search: a short, accented query agrees with and without a search index (the folded short-query key can't carry a raw-spelling bonus a live scan would)", async () => {
	// Regression: "ë" folds to the same 1-2-character short-query key as
	// plain "e", but "België" raw-matches "ë" exactly (it's spelled with
	// one) while the key "e" itself never does -- searchRanked() must
	// refuse the table for an accented query and fall back to a live scan,
	// or index and no-index search would disagree.
	const indexed = await CGeoDataReader.open(APPENDIX_A_BYTES);
	await indexed.useSearchIndex(await buildSearchIndex(indexed));
	const linear = await CGeoDataReader.open(APPENDIX_A_BYTES);
	assert.deepEqual(
		await ids(indexed.search("ë", { sort: true, limit: 1 })),
		await ids(linear.search("ë", { sort: true, limit: 1 })),
	);
	await indexed.close();
	await linear.close();
});

test("search({ sort: true }): equal name-match quality is broken by level, then id", async () => {
	// Region 3 and city 6 have the exact same name entry ("Antwerpen |
	// Antwerp"), so "antwerp" is an equally exact match for both -- sort
	// should still put the city first on the level bonus alone, reversing
	// id order (unsorted: [3, 6]).
	assert.deepEqual(await ids(reader.search("antwerp", { sort: true })), [6, 3]);
	// sort doesn't filter, just reorders and re-slices `limit`.
	assert.deepEqual(
		await ids(reader.search("antwerp", { sort: true, limit: 1 })),
		[6],
	);
	assert.deepEqual(
		await ids(reader.search("antwerp", { sort: true, limit: 0 })),
		[],
	);
	assert.deepEqual(
		await ids(reader.search("nothing here", { sort: true })),
		[],
	);
});

test("search({ sort: true }) ranks the same match set as unsorted search", async () => {
	// Leading/trailing spaces keep "amsterdam"'s tokens but aren't a
	// substring of "Amsterdam": neither search may match it.
	for (const q of [" amsterdam", "amsterdam ", " antwerp ", "antwerp", "dam"]) {
		assert.deepEqual(
			new Set(await ids(reader.search(q, { sort: true }))),
			new Set(await ids(reader.search(q))),
			JSON.stringify(q),
		);
	}
	assert.deepEqual(await ids(reader.search(" amsterdam", { sort: true })), []);
});

// Built by `make world`, not committed (see CLAUDE.md).
const WORLD_BIN = fileURLToPath(
	new URL("../../data/03-final/world.bin", import.meta.url),
);

test("search({ sort: true }) on the real worldwide dataset: an exact name match outranks a fuzzier one", {
	skip: !existsSync(WORLD_BIN),
}, async () => {
	// Unlike Appendix A, the real dataset has several places whose name
	// merely contains "amsterdam" (Nieuw Amsterdam, Amsterdam-Duivendrecht,
	// ...) alongside the ones actually named "Amsterdam" (the Dutch city,
	// plus US incorporated places in Missouri, Ohio, ...) -- the case that
	// motivated --sort in the first place. Assertions are shaped around
	// that invariant rather than specific ids, since a later data rebuild
	// can renumber places.
	const worldReader = await openFile(WORLD_BIN);
	// Ranking is under test here, not the index: don't depend on whether a
	// (gitignored, possibly stale) world.search-index.bin sits next to it.
	await worldReader.useSearchIndex(undefined);
	try {
		const unsorted = await collect(worldReader.search("amsterdam"));
		const sorted = await collect(
			worldReader.search("amsterdam", { sort: true }),
		);
		assert.ok(
			unsorted.length >= 2,
			"sanity: the real dataset has more than one Amsterdam-ish place",
		);
		assert.deepEqual(
			new Set(sorted.map((p) => p.id)),
			new Set(unsorted.map((p) => p.id)),
			"sort reorders the same match set, it doesn't filter it",
		);

		const isExactMatch = (p: Place) =>
			p.names.some((n) => n.toLowerCase() === "amsterdam");
		assert.equal(sorted[0]?.level, "city");
		assert.ok(
			isExactMatch(sorted[0]!),
			'the top match is a place actually named "Amsterdam"',
		);
		const firstOther = sorted.findIndex(
			(p) => !(isExactMatch(p) && p.level === "city"),
		);
		const exactCities = firstOther === -1 ? sorted.length : firstOther;
		assert.ok(
			exactCities >= 1,
			'sanity: at least one city is named exactly "Amsterdam"',
		);
		for (const place of sorted.slice(exactCities)) {
			assert.ok(
				!(isExactMatch(place) && place.level === "city"),
				`${place.id} (${place.names.join(" | ")}) is a city named exactly "Amsterdam" but ranks below a fuzzier match`,
			);
		}
	} finally {
		await worldReader.close();
	}
});

test("chunk()/chunkRecords() expose Appendix A.4's records with cells and places resolved", async () => {
	assert.equal(await reader.chunk(0), undefined, "empty chunk");
	await assert.rejects(async () => await reader.chunk(4), RangeError);
	assert.deepEqual(reader.chunkBoundingBox(3), {
		minLat: 0,
		maxLat: 90,
		minLon: 0,
		maxLon: 180,
	});

	const records = await collect(reader.chunkRecords(3));
	assert.equal(records.length, (await reader.chunk(3))!.codes.length);
	// Lookup 1 (lat 20, lon 100) lands in the cell that resolves to Zaandam:
	// the same cell query() reports as its bounding box.
	const expected = await reader.query(20, 100);
	const zaandam = records.find((r) => r.place?.id === 5);
	assert.ok(zaandam);
	assert.deepEqual(zaandam.boundingBox, expected.boundingBox);
	// Every record's cell lies inside the chunk, and "no place" records exist as null.
	for (const r of records) {
		assert.ok(r.boundingBox.minLat >= 0 && r.boundingBox.maxLat <= 90);
		assert.ok(r.boundingBox.minLon >= 0 && r.boundingBox.maxLon <= 180);
		assert.ok(r.depth <= reader.header.maxDepth);
	}
	assert.deepEqual(await collect(reader.chunkRecords(0)), []);
});
