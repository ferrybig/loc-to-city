#!/usr/bin/env node
/**
 * Counts, for every place, how many separate pieces ("islands") its cells
 * form across the whole file. Most places are one piece; an enclave, or a
 * sliver that only touches the rest at a corner, makes two or three. Dozens
 * mean two OSM polygons lying on top of each other, each winning scattered
 * cells from the other (Hyderabad).
 *
 *   node verify/src/islands.ts [file.bin] [--level city|region|country|all] [--top N] [--min N] [--per-chunk out.tsv]
 *
 * Only cities are ranked by default: a region's or country's own cells are
 * what its cities leave, so they break up wherever cities do (unincorporated
 * land between US towns).
 *
 * Two passes:
 * 1. `scanChunk`, per chunk: records of the same place that share an edge
 *    (not just a corner) are one island. Each island gets a 4-bit mask of
 *    the chunk borders it touches (`BORDER_WEST`, ...), and the stretches of
 *    those borders it covers.
 * 2. `combineIslands`: an island touching a border is joined to the island
 *    of the same place across it where their stretches overlap. The east
 *    neighbour of the last column is the first (the antimeridian).
 *
 * `--per-chunk` writes pass 1's result: chunk, place id, islands in that
 * chunk, and their border masks.
 */
import { createWriteStream } from "node:fs";
import { parseArgs } from "node:util";
import type { ChunkRecords } from "@ferrybig/cgeodata-reader/format";
import { openFile } from "@ferrybig/cgeodata-reader/node";
import { pickWorldBin } from "./pickBin.ts";

export const BORDER_WEST = 1;
export const BORDER_EAST = 2;
export const BORDER_SOUTH = 4;
export const BORDER_NORTH = 8;

/** One piece of a place inside one chunk. Coordinates are in cells of the
 * finest grid (`max_depth`), counted from the chunk's south-west corner. */
export interface Island {
	place: number;
	/** `BORDER_*` bits of the chunk borders it touches. */
	mask: number;
	/** Its area, in cells of the finest grid. */
	cells: number;
	/** The south-west corner of one of its records, and that record's side. */
	x: number;
	y: number;
	side: number;
}

/** A stretch of a chunk border, [start, end) along it, held by one island
 * (an index into `ChunkIslands.islands`). */
export interface BorderRun {
	start: number;
	end: number;
	island: number;
}

export interface ChunkIslands {
	islands: Island[];
	/** Indexed by side: west, east, south, north. Sorted by `start`, and
	 * not overlapping (they are the records along that side). */
	borders: [BorderRun[], BorderRun[], BorderRun[], BorderRun[]];
}

const WEST = 0;
const EAST = 1;
const SOUTH = 2;
const NORTH = 3;

/** Every other bit of `v`, from bit 0: the x half of a Morton code (and,
 * shifted right by one, the y half). Codes fit 32 bits (max_depth <= 16). */
export function compactBits(v: number): number {
	v &= 0x55555555;
	v = (v | (v >>> 1)) & 0x33333333;
	v = (v | (v >>> 2)) & 0x0f0f0f0f;
	v = (v | (v >>> 4)) & 0x00ff00ff;
	v = (v | (v >>> 8)) & 0x0000ffff;
	return v;
}

function find(parent: Int32Array | number[], i: number): number {
	while (parent[i] !== i) {
		const up = parent[parent[i]!]!;
		parent[i] = up;
		i = up;
	}
	return i;
}

