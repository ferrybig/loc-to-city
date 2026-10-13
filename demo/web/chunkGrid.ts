/**
 * The file's chunk grid (Section 6.1 of the format), and on each chunk big
 * enough on screen, its compressed size and index. The grid comes from
 * /api/about; the sizes, one per chunk, are only fetched once the grid is
 * turned on.
 */
import * as L from "leaflet";
import { type ChunkGrid, getJson } from "./api.ts";
import { byId } from "./dom.ts";
import { fmtBytes } from "./format.ts";
import { map } from "./map.ts";

const toggle = byId<HTMLInputElement>("chunk-grid-toggle");
const gridLayer = L.layerGroup();
const labelLayer = L.layerGroup().addTo(gridLayer);
let grid: ChunkGrid | null = null;
let lengths: number[] | null = null;
let lengthsLoading: Promise<void> | null = null;
// Smallest on-screen chunk a label fits in, in pixels.
const LABEL_SIZE = { x: 72, y: 32 };

export function setupChunkGrid(chunkGrid: ChunkGrid): void {
	grid = chunkGrid;
	const { width, height } = chunkGrid;
	const lines: L.LatLngExpression[][] = [];
	for (let c = 0; c <= width; c++) {
		const lon = -180 + (c * 360) / width;
		lines.push([
			[-90, lon],
			[90, lon],
		]);
	}
	for (let r = 0; r <= height; r++) {
		const lat = -90 + (r * 180) / height;
		lines.push([
			[lat, -180],
			[lat, 180],
		]);
	}
	L.polyline(lines, {
		color: "#a61e4d",
		weight: 1,
		opacity: 0.7,
		interactive: false,
	}).addTo(gridLayer);
	toggle.disabled = false;
	// A box the browser kept checked across a reload was handled before
	// the grid was known, with nothing to label yet.
	renderLabels();
}

function loadLengths(): Promise<void> {
	lengthsLoading ??= (async () => {
		lengths = (await getJson<{ lengths: number[] }>("/api/chunk-sizes"))
			.lengths;
	})();
	return lengthsLoading;
}

/** Labels the non-empty chunks in view that are big enough on screen to
 * hold one. */
function renderLabels(): void {
	labelLayer.clearLayers();
	if (!grid || !lengths || !map.hasLayer(gridLayer)) return;
	const { width, height } = grid;
	const lonStep = 360 / width;
	const latStep = 180 / height;
	const x0 = map.project([0, 0]).x;
	if (map.project([0, lonStep]).x - x0 < LABEL_SIZE.x / 2) return;
	const bounds = map.getBounds();
	const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
	const c0 = clamp(Math.floor((bounds.getWest() + 180) / lonStep), width - 1);
	const c1 = clamp(Math.floor((bounds.getEast() + 180) / lonStep), width - 1);
	const r0 = clamp(Math.floor((bounds.getSouth() + 90) / latStep), height - 1);
	const r1 = clamp(Math.floor((bounds.getNorth() + 90) / latStep), height - 1);
	for (let r = r0; r <= r1; r++) {
		const south = -90 + r * latStep;
		const rowHeight =
			map.project([south, 0]).y - map.project([south + latStep, 0]).y;
		if (rowHeight < LABEL_SIZE.y / 2) continue;
		for (let c = c0; c <= c1; c++) {
			const index = r * width + c;
			const bytes = lengths[index];
			if (!bytes) continue;
			L.marker([south + latStep / 2, -180 + (c + 0.5) * lonStep], {
				interactive: false,
				keyboard: false,
				icon: L.divIcon({
					className: "chunk-label",
					iconSize: [LABEL_SIZE.x, LABEL_SIZE.y],
					html: `<b>${fmtBytes(bytes)}</b><span>#${index}</span>`,
				}),
			}).addTo(labelLayer);
		}
	}
}

async function onToggle(): Promise<void> {
	if (!toggle.checked) {
		map.removeLayer(gridLayer);
		return;
	}
	gridLayer.addTo(map);
	try {
		await loadLengths();
	} catch (_) {
		lengthsLoading = null;
	}
	renderLabels();
}
toggle.addEventListener("change", onToggle);
onToggle();
map.on("moveend", renderLabels);
