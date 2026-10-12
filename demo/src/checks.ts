/**
 * The spot-checks the page draws as markers: `<dataset>.checks.json`, next
 * to the dataset like its sidecar indexes (written by `verify/src/export.ts`,
 * `make data/03-final/<name>.checks.json`). Only the fields the page needs
 * are described here; this package does not depend on `verify`.
 *
 * Like a stale index, a file made for a different dataset is ignored, not
 * served: the markers claim what this dataset answers.
 */
import { readFile, stat } from "node:fs/promises";

/** The `version` of the file this reads. */
export const SUPPORTED_VERSION = 1;

export interface CheckEntry {
	id: string;
	group: "spot" | "capital";
	name: string;
	lat: number;
	lon: number;
	outcome: string;
	status: string;
	section: string;
	expected: string;
	actual: { country: string[]; region: string[]; city: string[] };
}

export interface ChecksFile {
	version: number;
	generatedAt: string;
	dataset: { bytes: number; olderThanResolvedInput: boolean };
	summary: Record<string, number>;
	checks: CheckEntry[];
}

export interface LoadedChecks {
	/** What to log at startup: that the markers are on, or why they are not. */
	message: string;
	/** The file, or null when there are no markers to show. */
	checks: ChecksFile | null;
}

/** Where the checks for `datasetPath` are looked for. */
export function checksPathFor(datasetPath: string): string {
	return datasetPath.replace(/(\.bin)?$/, ".checks.json");
}

function isCheckEntry(e: unknown): e is CheckEntry {
	if (typeof e !== "object" || e === null) return false;
	const c = e as Record<string, unknown>;
	return (
		typeof c.id === "string" &&
		(c.group === "spot" || c.group === "capital") &&
		typeof c.name === "string" &&
		typeof c.lat === "number" &&
		typeof c.lon === "number" &&
		typeof c.outcome === "string" &&
		typeof c.section === "string" &&
		typeof c.expected === "string" &&
		typeof c.actual === "object" &&
		c.actual !== null
	);
}

/** `file` defaults to the one next to `datasetPath`. */
export async function loadChecks(
	datasetPath: string,
	file = checksPathFor(datasetPath),
): Promise<LoadedChecks> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return { message: `No spot-check markers (no ${file}).`, checks: null };
		}
		throw e;
	}
	const off = (why: string): LoadedChecks => ({
		message: `Ignoring ${file}: ${why}.`,
		checks: null,
	});
	let parsed: Partial<ChecksFile>;
	try {
		parsed = JSON.parse(text);
	} catch {
		return off("not valid JSON");
	}
	if (parsed.version !== SUPPORTED_VERSION) {
		return off(`version ${parsed.version}, expected ${SUPPORTED_VERSION}`);
	}
	if (
		!Array.isArray(parsed.checks) ||
		!parsed.checks.every(isCheckEntry) ||
		typeof parsed.dataset?.bytes !== "number"
	) {
		return off("unexpected shape");
	}
	const { size } = await stat(datasetPath);
	if (parsed.dataset.bytes !== size) {
		return off(
			`made for a dataset of ${parsed.dataset.bytes} bytes, this one is ${size}`,
		);
	}
	return {
		message: `Spot-check markers: ${parsed.checks.length} from ${file}.`,
		checks: parsed as ChecksFile,
	};
}

/** What `/api/about` says about the markers, so the page can show its
 * panel without a request that might 404. */
export function describeChecks(checks: ChecksFile | null): {
	summary: Record<string, number>;
	spot: number;
	capital: number;
	generatedAt: string;
	olderThanResolvedInput: boolean;
} | null {
	if (!checks) return null;
	return {
		summary: checks.summary,
		spot: checks.checks.filter((c) => c.group === "spot").length,
		capital: checks.checks.filter((c) => c.group === "capital").length,
		generatedAt: checks.generatedAt,
		olderThanResolvedInput: checks.dataset.olderThanResolvedInput,
	};
}