function union(parent: Int32Array | number[], a: number, b: number): void {
	const ra = find(parent, a);
	const rb = find(parent, b);
	if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

/** Records starting at one coordinate, sorted by where they start along
 * the other axis. */
function lines(
	keys: Uint32Array,
	along: Uint32Array,
	members: number[],
): Map<number, number[]> {
	const byKey = new Map<number, number[]>();
	for (const i of members) {
		const list = byKey.get(keys[i]!);
		if (list) list.push(i);
		else byKey.set(keys[i]!, [i]);
	}
	for (const list of byKey.values()) list.sort((a, b) => along[a]! - along[b]!);
	return byKey;
}

/** Pass 1: the islands of one decoded chunk. `maxDepth` is the file's. */
export function scanChunk(chunk: ChunkRecords, maxDepth: number): ChunkIslands {
	const n = chunk.codes.length;
	const size = 2 ** maxDepth;
	const xs = new Uint32Array(n);
	const ys = new Uint32Array(n);
	const sides = new Uint32Array(n);
	const places = new Int32Array(n);
	const members: number[] = [];
	for (let i = 0; i < n; i++) {
		const k = chunk.paletteIndices[i]!;
		if (k === 0) continue;
		const code = chunk.codes[i]!;
		xs[i] = compactBits(code);
		ys[i] = compactBits(code >>> 1);
		sides[i] = 2 ** (maxDepth - chunk.depths[i]!);
		places[i] = chunk.palette[k - 1]!;
		members.push(i);
	}

	const parent = new Int32Array(n);
	for (let i = 0; i < n; i++) parent[i] = i;
	const columns = lines(xs, ys, members);
	const rows = lines(ys, xs, members);
	// Each record looks east and north only; west and south are the other
	// record looking east and north.
	const joinAlong = (
		line: number[] | undefined,
		along: Uint32Array,
		from: number,
		to: number,
		i: number,
	): void => {
		if (!line) return;
		let lo = 0;
		let hi = line.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			const j = line[mid]!;
			if (along[j]! + sides[j]! <= from) lo = mid + 1;
			else hi = mid;
		}
		for (let m = lo; m < line.length; m++) {
			const j = line[m]!;
			if (along[j]! >= to) break;
			if (places[j] === places[i]) union(parent, i, j);
		}
	};
	for (const i of members) {
		const s = sides[i]!;
		joinAlong(columns.get(xs[i]! + s), ys, ys[i]!, ys[i]! + s, i);
		joinAlong(rows.get(ys[i]! + s), xs, xs[i]!, xs[i]! + s, i);
	}

	const islands: Island[] = [];
	const islandOf = new Map<number, number>();
	const borders: ChunkIslands["borders"] = [[], [], [], []];
	for (const i of members) {
		const root = find(parent, i);
		let index = islandOf.get(root);
		if (index === undefined) {
			index = islands.length;
			islandOf.set(root, index);
			islands.push({
				place: places[i]!,
				mask: 0,
				cells: 0,
				x: xs[i]!,
				y: ys[i]!,
				side: sides[i]!,
			});
		}
		const island = islands[index]!;
		const x = xs[i]!;
		const y = ys[i]!;
		const s = sides[i]!;
		island.cells += s * s;
		if (x === 0) {
			island.mask |= BORDER_WEST;
			borders[WEST].push({ start: y, end: y + s, island: index });
		}
		if (x + s === size) {
			island.mask |= BORDER_EAST;
			borders[EAST].push({ start: y, end: y + s, island: index });
		}
		if (y === 0) {
			island.mask |= BORDER_SOUTH;
			borders[SOUTH].push({ start: x, end: x + s, island: index });
		}
		if (y + s === size) {
			island.mask |= BORDER_NORTH;
			borders[NORTH].push({ start: x, end: x + s, island: index });
		}
	}
	for (const side of borders) side.sort((a, b) => a.start - b.start);
	return { islands, borders };
}

/** A place's islands across the whole file. */
export interface PlaceIslands {
	place: number;
	islands: number;
	/** The smallest island not touching a chunk border (any island if all
	 * do): its chunk, one of its records, and its area in cells. */
	smallest: {
		chunk: number;
		x: number;
		y: number;
		side: number;
		cells: number;
		inside?: boolean;
	};
}

/** Pass 2: joins the islands of `chunks` (indexed by chunk index, row-major
 * from the south-west, `width` columns) across chunk borders, and counts
 * each place's. */
export function combineIslands(
	chunks: ReadonlyArray<ChunkIslands | undefined>,
	width: number,
): Map<number, PlaceIslands> {
	const offsets: number[] = [];
	let total = 0;
	for (const chunk of chunks) {
		offsets.push(total);
		total += chunk?.islands.length ?? 0;
	}
	const parent = new Int32Array(total);
	for (let i = 0; i < total; i++) parent[i] = i;

	const join = (a: number, aSide: number, b: number, bSide: number): void => {
		const left = chunks[a];
		const right = chunks[b];
		if (!left || !right) return;
		const as = left.borders[aSide]!;
		const bs = right.borders[bSide]!;
		let i = 0;
		let j = 0;
		while (i < as.length && j < bs.length) {
			const p = as[i]!;
			const q = bs[j]!;
			if (p.start < q.end && q.start < p.end) {
				if (left.islands[p.island]!.place === right.islands[q.island]!.place) {
					union(parent, offsets[a]! + p.island, offsets[b]! + q.island);
				}
			}
			if (p.end <= q.end) i++;
			else j++;
		}
	};
	const height = chunks.length / width;
	for (let index = 0; index < chunks.length; index++) {
		const col = index % width;
		const row = Math.floor(index / width);
		join(index, EAST, row * width + ((col + 1) % width), WEST);
		if (row + 1 < height) join(index, NORTH, index + width, SOUTH);
	}

	const result = new Map<number, PlaceIslands>();
	const counted = new Set<number>();
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (!chunk) continue;
		chunk.islands.forEach((island, k) => {
			const root = find(parent, offsets[index]! + k);
			let entry = result.get(island.place);
			if (!entry) {
				entry = {
					place: island.place,
					islands: 0,
					smallest: {
						chunk: index,
						x: 0,
						y: 0,
						side: 0,
						cells: Infinity,
						inside: false,
					},
				};
				result.set(island.place, entry);
			}
			if (!counted.has(root)) {
				counted.add(root);
				entry.islands++;
			}
			const inside = island.mask === 0;
			const best = entry.smallest;
			if (
				best.cells === Infinity ||
				(inside && (!best.inside || island.cells < best.cells))
			) {
				entry.smallest = {
					chunk: index,
					x: island.x,
					y: island.y,
					side: island.side,
					cells: island.cells,
					inside,
				};
			}
		});
	}
	return result;
}

