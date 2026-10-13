/**
 * What the server's JSON endpoints answer (src/server.ts), as far as the
 * page reads it.
 */
import type { QueryResult as ReaderQueryResult } from "@ferrybig/cgeodata-reader";

/** The chunk grid (Section 6.1 of the format): `width` columns eastward
 * from longitude -180, `height` rows northward from latitude -90; chunk
 * `r * width + c`. */
export interface ChunkGrid {
	width: number;
	height: number;
}

export interface Download {
	name: string;
	description: string;
	url: string;
	bytes: number;
}

/** What the spot-checks offer, when the server has them for this dataset. */
export interface ChecksSummary {
	spot: number;
	capital: number;
	generatedAt: string;
	olderThanResolvedInput: boolean;
}

/** GET /api/about */
export interface About {
	attribution: string;
	/** The finest cell's size in degrees. */
	cellDegrees: { lon: number; lat: number };
	chunkGrid: ChunkGrid;
	docs: string | null;
	checks: ChecksSummary | null;
	downloads: Download[];
}

/** GET /api/query */
export type QueryResult = ReaderQueryResult & { query_time_us: number };

/** One of GET /api/search's `results`. */
export interface SearchResult {
	id: number;
	level: "country" | "region" | "city";
	names: string[];
	region: string[] | null;
	country: string[];
}

/** GET /api/locate */
export interface Located {
	lat: number;
	lon: number;
	/** Square degrees, everything under the place included. */
	area: number;
}

/** One of GET /api/checks's `checks` (src/checks.ts's CheckEntry). */
export interface CheckEntry {
	group: "spot" | "capital";
	name: string;
	lat: number;
	lon: number;
	outcome: string;
	section: string;
	expected: string;
	actual: { country: string[]; region: string[]; city: string[] };
}

/** The JSON at `url`; throws on an HTTP error, with the server's own
 * message where it sent one. */
export async function getJson<T>(url: string): Promise<T> {
	const resp = await fetch(url);
	const data = await resp.json();
	if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
	return data as T;
}
