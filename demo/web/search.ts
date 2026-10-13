/**
 * Place search, as an ARIA combobox
 * (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/): focus stays in the
 * input, the arrow keys move the highlighted option, Enter picks it and
 * Escape closes the list (or, when it's already closed, clears the input).
 */
import * as L from "leaflet";
import { getJson, type Located, type SearchResult } from "./api.ts";
import { closeControls } from "./controls.ts";
import { byId, escapeHtml } from "./dom.ts";
import { map } from "./map.ts";
import { queryAndPopup } from "./query.ts";

/** A "lat, lon" typed into the box, as a result of its own. */
interface CoordinatesResult {
	coordinates: true;
	lat: number;
	lon: number;
	names: [string];
}
type Result = (SearchResult & { coordinates?: never }) | CoordinatesResult;

const searchInput = byId<HTMLInputElement>("search-input");
const searchResultsEl = byId("search-results");
const searchStatusEl = byId("search-status");
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
// Bumped by every input change, so a slow response to an older query
// can't overwrite the results of a newer one.
let searchSeq = 0;
// The latest results, and the query they're for: reopening the list for
// the same query shows them again without asking the server. While the
// input holds anything else, the list on screen is out of date.
let results: Result[] = [];
let resultsFor: string | null = null;
// The query a search is waiting out its debounce or in flight for.
let loadingFor: string | null = null;
// Enter was pressed before the input's results came in: go to the first
// one once they do.
let pickWhenLoaded = false;
let activeIndex = -1;

function isOpen(): boolean {
	return searchInput.getAttribute("aria-expanded") === "true";
}

/** Announces `text` to screen readers, and with `visible` also shows it
 * under the input (searching, nothing found, failed). */
function setStatus(text: string, visible: boolean): void {
	searchStatusEl.textContent = text;
	searchStatusEl.className = visible
		? "search-message card"
		: "visually-hidden";
}

export function closeResults(): void {
	searchResultsEl.innerHTML = "";
	searchResultsEl.classList.remove("stale");
	searchInput.setAttribute("aria-expanded", "false");
	searchInput.removeAttribute("aria-activedescendant");
	activeIndex = -1;
	setStatus("", false);
}

function setActive(index: number): void {
	const items = searchResultsEl.querySelectorAll('[role="option"]');
	if (items.length === 0) return;
	activeIndex = (index + items.length) % items.length;
	for (const [i, el] of items.entries()) {
		el.setAttribute("aria-selected", String(i === activeIndex));
	}
	const active = items[activeIndex] as Element;
	searchInput.setAttribute("aria-activedescendant", active.id);
	active.scrollIntoView({ block: "nearest" });
}

function renderResults(): void {
	activeIndex = -1;
	searchInput.removeAttribute("aria-activedescendant");
	searchResultsEl.classList.remove("stale");
	if (!results.length) {
		closeResults();
		setStatus("No places found", true);
		return;
	}
	searchResultsEl.innerHTML = results
		.map((r, i) => {
			const meta = r.coordinates
				? "Coordinates"
				: [
						r.level !== "city" ? null : (r.region?.join(" / ") ?? null),
						r.country.join(" / "),
					]
						.filter(Boolean)
						.join(", ");
			return `<div class="search-result-item" role="option" id="search-result-${i}" aria-selected="false" data-index="${i}">
				<div class="search-result-name">${escapeHtml(r.names.join(" / "))}</div>
				${meta ? `<div class="search-result-meta">${escapeHtml(meta)}</div>` : ""}
			</div>`;
		})
		.join("");
	searchInput.setAttribute("aria-expanded", "true");
	setStatus(
		`${results.length} place${results.length === 1 ? "" : "s"} found`,
		false,
	);
}

/** Makes `list` the results for `q`: goes to the first one if Enter is
 * waiting for them, else shows them (once the input has focus, if it has
 * gone). */
function showResults(q: string, list: Result[]): void {
	results = list;
	resultsFor = q;
	loadingFor = null;
	if (pickWhenLoaded) {
		pickWhenLoaded = false;
		if (results.length) {
			pick(0);
			return;
		}
	}
	if (document.activeElement === searchInput) renderResults();
}

/** A "lat, lon" (or "lat lon") query as a result of its own, which goes
 * to that point; null for anything else. */
function coordinatesResult(q: string): CoordinatesResult | null {
	const num = String.raw`([-+]?(?:\d+(?:\.\d*)?|\.\d+))`;
	const match = new RegExp(String.raw`^${num}\s*(?:,|\s)\s*${num}$`).exec(q);
	if (!match) return null;
	const lat = Number(match[1]);
	const lon = Number(match[2]);
	if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
	return { coordinates: true, lat, lon, names: [`${lat}, ${lon}`] };
}

