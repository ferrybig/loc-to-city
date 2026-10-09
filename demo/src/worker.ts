/**
 * The demo server's piscina worker: everything that touches the dataset
 * runs here, so a slow tile or an index-less search never blocks the
 * server's event loop. Each worker thread opens its own reader once, when
 * piscina first loads this module, and the server picks a handler per
 * request by export name (`piscina.run(task, { name: "query" })`).
 *
 * Handlers take and return plain, structured-cloneable data. Bad input the
 * reader rejects (an out-of-range coordinate or place id) throws a
 * RangeError, which survives the trip back to the server as one.
 */
import { workerData } from "node:worker_threads";
import type { QueryResult } from "@loc-to-city/reader";
import {
	locateIndexPathFor,
	openFile,
	searchIndexPathFor,
} from "@loc-to-city/reader/node";
import { renderTilePng } from "./tiles.ts";

export interface WorkerData {
	datasetPath: string;
}

/** Opens the sidecar index `openFile()` found next to the dataset, if
 * there is one; one that doesn't match the dataset is dropped. Returns
 * what happened, for the server to log once rather than every worker
 * logging it. */
async function attachIndex(
	kind: string,
	indexPath: string,
	has: () => Promise<boolean>,
	drop: () => Promise<void>,
): Promise<string> {
	try {
		return (await has())
			? `Using ${kind} index ${indexPath}.`
			: `No ${kind} index at ${indexPath}; ${kind} scans the dataset.`;
	} catch (error) {
		await drop();
		return `Ignoring ${kind} index ${indexPath}: ${(error as Error).message}`;
	}
}

const { datasetPath } = workerData as WorkerData;
const reader = await openFile(datasetPath);
// Optional sidecars next to the dataset: data/03-final/world.bin pairs
// with data/03-final/world.search-index.bin (`cgeodata build-search-index`)
// and data/03-final/world.locate-index.bin (`cgeodata build-locate-index`). They only
// speed up search() and locate(); results are the same without them.
// Opened up front so a stale one is dropped instead of failing every
// request.
const indexStatus = [
	await attachIndex(
		"search",
		searchIndexPathFor(datasetPath),
		() => reader.hasSearchIndex(),
		() => reader.useSearchIndex(undefined),
	),
	await attachIndex(
		"locate",
		locateIndexPathFor(datasetPath),
		() => reader.hasLocateIndex(),
		() => reader.useLocateIndex(undefined),
	),
];

/** One line per sidecar index saying whether this worker uses it. Every
 * worker opens the same files, so any one worker's answer holds for all. */
export function indexes(): string[] {
	return indexStatus;
}

/** Set on every request's task by the server, and flipped to true once
 * the request's client has gone away. Piscina copies a task only when it
 * hands it to a worker, so one still queued by then arrives with this set
 * and is skipped instead of run. One already running just finishes: that
 * costs less than piscina's abort, which kills the worker thread. */
export interface Cancellable {
	cancelled: boolean;
}

/** `handler`, but resolving to undefined without running for a task
 * cancelled before it got here. */
function skipIfCancelled<T, R>(
	handler: (task: T) => R,
): (task: T & Cancellable) => R | undefined {
	return (task) => (task.cancelled ? undefined : handler(task));
}

/** A PNG. Typed as the Uint8Array the server receives: the Buffer made
 * here loses its Buffer-ness when cloned back to the main thread. */
export const tile = skipIfCancelled(
	({
		z,
		x,
		y,
		resolution,
	}: {
		z: number;
		x: number;
		y: number;
		resolution: number;
	}): Promise<Uint8Array> => renderTilePng(reader, z, x, y, resolution),
);

export const query = skipIfCancelled(
	async ({
		lat,
		lon,
	}: {
		lat: number;
		lon: number;
	}): Promise<QueryResult & { query_time_us: number }> => {
		const t0 = performance.now();
		const result = await reader.query(lat, lon);
		const t1 = performance.now();
		return { ...result, query_time_us: (t1 - t0) * 1000 };
	},
);

export const search = skipIfCancelled(async ({ q }: { q: string }) => {
	const results = [];
	for await (const place of reader.search(q, { sort: true, limit: 5 })) {
		results.push({
			id: place.id,
			level: place.level,
			names: place.names,
			region: place.region?.names ?? null,
			country: place.country.names,
		});
	}
	return results;
});

export const locate = skipIfCancelled(
	async ({
		id,
	}: {
		id: number;
	}): Promise<{ lat: number; lon: number } | null> => {
		const pos = await reader.locate(id);
		return pos && { lat: pos.lat, lon: pos.lon };
	},
);
