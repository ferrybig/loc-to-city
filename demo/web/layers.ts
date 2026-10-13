/** The base map and the grid overlay, switched on and off from the
 * controls panel. */
import * as L from "leaflet";
import { byId, readSetting, writeSetting } from "./dom.ts";
import { map, Z_BASE_MAP, Z_GRID_OVERLAY } from "./map.ts";

// ---- base map ----
// OpenStreetMap's own tiles, on unless switched off. The choice is
// remembered, and the e2e tests start with it off (playwright.config.ts)
// so a cacheless browser doesn't fetch from OSM's tile servers.
const baseMapToggle = byId<HTMLInputElement>("basemap-toggle");
const baseMap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
	maxZoom: 24,
	maxNativeZoom: 19,
	zIndex: Z_BASE_MAP,
	attribution:
		'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});

function syncBaseMap(): void {
	if (baseMapToggle.checked) baseMap.addTo(map);
	else map.removeLayer(baseMap);
}

baseMapToggle.checked = readSetting("basemap") !== "off";
baseMapToggle.addEventListener("change", () => {
	writeSetting("basemap", baseMapToggle.checked ? "on" : "off");
	syncBaseMap();
});
syncBaseMap();

// ---- grid overlay ----
// The server picks each tile's sampling resolution from its zoom level.
// The dataset's attribution is the map's own (dataset.ts), not this
// layer's: lookups show its data with the overlay off too.
const overlayToggle = byId<HTMLInputElement>("overlay-toggle");
const opacityRange = byId<HTMLInputElement>("opacity-range");
const opacityValue = byId<HTMLOutputElement>("opacity-value");
const overlay = L.tileLayer("/tiles/{z}/{x}/{y}.png", {
	tileSize: 256,
	zIndex: Z_GRID_OVERLAY,
	minZoom: 4,
	maxZoom: 24,
});

function syncOverlay(): void {
	opacityRange.disabled = !overlayToggle.checked;
	if (overlayToggle.checked) overlay.addTo(map);
	else map.removeLayer(overlay);
}

function syncOpacity(): void {
	opacityValue.value = `${opacityRange.value}%`;
	overlay.setOpacity(Number(opacityRange.value) / 100);
}

overlayToggle.addEventListener("change", syncOverlay);
opacityRange.addEventListener("input", syncOpacity);
syncOpacity();
syncOverlay();
