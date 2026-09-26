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
import { existsSync } from "node:fs";
import { workerData } from "node:worker_threads";
import {
	CGeoDataReader,
	locateIndexPathFor,
	type QueryResult,
	searchIndexPathFor,
} from "@loc-to-city/reader";
import { renderTilePng } from "./tiles.js";

export interface WorkerData {
	datasetPath: string;
}

/** Attaches the sidecar index at `indexPath` if there is one, read on
 * demand from the file; one that doesn't match the dataset is skipped.
 * Returns what happened, for the server to log once rather than every
 * worker logging it. */
function attachIndex(
	kind: string,
	indexPath: string,
	use: (index: string | undefined) => void,
): string {
	if (!existsSync(indexPath)) {
		return `No ${kind} index at ${indexPath}; ${kind} scans the dataset.`;
	}
	try {
		use(indexPath);
		return `Using ${kind} index ${indexPath}.`;
	} catch (error) {
		use(undefined);
		return `Ignoring ${kind} index ${indexPath}: ${(error as Error).message}`;
	}
}

const { datasetPath } = workerData as WorkerData;
const reader = CGeoDataReader.open(datasetPath);
// Optional sidecars next to the dataset: data/world.bin pairs with
// data/world.search-index.bin (`cgeodata build-search-index`) and
// data/world.locate-index.bin (`cgeodata build-locate-index`). They only
// speed up search() and locate(); results are the same without them.
// Attached up front so a stale one is skipped instead of failing every
// request.
const indexStatus = [
	attachIndex("search", searchIndexPathFor(datasetPath), (index) =>
		reader.useSearchIndex(index),
	),
	attachIndex("locate", locateIndexPathFor(datasetPath), (index) =>
		reader.useLocateIndex(index),
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
	}): Uint8Array => renderTilePng(reader, z, x, y, resolution),
);

export const query = skipIfCancelled(
	({
		lat,
		lon,
	}: {
		lat: number;
		lon: number;
	}): QueryResult & { query_time_us: number } => {
		const t0 = performance.now();
		const result = reader.query(lat, lon);
		const t1 = performance.now();
		return { ...result, query_time_us: (t1 - t0) * 1000 };
	},
);

export const search = skipIfCancelled(({ q }: { q: string }) =>
	[...reader.search(q, { sort: true, limit: 5 })].map((place) => ({
		id: place.id,
		level: place.level,
		names: place.names,
		region: place.region?.names ?? null,
		country: place.country.names,
	})),
);

export const locate = skipIfCancelled(
	({ id }: { id: number }): { lat: number; lon: number } | null => {
		const pos = reader.locate(id);
		return pos && { lat: pos.lat, lon: pos.lon };
	},
);
