/** What /api/about says about the dataset: its attribution (in the map's
 * own attribution control), cell size, downloads and docs, and whether it
 * has a chunk grid and spot checks to offer. */
import type { About } from "./api.ts";
import { getJson } from "./api.ts";
import { setupChunkGrid } from "./chunkGrid.ts";
import { byId, escapeHtml } from "./dom.ts";
import { fmtAttribution, fmtBytes, fmtCellSize } from "./format.ts";
import { map } from "./map.ts";
import { setupChecks } from "./spotChecks.ts";

async function loadAbout(): Promise<void> {
	const about = await getJson<About>("/api/about");
	if (about.attribution) {
		map.attributionControl.addAttribution(fmtAttribution(about.attribution));
	}
	if (about.docs) {
		const docsLink = byId("docs-link");
		docsLink.querySelector("a")?.setAttribute("href", about.docs);
		docsLink.hidden = false;
	}
	byId("download-list").innerHTML = about.downloads
		.map(
			(d) => `<li>
				<a href="${escapeHtml(d.url)}" download>${escapeHtml(d.name)}</a>
				<span class="count">${fmtBytes(d.bytes)}</span>
				<span class="description">${escapeHtml(d.description)}</span>
			</li>`,
		)
		.join("");
	byId("data-precision").textContent =
		`Cell size: ${fmtCellSize(about.cellDegrees)}`;
	byId("dataset").hidden = false;
	if (about.chunkGrid) setupChunkGrid(about.chunkGrid);
	if (about.checks) setupChecks(about.checks);
}

export function initDataset(): void {
	loadAbout().catch(() => {});
}
