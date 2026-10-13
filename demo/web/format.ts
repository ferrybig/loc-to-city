import { escapeHtml } from "./dom.ts";

export function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A length in metres as "305 m" or "2.4 km". */
export function fmtLength(metres: number): string {
	if (metres < 1000) return `${Math.round(metres)} m`;
	if (metres < 100_000) return `${(metres / 1000).toPrecision(2)} km`;
	return `${Math.round(metres / 1000)} km`;
}

/** The finest cell's size at the equator, where a degree of longitude is
 * widest. */
export function fmtCellSize({
	lon,
	lat,
}: {
	lon: number;
	lat: number;
}): string {
	const METRES_PER_DEGREE = 111_195;
	return `${fmtLength(lon * METRES_PER_DEGREE)} × ${fmtLength(lat * METRES_PER_DEGREE)}`;
}

/** The file's attribution notice as HTML, whose `[text](url)` links
 * become real ones. */
export function fmtAttribution(text: string): string {
	return escapeHtml(text).replace(
		/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
		'<a href="$2">$1</a>',
	);
}