const USAGE =
	"usage: islands.ts [file.bin] [--level city|region|country|all] [--top N] [--min N] [--per-chunk out.tsv]";

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			level: { type: "string", default: "city" },
			top: { type: "string", default: "100" },
			min: { type: "string", default: "2" },
			"per-chunk": { type: "string" },
		},
	});
	const file = positionals[0] ?? pickWorldBin();
	if (!file || positionals.length > 1) throw new Error(USAGE);
	const top = Number(values.top);
	const level = values.level;
	if (!["city", "region", "country", "all"].includes(level))
		throw new Error(USAGE);
	const min = Number(values.min);

	const reader = await openFile(file);
	const { width, height, maxDepth } = reader.header;
	const perChunk = values["per-chunk"]
		? createWriteStream(values["per-chunk"])
		: undefined;
	perChunk?.write("chunk\tplace\tislands\tmasks\n");
	const chunks: (ChunkIslands | undefined)[] = [];
	const count = width * height;
	for (let index = 0; index < count; index++) {
		const records = await reader.chunk(index, { cache: false });
		const scanned = records ? scanChunk(records, maxDepth) : undefined;
		chunks.push(scanned);
		if (perChunk && scanned) {
			const byPlace = new Map<number, number[]>();
			for (const island of scanned.islands) {
				const masks = byPlace.get(island.place);
				if (masks) masks.push(island.mask);
				else byPlace.set(island.place, [island.mask]);
			}
			for (const [place, masks] of byPlace)
				perChunk.write(
					`${index}\t${place}\t${masks.length}\t${masks.join(",")}\n`,
				);
		}
		if (index % 512 === 511)
			process.stderr.write(`\r${index + 1}/${count} chunks`);
	}
	process.stderr.write("\n");
	perChunk?.end();

	// Global ids are countries, then regions, then cities (Section 7.5).
	const { countries, regions } = reader.placeCounts;
	const levelOf = (id: number): string =>
		id < countries ? "country" : id < countries + regions ? "region" : "city";
	const places = [...combineIslands(chunks, width).values()].filter(
		(p) => level === "all" || levelOf(p.place) === level,
	);
	const histogram = new Map<string, number>();
	const bucket = (n: number): string =>
		n <= 4
			? String(n)
			: n < 10
				? "5-9"
				: n < 20
					? "10-19"
					: n < 50
						? "20-49"
						: "50+";
	for (const p of places)
		histogram.set(
			bucket(p.islands),
			(histogram.get(bucket(p.islands)) ?? 0) + 1,
		);
	console.log(`${places.length} places (${level}); islands per place:`);
	for (const key of ["1", "2", "3", "4", "5-9", "10-19", "20-49", "50+"])
		console.log(`  ${key.padStart(5)}  ${histogram.get(key) ?? 0}`);

	const cellLon = 360 / (width * 2 ** maxDepth);
	const cellLat = 180 / (height * 2 ** maxDepth);
	places.sort((a, b) => b.islands - a.islands || a.place - b.place);
	console.log(`\nislands\tplace\tlevel\tsmallest island (cells)\tlink`);
	for (const p of places.slice(0, top)) {
		if (p.islands < min) break;
		const place = await reader.place(p.place);
		const names = [place.city, place.region, place.country]
			.filter((ref) => ref !== null)
			.map((ref) => ref.localName)
			.join(" / ");
		const { chunk, x, y, side, cells } = p.smallest;
		const lon =
			-180 + (chunk % width) * (360 / width) + (x + side / 2) * cellLon;
		const lat =
			-90 +
			Math.floor(chunk / width) * (180 / height) +
			(y + side / 2) * cellLat;
		const at = `${lat.toFixed(5)},${lon.toFixed(5)}`;
		console.log(
			`${p.islands}\t${names}\t${place.level}\t${at} (${cells})\thttps://geodata.ferrybig.nl/#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`,
		);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
