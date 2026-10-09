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
 * cache or heap. Sections: open, latency, bulk, tiles, search, memory.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sampleTile } from "../../demo/src/tiles.ts";
import { CGeoDataReader } from "../src/index.ts";

const SECTIONS: Record<string, (file: string) => void | Promise<void>> = {
	open,
	latency,
	bulk,
	tiles,
	search,
	memory,
};

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

function open(file: string): void {
	let t = performance.now();
	const reader = CGeoDataReader.open(file);
	row("open", ms(t));
	t = performance.now();
	reader.close();
	row("close", ms(t));
}

function latency(file: string): void {
	const reader = CGeoDataReader.open(file);
	const points: Array<[string, number, number]> = [
		["Paris", 48.8566, 2.3522],
		["Tokyo", 35.6762, 139.6503],
		["Amsterdam", 52.37, 4.9],
		["Den Haag", 52.08, 4.31],
		["mid-Atlantic", 0, -30],
	];
	for (const [label, lat, lon] of points) {
		const t = performance.now();
		reader.query(lat, lon);
		row(`query cold   ${label}`, ms(t));
	}
	for (const [label, lat, lon] of points) {
		const t = performance.now();
		reader.query(lat, lon);
		row(`query warm   ${label}`, ms(t));
	}
	reader.close();
}

function bulk(file: string): void {
	for (const [label, box] of [
		["world", WORLD],
		["europe", EUROPE],
	] as const) {
		const points = randomPoints(10_000, 1, box);
		const reader = CGeoDataReader.open(file);
		let t = performance.now();
		for (const [lat, lon] of points) reader.queryPlaceId(lat, lon);
		row(`10k queryPlaceId ${label}, first pass`, ms(t));
		t = performance.now();
		for (const [lat, lon] of points) reader.queryPlaceId(lat, lon);
		row(`10k queryPlaceId ${label}, second pass`, ms(t));
		reader.close();
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

function tiles(file: string): void {
	const reader = CGeoDataReader.open(file);
	for (const [z, x, y, resolution] of TILES) {
		let t = performance.now();
		sampleTile(reader, z, x, y, resolution, 1);
		const cold = ms(t);
		t = performance.now();
		const reps = 5;
		for (let i = 0; i < reps; i++) sampleTile(reader, z, x, y, resolution, 1);
		const warm = ((performance.now() - t) / reps).toFixed(2).padStart(9);
		row(`tile ${z}/${x}/${y} @${resolution} cold`, cold);
		row(`tile ${z}/${x}/${y} @${resolution} warm (avg of ${reps})`, warm);
	}
	reader.close();
}

function search(file: string): void {
	const reader = CGeoDataReader.open(file);
	console.log(
		`# search index: ${reader.hasSearchIndex}, locate index: ${reader.hasLocateIndex}`,
	);
	for (const [q, sort] of [
		["berlin", true],
		["berlin", true],
		["amst", false],
		["den haag", true],
	] as const) {
		const t = performance.now();
		const hits = [...reader.search(q, { sort, limit: 20 })];
		row(
			`search ${JSON.stringify(q)} sort=${sort} (${hits.length} hits)`,
			ms(t),
		);
	}
	if (reader.hasLocateIndex) {
		const ids = [...reader.search("paris", { sort: true, limit: 20 })].map(
			(p) => p.id,
		);
		const t = performance.now();
		for (const id of ids) reader.locate(id);
		row(`locate x${ids.length} (indexed)`, ms(t));
	}
	reader.close();
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
	const reader = CGeoDataReader.open(file);
	await yieldAndGc();
	report("after open");
	for (const [lat, lon] of points) reader.query(lat, lon);
	report("5k scattered, one sync job");
	await yieldAndGc();
	report("  after yield + gc");
	for (const [lat, lon] of points) {
		reader.query(lat, lon);
		await new Promise((resolve) => setImmediate(resolve));
	}
	report("5k scattered, one job each");
	await yieldAndGc();
	report("  after yield + gc");
	reader.close();
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
