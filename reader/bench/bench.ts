/**
 * Performance baseline for the reader: latency of single lookups, bulk
 * lookup throughput (the demo's tile renderer is the bulk workload to
 * protect), search/locate with the sidecar indexes, and memory under
 * scattered lookups. Not a test -- numbers to compare before and after a
 * change to the reader's I/O, caching or API shape.
 *
 *   node --expose-gc reader/bench/bench.ts <file.bin> [section...]
 *
 * Each section runs in its own child process so no section sees another's
 * cache or heap. Sections: open, latency, bulk, tiles, burst, eventloop,
 * search, memory. CGEODATA_BENCH_CACHE_BYTES sets the reader's cache
 * budget (`OpenOptions.cacheBytes`); CGEODATA_BENCH_WASM=0 turns off
 * the WebAssembly chunk decoder, to compare against the JavaScript one.
 */
import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { sampleTile } from "../../demo/src/tiles.ts";
import { useWasmChunkDecoder } from "../src/chunkDecoder.ts";
import type { CGeoDataReader } from "../src/index.ts";
import { openFile } from "../src/node.ts";
import { useWasmRangeDecoder } from "../src/rangeDecoder.ts";

const SECTIONS: Record<string, (file: string) => void | Promise<void>> = {
	open,
	latency,
	bulk,
	tiles,
	burst,
	eventloop,
	search,
	memory,
};

const CACHE_BYTES = process.env.CGEODATA_BENCH_CACHE_BYTES;
if (process.env.CGEODATA_BENCH_WASM === "0") {
	useWasmChunkDecoder(false);
	useWasmRangeDecoder(false);
}

function openReader(file: string): Promise<CGeoDataReader> {
	return CACHE_BYTES === undefined
		? openFile(file)
		: openFile(file, { cacheBytes: Number(CACHE_BYTES) });
}

/** Lets the event loop turn over, as between two tasks of a server. */
function nextTask(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function ms(start: number): string {
	return (performance.now() - start).toFixed(2).padStart(9);
}

function row(label: string, value: string, unit = "ms"): void {
	console.log(`${label.padEnd(44)} ${value} ${unit}`);
}

/** Deterministic PRNG, so every run queries the same points. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomPoints(
	n: number,
	seed: number,
	[minLat, maxLat, minLon, maxLon]: [number, number, number, number],
): Array<[number, number]> {
	const rand = mulberry32(seed);
	return Array.from({ length: n }, () => [
		minLat + rand() * (maxLat - minLat),
		minLon + rand() * (maxLon - minLon),
	]);
}

const WORLD: [number, number, number, number] = [-60, 75, -180, 180];
const EUROPE: [number, number, number, number] = [36, 70, -10, 40];

async function open(file: string): Promise<void> {
	let t = performance.now();
	const reader = await openReader(file);
	row("open", ms(t));
	t = performance.now();
	await reader.close();
	row("close", ms(t));
}

async function latency(file: string): Promise<void> {
	const reader = await openReader(file);
	const points: Array<[string, number, number]> = [
		["Paris", 48.8566, 2.3522],
		["Tokyo", 35.6762, 139.6503],
		["Amsterdam", 52.37, 4.9],
		["Den Haag", 52.08, 4.31],
		["mid-Atlantic", 0, -30],
	];
	for (const [label, lat, lon] of points) {
		const t = performance.now();
		await reader.query(lat, lon);
		row(`query cold   ${label}`, ms(t));
	}
	for (const [label, lat, lon] of points) {
		const t = performance.now();
		await reader.query(lat, lon);
		row(`query warm   ${label}`, ms(t));
	}
	await reader.close();
}

async function bulk(file: string): Promise<void> {
	for (const [label, box] of [
		["world", WORLD],
		["europe", EUROPE],
	] as const) {
		const points = randomPoints(10_000, 1, box);
		for (const cached of [false, true]) {
			const how = cached ? "lookupCached ?? lookup" : "await lookup";
			const reader = await openReader(file);
			for (const pass of ["first", "second"]) {
				const t = performance.now();
				for (const [lat, lon] of points) {
					if (cached)
						reader.lookupCached(lat, lon) ?? (await reader.lookup(lat, lon));
					else await reader.lookup(lat, lon);
				}
				row(`10k ${how} ${label}, ${pass}`, ms(t));
			}
			await reader.close();
		}
	}
}

/** Tiles at a spread of zooms around the Netherlands (where every
 * dataset, including zuid-holland.bin, has data) and one zoomed-out tile
 * over Europe, rendered as the demo does: default resolution, margin 1. */
const TILES: Array<[z: number, x: number, y: number, resolution: number]> = [
	[3, 4, 2, 16],
	[6, 32, 21, 2],
	[8, 131, 84, 1],
	[10, 525, 337, 1],
	[13, 4207, 2702, 1],
];

async function tiles(file: string): Promise<void> {
	const reader = await openReader(file);
	for (const [z, x, y, resolution] of TILES) {
		let t = performance.now();
		await sampleTile(reader, z, x, y, resolution, 1);
		const cold = ms(t);
		const reps = 5;
		let total = 0;
		// Each repeat a task of its own, as a server would render it:
		// otherwise a WeakRef cache can't drop anything between repeats.
		for (let i = 0; i < reps; i++) {
			await nextTask();
			t = performance.now();
			await sampleTile(reader, z, x, y, resolution, 1);
			total += performance.now() - t;
		}
		const warm = (total / reps).toFixed(2).padStart(9);
		row(`tile ${z}/${x}/${y} @${resolution} cold`, cold);
		row(`tile ${z}/${x}/${y} @${resolution} warm (avg of ${reps})`, warm);
	}
	await reader.close();
}

/** Leaflet's tile coordinates of a point at zoom `z`. */
function tileAt(lat: number, lon: number, z: number): [x: number, y: number] {
	const n = 2 ** z;
	const rad = (lat * Math.PI) / 180;
	return [
		Math.floor(((lon + 180) / 360) * n),
		Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n),
	];
}

