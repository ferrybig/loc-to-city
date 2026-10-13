/**
 * Places the country notes (countries.md) have an opinion about, looked up
 * when the dataset was built: what each should resolve to, and whether it
 * does. Only offered when the server has them for this dataset (/api/about
 * says so).
 */
import * as L from "leaflet";
import { type CheckEntry, type ChecksSummary, getJson } from "./api.ts";
import { byId, escapeHtml } from "./dom.ts";
import { map } from "./map.ts";
import { queryAndPopup } from "./query.ts";

interface Outcome {
	glyph: string;
	color: string;
	label: string;
}

const OUTCOMES: Record<string, Outcome> = {
	verified: { glyph: "✓", color: "#1a7f37", label: "Verified correct" },
	regression: {
		glyph: "!",
		color: "#cf222e",
		label: "Regression: should be right, is not",
	},
	open: { glyph: "✗", color: "#bc4c00", label: "Known wrong, fixable" },
	"known-wrong": {
		glyph: "⊘",
		color: "#57606a",
		label: "Known wrong, not fixable",
	},
	"report-upstream": {
		glyph: "⚑",
		color: "#8250df",
		label: "Source data is wrong: report upstream",
	},
	"now-passing": {
		glyph: "★",
		color: "#0969da",
		label: "Now correct: close the note",
	},
};
// Above the rest, the more there is to do about it.
const OUTCOME_RANK = [
	"verified",
	"known-wrong",
	"now-passing",
	"open",
	"report-upstream",
	"regression",
];

type Group = CheckEntry["group"];

const toggles: Record<Group, HTMLInputElement> = {
	spot: byId("checks-spot-toggle"),
	capital: byId("checks-capital-toggle"),
};
const layers: Record<Group, L.LayerGroup> = {
	spot: L.layerGroup(),
	capital: L.layerGroup(),
};
let entries: CheckEntry[] | null = null;
let loading: Promise<void> | null = null;

function outcomeOf(check: CheckEntry): Outcome {
	return OUTCOMES[check.outcome] ?? (OUTCOMES.open as Outcome);
}

function fmtActual(actual: CheckEntry["actual"]): string {
	return (["country", "region", "city"] as const)
		.map((tier) => actual[tier]?.[0] ?? "-")
		.join(" / ");
}

function buildPopup(check: CheckEntry): HTMLElement {
	const o = outcomeOf(check);
	const el = document.createElement("div");
	el.className = "check-popup";
	el.innerHTML = `
		<strong>${escapeHtml(check.name)}</strong>
		<div class="check-badge" style="color:${o.color}">${o.glyph} ${escapeHtml(o.label)}</div>
		<table class="result-table">
			<tr><th scope="row">Expected</th><td>${escapeHtml(check.expected)}</td></tr>
			<tr><th scope="row">Got</th><td>${escapeHtml(fmtActual(check.actual))}</td></tr>
		</table>
		<p>Country notes: ${escapeHtml(check.section)}</p>
		<button type="button">Query this point</button>`;
	el.querySelector("button")?.addEventListener("click", () => {
		queryAndPopup(check.lat, check.lon);
	});
	return el;
}

function checkMarker(check: CheckEntry, renderer: L.Renderer): L.Layer {
	const o = outcomeOf(check);
	const title = `${check.name}: ${o.label}`;
	if (check.group === "capital") {
		return L.circleMarker([check.lat, check.lon], {
			renderer,
			radius: 5,
			weight: 1.5,
			color: "#fff",
			fillColor: o.color,
			fillOpacity: 1,
		}).bindTooltip(escapeHtml(title));
	}
	return L.marker([check.lat, check.lon], {
		title,
		zIndexOffset: OUTCOME_RANK.indexOf(check.outcome) * 100,
		icon: L.divIcon({
			className: "",
			iconSize: [22, 22],
			html: `<span class="check-pin" style="background:${o.color}" aria-hidden="true">${o.glyph}</span>`,
		}),
	});
}

/** The outcomes of the markers on the map, most to do about first. */
function renderLegend(): void {
	const counts: Record<string, number> = {};
	for (const check of entries ?? []) {
		if (toggles[check.group].checked) {
			counts[check.outcome] = (counts[check.outcome] ?? 0) + 1;
		}
	}
	byId("check-legend").innerHTML = OUTCOME_RANK.toReversed()
		.filter((key) => counts[key])
		.map((key) => {
			const o = OUTCOMES[key] as Outcome;
			return `<li><span class="check-key" style="background:${o.color}" aria-hidden="true">${o.glyph}</span><span>${escapeHtml(o.label)}</span><span class="count">${counts[key]}</span></li>`;
		})
		.join("");
}

function syncLayers(): void {
	for (const group of Object.keys(layers) as Group[]) {
		if (toggles[group].checked) layers[group].addTo(map);
		else map.removeLayer(layers[group]);
	}
	renderLegend();
}

function load(): Promise<void> {
	loading ??= (async () => {
		entries = (await getJson<{ checks: CheckEntry[] }>("/api/checks")).checks;
		const renderer = L.canvas({ padding: 0.5 });
		for (const check of entries) {
			checkMarker(check, renderer)
				.bindPopup(() => buildPopup(check))
				.addTo(layers[check.group]);
		}
	})();
	return loading;
}

async function onToggle(): Promise<void> {
	try {
		await load();
	} catch (_) {
		loading = null;
		for (const toggle of Object.values(toggles)) toggle.checked = false;
	}
	syncLayers();
}

export function setupChecks(summary: ChecksSummary): void {
	byId("checks-spot-count").textContent = String(summary.spot);
	byId("checks-capital-count").textContent = String(summary.capital);
	byId("checks-date").textContent = `, on ${summary.generatedAt.slice(0, 10)}`;
	byId("checks-stale").hidden = !summary.olderThanResolvedInput;
	for (const [group, toggle] of Object.entries(toggles) as [
		Group,
		HTMLInputElement,
	][]) {
		toggle.addEventListener("change", onToggle);
		// A dataset that covers part of the world may have none of a group.
		if (summary[group] === 0) {
			toggle.checked = false;
			(toggle.closest(".row") as HTMLElement).hidden = true;
		}
	}
	byId("checks-layers").hidden = false;
	onToggle();
}
