/** The Leaflet map every other module draws on. */
import * as L from "leaflet";
import iconUrl from "leaflet/dist/images/marker-icon.png";
import iconRetinaUrl from "leaflet/dist/images/marker-icon-2x.png";
import shadowUrl from "leaflet/dist/images/marker-shadow.png";
import { DEFAULT_VIEW, keepViewInHash, parseViewHash } from "./viewHash.ts";

// Leaflet finds its marker images next to leaflet.css, from that file's
// own URL, which the bundle renames: point it at the bundled images.
L.Icon.Default.imagePath = "";
L.Icon.Default.mergeOptions({ iconUrl, iconRetinaUrl, shadowUrl });

export const map = L.map("map", { zoomControl: false });
// Exposed for e2e tests, which drive the map via setView + a center click.
(window as unknown as { map: L.Map }).map = map;
{
	const { lat, lon, zoom } = parseViewHash(location.hash) ?? DEFAULT_VIEW;
	map.setView([lat, lon], zoom);
}
keepViewInHash(map);

L.control.zoom({ position: "bottomright" }).addTo(map);

// The tile layers' stacking order, whatever order they're switched on in:
// Leaflet otherwise puts the last one added on top. (The chunk grid is
// vector lines and markers, in panes above every tile layer.)
export const Z_BASE_MAP = 1;
export const Z_GRID_OVERLAY = 2;

export function wrapLongitude(lon: number): number {
	// Leaflet lets the map pan across multiple world copies, so a click far
	// from the seam can report a raw lng outside [-180, 180) -- wrap it back
	// onto the one copy the backend understands.
	return ((((lon + 180) % 360) + 360) % 360) - 180;
}
