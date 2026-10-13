/** A lookup at one point, shown in a popup on a marker there. */
import * as L from "leaflet";
import { getJson, type QueryResult } from "./api.ts";
import { escapeHtml } from "./dom.ts";
import { map, wrapLongitude } from "./map.ts";

let marker: L.Marker | null = null;

function fmtPlace(names: string[] | undefined): string {
	if (!names || names.length === 0)
		return '<span class="null-result">unknown</span>';
	return escapeHtml(names.join(" / "));
}

function buildTable(data: QueryResult, lat: number, lon: number): string {
	const rows = `
		<tr><th scope="row">Country</th><td>${fmtPlace(data.country?.names)}</td></tr>
		<tr><th scope="row">Region</th><td>${fmtPlace(data.region?.names)}</td></tr>
		<tr><th scope="row">City</th><td>${fmtPlace(data.city?.names)}</td></tr>`;
	const header = `<p>Location: ${lat.toFixed(6)}, ${lon.toFixed(6)} &middot; ${data.query_time_us.toFixed(1)}&micro;s<br>Place id: ${data.placeId ?? '<span class="null-result">none</span>'}</p>`;
	return `${header}<table class="result-table">${rows}</table>`;
}

export async function queryAndPopup(lat: number, lon: number): Promise<void> {
	const wrappedLon = wrapLongitude(lon);
	if (marker) map.removeLayer(marker);
	marker = L.marker([lat, wrappedLon]).addTo(map);
	const popup = L.popup({ minWidth: 240 })
		.setLatLng([lat, wrappedLon])
		.setContent('<div class="loading">Querying&hellip;</div>')
		.openOn(map);

	try {
		const data = await getJson<QueryResult>(
			`/api/query?lat=${lat}&lon=${wrappedLon}`,
		);
		popup.setContent(buildTable(data, lat, wrappedLon));
	} catch (e) {
		popup.setContent(
			`<div class="loading">Request failed: ${escapeHtml(String(e))}</div>`,
		);
	}
}