async function doSearch(q: string): Promise<void> {
	if (searchTimeout !== null) clearTimeout(searchTimeout);
	searchTimeout = null;
	loadingFor = q;
	const seq = searchSeq;
	try {
		const data = await getJson<{ results?: SearchResult[] }>(
			`/api/search?q=${encodeURIComponent(q)}`,
		);
		if (seq !== searchSeq) return;
		showResults(q, data.results ?? []);
	} catch (e) {
		if (seq !== searchSeq) return;
		loadingFor = null;
		pickWhenLoaded = false;
		closeResults();
		if (document.activeElement === searchInput) {
			setStatus(`Search failed: ${(e as Error).message}`, true);
		}
	}
}

/** Shows the results for what's in the input, if the list isn't already
 * showing them: e.g. when the input gets focus again after picking a
 * result or clicking the map. */
function reopenResults(): void {
	const q = searchInput.value.trim();
	if (!q || isOpen()) return;
	if (q === resultsFor) {
		renderResults();
	} else if (q === loadingFor) {
		setStatus("Searching…", true);
	} else {
		setStatus("Searching…", true);
		doSearch(q);
	}
}

function pick(index: number): void {
	const r = results[index];
	closeResults();
	if (r) goToPlace(r);
}

/** The zoom that fits a place of `area` square degrees (locate()'s
 * estimate, everything under the place included) around (lat, lon), or
 * the current zoom when its area is unknown. */
function zoomForArea(lat: number, lon: number, area: number): number {
	if (!(area > 0)) return map.getZoom();
	// Taken as a square on the ground: in degrees, wider than tall by
	// 1 / cos(lat). The located point is inside the place but not
	// necessarily its middle, hence the margin.
	const side = Math.sqrt(area) * 1.5;
	const squash = Math.sqrt(Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
	const bounds = L.latLngBounds(
		[lat - (side * squash) / 2, lon - side / squash / 2],
		[lat + (side * squash) / 2, lon + side / squash / 2],
	);
	return Math.max(2, Math.min(map.getBoundsZoom(bounds), 16));
}

async function goToPlace(place: Result): Promise<void> {
	if (place.coordinates) {
		map.setView([place.lat, place.lon], map.getZoom());
		queryAndPopup(place.lat, place.lon);
		return;
	}
	try {
		const resp = await fetch(`/api/locate?id=${place.id}`);
		if (resp.status === 404) {
			// Smaller than the dataset's finest cell: found by name, but
			// every cell went to a neighbour.
			setStatus(`${place.names[0]} has no location in this dataset`, true);
			return;
		}
		const data = (await resp.json()) as Located & { error?: string };
		if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
		map.setView(
			[data.lat, data.lon],
			zoomForArea(data.lat, data.lon, data.area),
		);
		queryAndPopup(data.lat, data.lon);
	} catch (e) {
		setStatus(
			`Locating ${place.names[0]} failed: ${(e as Error).message}`,
			true,
		);
	}
}

searchInput.addEventListener("input", () => {
	if (searchTimeout !== null) clearTimeout(searchTimeout);
	searchTimeout = null;
	searchSeq++;
	loadingFor = null;
	pickWhenLoaded = false;
	const q = searchInput.value.trim();
	if (!q) {
		closeResults();
		return;
	}
	if (q === resultsFor) {
		renderResults();
		return;
	}
	const point = coordinatesResult(q);
	if (point) {
		showResults(q, [point]);
		return;
	}
	// Until the new results come in, the list shows the old query's.
	searchResultsEl.classList.add("stale");
	setStatus("Searching…", true);
	loadingFor = q;
	searchTimeout = setTimeout(() => doSearch(q), 250);
});

searchInput.addEventListener("focus", () => {
	// Where the controls open over the map, the list would open over them.
	closeControls();
	reopenResults();
});
searchInput.addEventListener("click", reopenResults);
searchInput.addEventListener("blur", () => {
	pickWhenLoaded = false;
	closeResults();
});

searchInput.addEventListener("keydown", (e) => {
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		if (!isOpen()) {
			reopenResults();
			return;
		}
		setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
	} else if (e.key === "Enter") {
		const q = searchInput.value.trim();
		if (!q) return;
		e.preventDefault();
		if (q === resultsFor) {
			// Nothing found picks nothing.
			if (results.length)
				pick(isOpen() && activeIndex !== -1 ? activeIndex : 0);
			return;
		}
		// The list on screen (if any) is an older query's: wait for this
		// one's, without the rest of the debounce.
		pickWhenLoaded = true;
		if (searchTimeout !== null || q !== loadingFor) {
			setStatus("Searching…", true);
			doSearch(q);
		}
	} else if (e.key === "Escape") {
		// Handled here, not by the controls panel's own Escape.
		e.stopPropagation();
		if (isOpen()) {
			closeResults();
		} else {
			searchSeq++;
			if (searchTimeout !== null) clearTimeout(searchTimeout);
			searchTimeout = null;
			loadingFor = null;
			pickWhenLoaded = false;
			searchInput.value = "";
			closeResults();
		}
	}
});

// mousedown would blur the input (closing the list) before the click
// lands; keep focus in the input instead.
searchResultsEl.addEventListener("mousedown", (e) => e.preventDefault());
searchResultsEl.addEventListener("click", (e) => {
	const item = (e.target as Element).closest<HTMLElement>('[role="option"]');
	if (item) pick(Number(item.dataset.index));
});