/**
 * What the demo server actually sees: a browser opening the page asks for
 * a 1920x1080 viewport's tiles at once (8x4 = 32 tiles), each a task of
 * its own, from a cold reader. Once at the page's initial view, once
 * zoomed out over Europe, where tiles touch many large chunks.
 */
async function burst(file: string): Promise<void> {
	const { defaultTileResolution } = await import("../../demo/src/tiles.ts");
	for (const [label, lat, lon, z] of [
		["initial view z10", 52.05, 4.3, 10],
		["europe z4", 50, 10, 4],
	] as const) {
		const reader = await openReader(file);
		const [cx, cy] = tileAt(lat, lon, z);
		const start = performance.now();
		let worst = 0;
		for (let dy = -2; dy < 2; dy++) {
			for (let dx = -4; dx < 4; dx++) {
				await nextTask();
				const t = performance.now();
				await sampleTile(
					reader,
					z,
					cx + dx,
					cy + dy,
					defaultTileResolution(z),
					1,
				);
				worst = Math.max(worst, performance.now() - t);
			}
		}
		row(`burst 32 tiles, ${label}`, ms(start));
		row(`  slowest tile`, worst.toFixed(2).padStart(9));
		await reader.close();
	}
}

/**
 * How long the event loop is held up while lookups decode chunks: the
 * longest single delay a timer saw (what a server's other requests wait
 * at worst) during 300 cold lookups scattered over Europe -- one after
 * another, then all at once.
 */
async function eventloop(file: string): Promise<void> {
	const points = randomPoints(300, 3, EUROPE);
	for (const concurrent of [false, true]) {
		const reader = await openReader(file);
		const histogram = monitorEventLoopDelay({ resolution: 1 });
		histogram.enable();
		const t = performance.now();
		if (concurrent)
			await Promise.all(points.map(([lat, lon]) => reader.lookup(lat, lon)));
		else for (const [lat, lon] of points) await reader.lookup(lat, lon);
		const elapsed = ms(t);
		// Let the timer that was held up by the last stretch of work fire,
		// so the histogram records that delay too.
		await new Promise((resolve) => setTimeout(resolve, 5));
		histogram.disable();
		const how = concurrent ? "concurrent" : "sequential";
		row(`300 cold lookups, ${how}`, elapsed);
		row(`  max event loop delay`, (histogram.max / 1e6).toFixed(2).padStart(9));
		row(
			`  p99 event loop delay`,
			(histogram.percentile(99) / 1e6).toFixed(2).padStart(9),
		);
		await reader.close();
	}
}

async function search(file: string): Promise<void> {
	const reader = await openReader(file);
	const hasLocateIndex = await reader.hasLocateIndex();
	console.log(
		`# search index: ${await reader.hasSearchIndex()}, locate index: ${hasLocateIndex}`,
	);
	for (const [q, sort] of [
		["berlin", true],
		["berlin", true],
		["amst", false],
		["den haag", true],
	] as const) {
		const t = performance.now();
		const hits = await collect(reader.search(q, { sort, limit: 20 }));
		row(
			`search ${JSON.stringify(q)} sort=${sort} (${hits.length} hits)`,
			ms(t),
		);
	}
	if (hasLocateIndex) {
		const ids = (
			await collect(reader.search("paris", { sort: true, limit: 20 }))
		).map((p) => p.id);
		const t = performance.now();
		for (const id of ids) await reader.locate(id);
		row(`locate x${ids.length} (indexed)`, ms(t));
	}
	await reader.close();
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

function mb(bytes: number): string {
	return (bytes / 2 ** 20).toFixed(0).padStart(9);
}

async function memory(file: string): Promise<void> {
	const gc = (globalThis as { gc?: () => void }).gc;
	if (!gc) throw new Error("memory section needs node --expose-gc");
	const yieldAndGc = async () => {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	};
	const report = (label: string) => {
		const { rss, external, heapUsed } = process.memoryUsage();
		row(`${label} rss`, mb(rss), "MB");
		row(`${label} external+heap`, mb(external + heapUsed), "MB");
	};
	const points = randomPoints(5_000, 2, WORLD);
	const reader = await openReader(file);
	await yieldAndGc();
	report("after open");
	for (const [lat, lon] of points) await reader.query(lat, lon);
	report("5k scattered, one after another");
	await yieldAndGc();
	report("  after yield + gc");
	await Promise.all(points.map(([lat, lon]) => reader.query(lat, lon)));
	report("5k scattered, all at once");
	await yieldAndGc();
	report("  after yield + gc");
	await reader.close();
}

const [file, ...requested] = process.argv.slice(2);
if (!file) {
	console.error(
		"usage: node --expose-gc reader/bench/bench.ts <file.bin> [section...]",
	);
	process.exit(2);
}
const child = process.env.CGEODATA_BENCH_CHILD === "1";
if (child) {
	for (const name of requested) await SECTIONS[name]!(file);
} else {
	const names = requested.length > 0 ? requested : Object.keys(SECTIONS);
	console.log(`# ${file}, node ${process.version}`);
	for (const name of names) {
		if (!SECTIONS[name]) throw new Error(`unknown section ${name}`);
		console.log(`## ${name}`);
		process.stdout.write(
			execFileSync(
				process.execPath,
				["--expose-gc", fileURLToPath(import.meta.url), file, name],
				{
					env: { ...process.env, CGEODATA_BENCH_CHILD: "1" },
					encoding: "utf8",
				},
			),
		);
	}
}
