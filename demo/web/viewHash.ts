/**
 * The view in the URL, as openstreetmap.org writes it, `#map=zoom/lat/lon`,
 * so a URL can be shared. Kept current with replaceState, so moving the map
 * adds no history entries, a second after the map stops moving: Safari
 * throws past 100 replaceState calls in 30 seconds.
 */
import type * as L from "leaflet";

export interface View {
	zoom: number;
	lat: number;
	lon: number;
}

export const DEFAULT_VIEW: View = { zoom: 10, lat: 52.05, lon: 4.3 };
const VIEW_HASH_DELAY_MS = 1000;

/** The view a `#map=zoom/lat/lon` hash names, or null. */
export function parseViewHash(hash: string): View | null {
	const match = /^#map=([^/]+)\/([^/]+)\/([^/]+)$/.exec(hash);
	if (!match) return null;
	const [zoom, lat, lon] = match.slice(1).map(Number) as [
		number,
		number,
		number,
	];
	if (![zoom, lat, lon].every(Number.isFinite)) return null;
	if (zoom < 0 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	return { zoom, lat, lon };
}

/** The map's current view as a hash, with enough decimals to place its
 * centre to about a pixel. */
function viewHash(map: L.Map): string {
	const zoom = map.getZoom();
	const { lat, lng } = map.getCenter().wrap();
	const digits = Math.max(0, Math.ceil(Math.log2(zoom)));
	return `#map=${zoom}/${lat.toFixed(digits)}/${lng.toFixed(digits)}`;
}

/** Writes `map`'s view to the URL as it moves, and moves it when the hash
 * is edited by hand (or reached with Back, after one was). */
export function keepViewInHash(map: L.Map): void {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	map.on("moveend", () => {
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			const hash = viewHash(map);
			if (hash !== location.hash) {
				history.replaceState(history.state, "", hash);
			}
		}, VIEW_HASH_DELAY_MS);
	});
	window.addEventListener("hashchange", () => {
		const view = parseViewHash(location.hash);
		if (view) map.setView([view.lat, view.lon], view.zoom);
	});
}
