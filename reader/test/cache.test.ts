import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteBudgetCache } from "../src/cache.ts";
import { CGeoDataReader } from "../src/index.ts";
import { APPENDIX_A_BYTES } from "./fixtures/appendixA.ts";

test("ByteBudgetCache evicts least recently used entries past its budget", () => {
	const cache = new ByteBudgetCache<string>(10);
	cache.set(1, "a", 4);
	cache.set(2, "b", 4);
	assert.equal(cache.get(1), "a"); // 1 is now more recent than 2
	cache.set(3, "c", 4); // 12 bytes: evicts 2, the least recently used
	assert.equal(cache.get(2), undefined);
	assert.equal(cache.get(1), "a");
	assert.equal(cache.get(3), "c");
	assert.equal(cache.size, 8);
});

test("ByteBudgetCache replaces an entry's value and size on re-set", () => {
	const cache = new ByteBudgetCache<string>(10);
	cache.set(1, "a", 4);
	cache.set(1, "A", 6);
	assert.equal(cache.get(1), "A");
	assert.equal(cache.size, 6);
});

test("ByteBudgetCache skips a value bigger than the whole budget", () => {
	const cache = new ByteBudgetCache<string>(10);
	cache.set(1, "a", 4);
	cache.set(2, "huge", 11);
	assert.equal(cache.get(2), undefined);
	assert.equal(cache.get(1), "a"); // not flushed to make room
	assert.equal(cache.size, 4);
});

test("open: cacheBytes bounds the cache, and 0 still answers lookups", async () => {
	const unlimited = await CGeoDataReader.open(APPENDIX_A_BYTES);
	const uncached = await CGeoDataReader.open(APPENDIX_A_BYTES, {
		cacheBytes: 0,
	});
	for (const [lat, lon] of [
		[52.37, 4.9],
		[51.2, 4.4],
		[0, 0],
		[52.37, 4.9],
	] as const) {
		assert.deepEqual(
			await uncached.query(lat, lon),
			await unlimited.query(lat, lon),
		);
	}
	for (const cacheBytes of [-1, Number.NaN]) {
		await assert.rejects(
			async () => await CGeoDataReader.open(APPENDIX_A_BYTES, { cacheBytes }),
			RangeError,
		);
	}
});
